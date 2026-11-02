use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewWindow};

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub struct Diagnostics {
    root: PathBuf,
    session: String,
    inner: Mutex<LogState>,
}
#[derive(Default)]
struct LogState {
    error: bool,
    last: String,
    count: u64,
    first: u64,
    latest: u64,
}
const EVENTS: &[&str] = &[
    "startup",
    "exit",
    "window_open",
    "window_close",
    "pet_state",
    "home_stage",
    "behavior_wait",
    "input_status",
    "native_error",
    "frontend_error",
    "config_saved",
    "config_imported",
    "model_switch",
    "request_start",
    "request_first",
    "request_complete",
    "request_failed",
    "request_cancelled",
    "export",
    "tool_start",
    "tool_result",
];
const STATES: &[&str] = &[
    "BOOTING",
    "IDLE",
    "WALK",
    "LOOK",
    "HAPPY",
    "DRAG",
    "FALL",
    "LAND",
    "GO_HOME",
    "REST",
    "LEAVE_HOME",
    "APPROACH",
    "JUMP",
    "LANDING",
    "AWAKE",
    "SLEEP",
    "main",
    "home",
    "chat",
    "settings",
    "diagnostics",
    "NONE",
    "FADE_OUT",
    "FADE_IN",
    "MAIN_FADE_OUT",
    "MAIN_HIDE",
    "MAIN_SHOW_NO_ACTIVATE",
    "MAIN_FADE_IN",
];
pub fn safe_event(event: &str, data: &Value) -> Option<Value> {
    if !EVENTS.contains(&event) {
        return None;
    }
    let mut out = json!({"event":event});
    // These payloads are fixed diagnostic vocabulary, never native error text,
    // window labels, input contents, coordinates, or a behavior policy in Rust.
    let fields: &[(&str, &[&str])] = match event {
        "behavior_wait" => &[
            (
                "home_stage",
                &[
                    "NONE",
                    "APPROACH",
                    "JUMP",
                    "LAND",
                    "HOME_IDLE",
                    "AWAKE",
                    "SLEEP",
                    "WAKE_HOLD",
                    "LEAVE_JUMP",
                ],
            ),
            (
                "wait_reason",
                &[
                    "none",
                    "initializing",
                    "runtime_failed",
                    "restoring",
                    "restore_failed",
                    "interaction",
                    "pointer_nearby",
                    "user_paused",
                    "input_unknown",
                    "input_blocked",
                    "home_awake_window",
                    "home_quiet_window",
                    "home_motion_unconfirmed",
                    "home_action_finishing",
                    "home_sleep",
                    "home_wake_hold",
                    "autonomous_interval",
                ],
            ),
        ],
        "input_status" => &[
            (
                "input_status",
                &["accepted", "unavailable", "rejected", "busy"],
            ),
            (
                "input_kind",
                &[
                    "none",
                    "dynamic-line",
                    "system-caret",
                    "text-focus-only",
                    "error",
                    "unknown",
                ],
            ),
            (
                "input_code",
                &[
                    "ok",
                    "unknown",
                    "runtime-disabled",
                    "worker-spawn",
                    "worker-stalled",
                    "worker-disconnected",
                    "worker-timeout",
                    "uia-initialization",
                    "uia-failure",
                    "task-join-failure",
                    "desktop-unavailable",
                    "request-failed",
                    "request-mismatch",
                    "stale-response",
                    "monitor-changed",
                    "worker-busy",
                    "geometry-unavailable",
                ],
            ),
        ],
        _ => &[],
    };
    for (key, values) in fields {
        if let Some(value) = data[*key].as_str().filter(|value| values.contains(value)) {
            out[*key] = json!(value);
        }
    }
    if event == "input_status" && data["input_code"] == "request-mismatch" {
        if let Some(reason) = data["identity_mismatch"].as_str().filter(|reason| {
            [
                "timestamp",
                "request-revision",
                "monitor-revision",
                "dispose-generation",
                "superseded-request",
                "superseded-monitor",
                "multiple",
            ]
            .contains(reason)
        }) {
            out["identity_mismatch"] = json!(reason);
        }
    }
    let flags: &[&str] = match event {
        "behavior_wait" => &["paused", "home_pending", "input_unknown", "input_blocked"],
        "input_status" => &["approximate"],
        _ => &[],
    };
    for key in flags {
        if let Some(value) = data[*key].as_bool() {
            out[*key] = json!(value);
        }
    }
    if matches!(
        data["tool"].as_str(),
        Some("search_web" | "read_page" | "get_weather")
    ) {
        out["tool"] = data["tool"].clone();
    }
    for key in ["state", "surface"] {
        if let Some(s) = data[key].as_str() {
            if STATES.contains(&s) {
                out[key] = json!(s);
            }
        }
    }
    for key in ["elapsed_ms", "status", "count"] {
        if let Some(n) = data[key].as_u64() {
            out[key] = json!(n);
        }
    }
    // IDs are generated locally, never user supplied labels, URLs or exception text.
    for key in ["request_id", "config_id"] {
        if let Some(s) = data[key].as_str() {
            if s.len() <= 50
                && s.starts_with("ld-")
                && s[3..].chars().all(|c| c.is_ascii_digit() || c == '-')
            {
                out[key] = json!(s);
            }
        }
    }
    let codes = [
        "connection",
        "authentication",
        "model_missing",
        "rate_limit",
        "server",
        "upstream_tls",
        "timeout",
        "response",
        "cancelled",
        "context",
        "config",
        "storage",
        "unknown",
        "location_missing",
        "location_not_found",
        "location_ambiguous",
        "location_denied",
        "location_unavailable",
        "location_config",
        "weather_connection",
        "weather_timeout",
        "weather_limit",
        "weather_server",
        "weather_response",
        "weather_stale",
        "search_key",
        "search_empty",
        "search_authentication",
        "search_limit",
        "search_timeout",
        "search_connection",
        "search_server",
        "extract_failed",
        "unsafe_url",
        "unknown_tool",
        "unknown_source",
        "tool_arguments",
        "tool_budget",
    ];
    if let Some(s) = data["code"].as_str() {
        if codes.contains(&s) {
            out["code"] = json!(s);
        }
    }
    Some(out)
}
impl Diagnostics {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            session: format!("ld-{}", now()),
            inner: Mutex::new(LogState::default()),
        }
    }
    fn write(&self, record: &Value) -> std::io::Result<()> {
        fs::create_dir_all(&self.root)?;
        let current = self.root.join("diagnostic-0.jsonl");
        let bytes = serde_json::to_vec(record)?;
        if fs::metadata(&current).map(|m| m.len()).unwrap_or(0) + bytes.len() as u64 + 1
            > 2 * 1024 * 1024
        {
            let oldest = self.root.join("diagnostic-4.jsonl");
            if oldest.exists() {
                fs::remove_file(oldest)?;
            }
            for i in (0..4).rev() {
                let from = self.root.join(format!("diagnostic-{i}.jsonl"));
                if from.exists() {
                    fs::rename(from, self.root.join(format!("diagnostic-{}.jsonl", i + 1)))?;
                }
            }
        }
        let mut file = OpenOptions::new().create(true).append(true).open(current)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")
    }
    fn flush_repeat(&self, state: &mut LogState) {
        if state.count > 0 {
            let row = json!({"event":"native_error","code":"unknown","count":state.count,"utc_ms":state.latest,"first_utc_ms":state.first,"session":self.session,"version":env!("CARGO_PKG_VERSION"),"level":"error"});
            state.error |= self.write(&row).is_err();
            state.count = 0;
        }
    }
    pub fn record(&self, event: &str, data: Value) {
        let Some(mut row) = safe_event(event, &data) else {
            return;
        };
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        let key = row.to_string();
        let time = now();
        if event.ends_with("error") && state.last == key && time.saturating_sub(state.first) < 5000
        {
            state.count += 1;
            state.latest = time;
            return;
        }
        self.flush_repeat(&mut state);
        state.last = key;
        state.first = time;
        row["utc_ms"] = json!(time);
        row["session"] = json!(self.session);
        row["version"] = json!(env!("CARGO_PKG_VERSION"));
        row["level"] = json!(if event.ends_with("error") || event.ends_with("failed") {
            "error"
        } else {
            "info"
        });
        state.error |= self.write(&row).is_err();
    }
    pub fn snapshot(&self) -> Value {
        let mut state = self.inner.lock().unwrap();
        self.flush_repeat(&mut state);
        let mut rows = Vec::new();
        let mut truncated = false;
        for i in (0..5).rev() {
            if let Ok(bytes) = fs::read(self.root.join(format!("diagnostic-{i}.jsonl"))) {
                if bytes.len() > 2 * 1024 * 1024 {
                    truncated = true;
                    continue;
                }
                for line in String::from_utf8_lossy(&bytes).lines() {
                    if let Ok(raw) = serde_json::from_str::<Value>(line) {
                        if let Some(mut row) = safe_event(raw["event"].as_str().unwrap_or(""), &raw)
                        {
                            for field in ["utc_ms", "first_utc_ms"] {
                                if raw[field].is_u64() {
                                    row[field] = raw[field].clone();
                                }
                            }
                            if let Some(v) = raw["version"].as_str().filter(|s| {
                                s.len() <= 20 && s.chars().all(|c| c.is_ascii_digit() || c == '.')
                            }) {
                                row["version"] = json!(v);
                            }
                            if let Some(v) = raw["session"].as_str().filter(|s| {
                                s.len() <= 50
                                    && s.starts_with("ld-")
                                    && s[3..].chars().all(|c| c.is_ascii_digit() || c == '-')
                            }) {
                                row["session"] = json!(v);
                            }
                            row["level"] = json!(if raw["event"]
                                .as_str()
                                .is_some_and(|e| e.ends_with("error") || e.ends_with("failed"))
                            {
                                "error"
                            } else {
                                "info"
                            });
                            rows.push(row);
                        }
                    }
                }
            }
        }
        let mut current = json!({});
        for row in &rows {
            if row["session"] == self.session {
                if row["event"] == "pet_state" {
                    current["pet"] = row["state"].clone();
                }
                if row["event"] == "home_stage" {
                    current["home"] = row["state"].clone();
                }
                for event in ["behavior_wait", "input_status"] {
                    if row["event"] == event {
                        current[event] = row.clone();
                    }
                }
            }
        }
        json!({"version":env!("CARGO_PKG_VERSION"),"exported_utc_ms":now(),"os":std::env::consts::OS,"os_version":os_version(),"current_state":current,"session":self.session,"logging_available":!state.error,"truncated":truncated,"retention":"latest five files, 2 MiB each; earlier events may have rotated out","records":rows})
    }
    pub fn available(&self) -> bool {
        self.inner.lock().map(|s| !s.error).unwrap_or(false)
    }
}
fn os_version() -> Value {
    use windows::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOW};
    let mut v = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    if unsafe { GetVersionExW(&mut v) }.is_ok() {
        json!({"major":v.dwMajorVersion,"minor":v.dwMinorVersion,"build":v.dwBuildNumber})
    } else {
        Value::Null
    }
}
#[tauri::command]
pub fn diagnostic_event(
    window: WebviewWindow,
    app: tauri::AppHandle,
    event: String,
    data: Value,
) -> Result<(), &'static str> {
    if !["main", "home", "chat"].contains(&window.label()) {
        return Err("config");
    }
    app.state::<Diagnostics>().record(&event, data);
    Ok(())
}
#[tauri::command]
pub fn diagnostic_status(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<bool, &'static str> {
    if window.label() != "chat" {
        return Err("config");
    }
    Ok(app.state::<Diagnostics>().available())
}
#[tauri::command]
pub async fn diagnostic_export(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<bool, &'static str> {
    if window.label() != "chat" {
        return Err("config");
    }
    let owner = window.hwnd().map_err(|_| "storage")?.0 as isize;
    let path = tauri::async_runtime::spawn_blocking(move || save_dialog(owner))
        .await
        .map_err(|_| "storage")??;
    let Some(path) = path else { return Ok(false) };
    app.state::<Diagnostics>().record("export", json!({}));
    let snapshot = app.state::<Diagnostics>().snapshot();
    fs::write(
        path,
        serde_json::to_vec_pretty(&snapshot).map_err(|_| "storage")?,
    )
    .map_err(|_| "storage")?;
    Ok(true)
}
fn save_dialog(owner: isize) -> Result<Option<PathBuf>, &'static str> {
    report_dialog(owner, "diagnostics", "json")
}
pub(crate) fn report_dialog(
    owner: isize,
    label: &str,
    extension: &str,
) -> Result<Option<PathBuf>, &'static str> {
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{Foundation::HWND, UI::Controls::Dialogs::*},
    };
    let mut name = [0u16; 32768];
    let initial: Vec<u16> = format!("LineDog-{label}-{}.{extension}", now())
        .encode_utf16()
        .collect();
    name[..initial.len()].copy_from_slice(&initial);
    let filter: Vec<u16> = format!("报告文件\0*.{extension}\0\0")
        .encode_utf16()
        .collect();
    let ext: Vec<u16> = extension.encode_utf16().chain(Some(0)).collect();
    let mut ofn = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: HWND(owner as *mut _),
        lpstrFile: PWSTR(name.as_mut_ptr()),
        nMaxFile: name.len() as u32,
        lpstrFilter: PCWSTR(filter.as_ptr()),
        lpstrDefExt: PCWSTR(ext.as_ptr()),
        Flags: OFN_OVERWRITEPROMPT | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST,
        ..Default::default()
    };
    unsafe {
        if GetSaveFileNameW(&mut ofn).as_bool() {
            let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            Ok(Some(PathBuf::from(String::from_utf16_lossy(&name[..end]))))
        } else if CommDlgExtendedError().0 == 0 {
            Ok(None)
        } else {
            Err("storage")
        }
    }
}
