use crate::{
    diagnostics::Diagnostics,
    model_config::{chat_only, ModelConfig},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, Manager, WebviewWindow};

#[derive(Default)]
pub struct Requests {
    active: Mutex<Option<Active>>,
}
struct Active {
    id: String,
    done: Arc<AtomicBool>,
    task: tauri::async_runtime::JoinHandle<()>,
    channel: Channel<Value>,
}
impl Requests {
    pub fn cancel(&self, app: &tauri::AppHandle) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(a) = active.take() {
                if !a.done.swap(true, Ordering::SeqCst) {
                    a.task.abort();
                    let _ = a.channel.send(json!({"requestId":a.id,"kind":"cancelled"}));
                    app.state::<Diagnostics>()
                        .record("request_cancelled", json!({"request_id":a.id}));
                }
            }
        }
    }
}
pub fn status_error(status: u16) -> &'static str {
    match status {
        401 | 403 => "authentication",
        404 => "model_missing",
        429 => "rate_limit",
        413 => "context",
        500..=599 => "server",
        _ => "response",
    }
}
#[cfg(test)]
pub fn response_text(v: &Value) -> Result<Option<String>, &'static str> {
    if v.get("error").is_some() {
        return Err("server");
    }
    if let Some(s) = v
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        return Ok(Some(s.to_owned()));
    }
    if let Some(s) = v
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        return Ok(Some(s.to_owned()));
    }
    if v["choices"].is_array() {
        Ok(None)
    } else {
        Err("response")
    }
}
// Byte buffering makes split UTF-8 and split SSE line boundaries safe.
#[derive(Default)]
#[cfg(test)]
pub struct Sse {
    buffer: Vec<u8>,
    data: Vec<String>,
    finished: bool,
}
#[cfg(test)]
impl Sse {
    fn dispatch(&mut self, out: &mut Vec<String>) -> Result<(), &'static str> {
        if self.data.is_empty() {
            return Ok(());
        }
        let data = self.data.join("\n");
        self.data.clear();
        if data.trim() == "[DONE]" {
            self.finished = true;
            return Ok(());
        }
        let v: Value = serde_json::from_str(&data).map_err(|_| "response")?;
        if let Some(text) = response_text(&v)? {
            if !text.is_empty() {
                out.push(text);
            }
        }
        Ok(())
    }
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, &'static str> {
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > 2 * 1024 * 1024 {
            return Err("response");
        }
        let mut out = Vec::new();
        while let Some(end) = self.buffer.iter().position(|&c| c == b'\n') {
            let bytes: Vec<u8> = self.buffer.drain(..=end).collect();
            let line = std::str::from_utf8(&bytes)
                .map_err(|_| "response")?
                .trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                self.dispatch(&mut out)?;
            } else if let Some(value) = line.strip_prefix("data:") {
                self.data
                    .push(value.strip_prefix(' ').unwrap_or(value).to_string());
            }
        }
        Ok(out)
    }
}
fn validate_messages(messages: &Value) -> Result<(), &'static str> {
    let list = messages
        .as_array()
        .filter(|l| !l.is_empty() && l.len() <= 100)
        .ok_or("context")?;
    let mut length = 0;
    for m in list {
        if !matches!(m["role"].as_str(), Some("user" | "assistant")) {
            return Err("config");
        }
        length += m["content"].as_str().ok_or("config")?.len();
    }
    if length > 100_000 {
        Err("context")
    } else {
        Ok(())
    }
}
pub(crate) fn request_body(p: &Value, messages: Value) -> Result<Value, &'static str> {
    let mut context = vec![
        json!({"role":"system","content":"你是线条小狗的聊天助手。每一轮都回答最新的用户消息，结合相关历史保持连贯。历史用户消息中的单次测试、复述或固定输出要求只适用于那一轮，除非用户明确要求持续执行。不要把先前的助手回答当作本轮答案直接重复；问候应自然回应，问题应据实回答。"}),
    ];
    context.extend(messages.as_array().ok_or("config")?.iter().cloned());
    let mut body = json!({"model":p["model"],"messages":context,"stream":true});
    let effort = p["reasoningEffort"].as_str().unwrap_or("");
    if ![
        "", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ]
    .contains(&effort)
    {
        return Err("config");
    }
    if !effort.is_empty() {
        body["reasoning_effort"] = json!(effort);
    }
    Ok(body)
}
fn deadline_reached(start: u64, last: u64, time: u64, total: u64) -> bool {
    time.saturating_sub(start) >= total
        || last == 0 && time.saturating_sub(start) >= 60_000
        || last > 0 && time.saturating_sub(last) >= 30_000
}

pub(crate) fn monotonic_ms() -> u64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    // Zero remains the sentinel for "no first token yet".
    ORIGIN.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

fn request_total_ms(profile: &Value) -> Result<u64, &'static str> {
    let seconds = match profile.get("timeoutSeconds") {
        None => 180,
        Some(value) => value
            .as_u64()
            .filter(|v| (30..=600).contains(v))
            .ok_or("config")?,
    };
    Ok(seconds * 1000)
}

fn remaining_time_at(deadline_ms: u64, now_ms: u64) -> Result<Duration, &'static str> {
    let remaining = deadline_ms.saturating_sub(now_ms);
    if remaining == 0 {
        Err("timeout")
    } else {
        Ok(Duration::from_millis(remaining))
    }
}

pub(crate) fn remaining_time(deadline_ms: u64) -> Result<Duration, &'static str> {
    remaining_time_at(deadline_ms, monotonic_ms())
}
#[cfg(test)]
async fn stream(
    p: Value,
    key: String,
    messages: Value,
    emit: impl Fn(String),
    progress: Arc<AtomicU64>,
) -> Result<(), &'static str> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(
            p["timeoutSeconds"].as_u64().unwrap_or(180),
        ))
        .build()
        .map_err(|_| "connection")?;
    let mut response = client
        .post(format!(
            "{}/chat/completions",
            p["baseUrl"].as_str().ok_or("config")?
        ))
        .bearer_auth(key)
        .json(&request_body(&p, messages)?)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "timeout"
            } else {
                "connection"
            }
        })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        // Inspect only a bounded error body; never return or log its contents.
        if status >= 500 {
            let mut bytes = Vec::new();
            while let Ok(Some(chunk)) = response.chunk().await {
                if bytes.len() + chunk.len() > 16384 {
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            let text = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
            if text.contains("tls") && text.contains("handshake") {
                return Err("upstream_tls");
            }
        }
        return Err(status_error(status));
    }
    let sse = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"));
    let mut parser = Sse::default();
    let mut json_bytes = Vec::new();
    let mut size = 0;
    let mut has_text = false;
    while let Some(bytes) = response.chunk().await.map_err(|e| {
        if e.is_timeout() {
            "timeout"
        } else {
            "connection"
        }
    })? {
        size += bytes.len();
        if size > 2 * 1024 * 1024 {
            return Err("response");
        }
        if sse {
            for text in parser.push(&bytes)? {
                has_text = true;
                progress.store(monotonic_ms(), Ordering::SeqCst);
                emit(text);
            }
            if parser.finished {
                break;
            }
        } else {
            json_bytes.extend_from_slice(&bytes);
        }
    }
    if !sse {
        let v: Value = serde_json::from_slice(&json_bytes).map_err(|_| "response")?;
        if let Some(text) = response_text(&v)? {
            if !text.is_empty() {
                has_text = true;
                progress.store(monotonic_ms(), Ordering::SeqCst);
                emit(text);
            }
        }
    }
    if !has_text || sse && !parser.finished {
        return Err("response");
    }
    Ok(())
}
#[tauri::command]
pub fn chat_start(
    window: WebviewWindow,
    app: tauri::AppHandle,
    profile_id: String,
    request_id: String,
    messages: Value,
    model: Option<String>,
    reasoning_effort: Option<String>,
    session_id: String,
    network_mode: String,
    depth: String,
    local_clock: String,
    on_event: Channel<Value>,
) -> Result<(), &'static str> {
    chat_only(&window)?;
    validate_messages(&messages)?;
    if !matches!(network_mode.as_str(), "off" | "auto" | "required")
        || !matches!(depth.as_str(), "daily" | "research")
        || session_id.len() > 100
        || local_clock.len() > 200
    {
        return Err("config");
    }
    let search_key = if network_mode != "off" {
        app.state::<crate::search_config::SearchConfig>().key().ok()
    } else {
        None
    };
    if network_mode == "required"
        && search_key.is_none()
        && !crate::location_weather::weather_intent(&messages)
    {
        return Err("search_key");
    }
    if request_id.len() > 50
        || !request_id.starts_with("ld-")
        || !request_id[3..]
            .chars()
            .all(|c| c.is_ascii_digit() || c == '-')
    {
        return Err("config");
    }
    let (mut profile, key) = app.state::<ModelConfig>().resolve(&profile_id)?;
    if let Some(model) = model {
        if model.trim().is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
            return Err("config");
        }
        profile["model"] = json!(model);
    }
    if let Some(effort) = reasoning_effort {
        profile["reasoningEffort"] = json!(effort);
    }
    request_body(&profile, messages.clone())?;
    let state = app.state::<Requests>();
    let mut active = state.active.lock().map_err(|_| "config")?;
    if active
        .as_ref()
        .is_some_and(|a| !a.done.load(Ordering::SeqCst))
    {
        return Err("config");
    }
    let done = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(AtomicU64::new(0));
    let total = request_total_ms(&profile)?;
    let phase = Arc::new(AtomicU64::new(monotonic_ms()));
    let task_phase = phase.clone();
    let start = monotonic_ms();
    let deadline_ms = start + total;
    let d = done.clone();
    let pr = progress.clone();
    let a = app.clone();
    let id = request_id.clone();
    let channel = on_event.clone();
    let location = app
        .state::<crate::location_weather::Locations>()
        .selected()
        .unwrap_or(Value::Null);
    let cache_key = serde_json::to_string(&json!([
        profile_id,
        profile["baseUrl"],
        profile["model"],
        session_id
    ]))
    .map_err(|_| "config")?;
    app.state::<Diagnostics>().record(
        "request_start",
        json!({"request_id":request_id,"config_id":profile_id}),
    );
    let task = tauri::async_runtime::spawn(async move {
        let first = AtomicBool::new(true);
        let cache = a.state::<crate::research::ResearchCache>();
        let result = crate::research::Run { deadline_ms, profile, key, messages, search_key, mode:network_mode, depth, clock:local_clock, location, cache_key, cache:&cache, progress:pr, phase:task_phase, #[cfg(test)] test_weather:None, #[cfg(test)] test_tavily:None }.execute(
            |mut event| {
                if d.load(Ordering::SeqCst) {
                    return;
                }
                if event["kind"] == "delta" && first.swap(false, Ordering::SeqCst) {
                    a.state::<Diagnostics>().record(
                        "request_first",
                        json!({"request_id":id,"elapsed_ms":monotonic_ms()-start}),
                    );
                }
                if matches!(event["kind"].as_str(),Some("tool_start"|"tool_result")) {a.state::<Diagnostics>().record(event["kind"].as_str().unwrap(),json!({"request_id":id,"tool":event["tool"],"elapsed_ms":event["elapsedMs"],"count":event["count"],"code":event["code"]}));}
                event["requestId"] = json!(id);
                let _ = channel.send(event);
            }
        )
        .await;
        if !d.swap(true, Ordering::SeqCst) {
            let (kind, code) = match result {
                Ok(()) => ("complete", ""),
                Err(code) => ("failed", code),
            };
            let _ = channel.send(json!({"requestId":id,"kind":kind,"code":code}));
            a.state::<Diagnostics>().record(
                if kind == "complete" {
                    "request_complete"
                } else {
                    "request_failed"
                },
                json!({"request_id":id,"code":code,"elapsed_ms":monotonic_ms()-start}),
            );
        }
    });
    *active = Some(Active {
        id: request_id.clone(),
        done: done.clone(),
        task,
        channel: on_event,
    });
    drop(active);
    // A bounded watchdog also interrupts a server that sends endless empty SSE events.
    std::thread::spawn(move || {
        while !done.load(Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let last = progress.load(Ordering::SeqCst);
            let time = monotonic_ms();
            let phase_start = phase.load(Ordering::SeqCst);
            if time.saturating_sub(start) >= total
                || phase_start != u64::MAX && deadline_reached(phase_start, last, time, total)
            {
                let state = app.state::<Requests>();
                if let Ok(mut lock) = state.active.lock() {
                    if lock.as_ref().is_some_and(|a| a.id == request_id) {
                        let active = lock.take().unwrap();
                        if !done.swap(true, Ordering::SeqCst) {
                            active.task.abort();
                            let _ = active.channel.send(
                                json!({"requestId":request_id,"kind":"failed","code":"timeout"}),
                            );
                            app.state::<Diagnostics>().record("request_failed",json!({"request_id":request_id,"code":"timeout","elapsed_ms":time-start}));
                        }
                    }
                }
                break;
            }
        }
    });
    Ok(())
}
#[tauri::command]
pub fn chat_cancel(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), &'static str> {
    chat_only(&window)?;
    app.state::<Requests>().cancel(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_model_and_effort_are_transmitted() {
        let body = request_body(
            &json!({"model":"gpt-5.6-sol","reasoningEffort":"high"}),
            json!([]),
        )
        .unwrap();
        assert_eq!(body["model"], "gpt-5.6-sol");
        assert_eq!(body["reasoning_effort"], "high");
        assert!(request_body(&json!({"model":"test"}), json!([]))
            .unwrap()
            .get("reasoning_effort")
            .is_none());
        assert!(request_body(&json!({"reasoningEffort":"invalid"}), json!([])).is_err());
    }
    #[test]
    fn multi_turn_body_keeps_latest_user_and_scopes_echo_instruction() {
        let messages = json!([
            {"role":"user","content":"请只回复：测试成功"},
            {"role":"assistant","content":"测试成功"},
            {"role":"user","content":"你好"}
        ]);
        let body = request_body(&json!({"model":"gpt-5.6-sol"}), messages.clone()).unwrap();
        assert_eq!(body["messages"][0]["role"], "system");
        assert!(body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("只适用于那一轮"));
        assert_eq!(
            &body["messages"].as_array().unwrap()[1..],
            messages.as_array().unwrap()
        );
        assert_eq!(
            body["messages"].as_array().unwrap().last().unwrap()["content"],
            "你好"
        );
    }
    #[test]
    fn split_utf8_and_sse() {
        let wire =
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\r\n\r\ndata: [DONE]\n\n";
        let mut parser = Sse::default();
        let mut all = String::new();
        for byte in wire.as_bytes() {
            for t in parser.push(&[*byte]).unwrap() {
                all.push_str(&t);
            }
        }
        assert_eq!(all, "你好");
        assert!(parser.finished);
    }
    #[test]
    fn malformed_and_errors() {
        assert_eq!(
            Sse::default().push(b"data: bad\n\n").unwrap_err(),
            "response"
        );
        assert_eq!(status_error(401), "authentication");
        assert_eq!(status_error(429), "rate_limit");
        assert_eq!(status_error(503), "server");
        assert_eq!(
            response_text(&json!({"error":{"message":"SECRET"}})).unwrap_err(),
            "server"
        );
    }
    #[test]
    fn context_limits() {
        assert!(validate_messages(&json!([{"role":"user","content":"hello"}])).is_ok());
        assert!(validate_messages(&json!([{"role":"system","content":"x"}])).is_err());
        assert_eq!(
            validate_messages(&json!([{"role":"user","content":"x".repeat(100001)}])).unwrap_err(),
            "context"
        );
    }
    fn mock(
        status: u16,
        content_type: &str,
        body: &str,
        delay_ms: u64,
    ) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let response=format!("HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut buf = [0u8; 16384];
            let _ = socket.read(&mut buf);
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            for chunk in response.as_bytes().chunks(7) {
                if socket.write_all(chunk).is_err() {
                    break;
                }
            }
        });
        (base, server)
    }
    #[test]
    fn network_sse_and_json_success() {
        for (kind, body) in [
            (
                "text/event-stream",
                "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: [DONE]\n\n",
            ),
            (
                "application/json",
                "{\"choices\":[{\"message\":{\"content\":\"你好\"}}]}",
            ),
        ] {
            let (base, server) = mock(200, kind, body, 0);
            let out = Mutex::new(String::new());
            let result = tauri::async_runtime::block_on(stream(
                json!({"baseUrl":base,"model":"test","timeoutSeconds":3}),
                "test-key".into(),
                json!([{"role":"user","content":"test"}]),
                |text| out.lock().unwrap().push_str(&text),
                Arc::new(AtomicU64::new(0)),
            ));
            server.join().unwrap();
            assert!(result.is_ok(), "{result:?}");
            assert_eq!(*out.lock().unwrap(), "你好");
        }
    }
    #[test]
    fn network_failure_codes_never_return_error_body() {
        for (status, expected) in [
            (401, "authentication"),
            (404, "model_missing"),
            (429, "rate_limit"),
            (503, "server"),
        ] {
            let (base, server) = mock(
                status,
                "application/json",
                "{\"error\":\"sk-secret private message\"}",
                0,
            );
            let result = tauri::async_runtime::block_on(stream(
                json!({"baseUrl":base,"model":"test","timeoutSeconds":3}),
                "test-key".into(),
                json!([{"role":"user","content":"test"}]),
                |_| panic!("must not emit"),
                Arc::new(AtomicU64::new(0)),
            ));
            server.join().unwrap();
            assert_eq!(result.unwrap_err(), expected);
        }
    }
    #[test]
    fn network_timeout_and_abort() {
        let (base, server) = mock(200, "application/json", "{}", 1200);
        let result = tauri::async_runtime::block_on(stream(
            json!({"baseUrl":base,"model":"test","timeoutSeconds":1}),
            "test-key".into(),
            json!([]),
            |_| {},
            Arc::new(AtomicU64::new(0)),
        ));
        assert_eq!(result.unwrap_err(), "timeout");
        server.join().unwrap();
        let (base, server) = mock(200, "application/json", "{}", 500);
        let task = tauri::async_runtime::spawn(stream(
            json!({"baseUrl":base,"model":"test","timeoutSeconds":3}),
            "test-key".into(),
            json!([]),
            |_| panic!("aborted"),
            Arc::new(AtomicU64::new(0)),
        ));
        std::thread::sleep(std::time::Duration::from_millis(100));
        task.abort();
        assert!(tauri::async_runtime::block_on(task).is_err());
        server.join().unwrap();
    }
    #[test]
    fn connection_refused_and_incomplete_sse() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        drop(listener);
        let result = tauri::async_runtime::block_on(stream(
            json!({"baseUrl":base,"model":"test","timeoutSeconds":3}),
            "test-key".into(),
            json!([]),
            |_| {},
            Arc::new(AtomicU64::new(0)),
        ));
        assert_eq!(result.unwrap_err(), "connection");
        let (base, server) = mock(
            200,
            "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
            0,
        );
        let result = tauri::async_runtime::block_on(stream(
            json!({"baseUrl":base,"model":"test","timeoutSeconds":3}),
            "test-key".into(),
            json!([]),
            |_| {},
            Arc::new(AtomicU64::new(0)),
        ));
        server.join().unwrap();
        assert_eq!(result.unwrap_err(), "response");
    }
    #[test]
    fn first_text_idle_and_total_deadlines() {
        assert!(!deadline_reached(1000, 0, 60999, 180000));
        assert!(deadline_reached(1000, 0, 61000, 180000));
        assert!(deadline_reached(1000, 2000, 32000, 180000));
        assert!(deadline_reached(1000, 180999, 181000, 180000));
        assert!(!deadline_reached(1000, 30000, 31000, 180000));
    }
    #[test]
    fn configured_total_budget_and_invalid_values() {
        for seconds in [30, 180, 600] {
            assert_eq!(
                request_total_ms(&json!({"timeoutSeconds":seconds})),
                Ok(seconds * 1000)
            );
        }
        for value in [
            json!(29),
            json!(601),
            json!(30.5),
            json!("180"),
            Value::Null,
        ] {
            assert_eq!(
                request_total_ms(&json!({"timeoutSeconds":value})),
                Err("config")
            );
        }
        assert_eq!(request_total_ms(&json!({})), Ok(180_000));
    }
    #[test]
    fn total_budget_is_shared_across_rounds_even_with_recent_progress() {
        let total = request_total_ms(&json!({"timeoutSeconds":600})).unwrap();
        assert!(!deadline_reached(1000, 181000, 181001, total));
        let deadline = 1000 + total;
        assert_eq!(
            remaining_time_at(deadline, 181000),
            Ok(Duration::from_secs(420))
        );
        assert_eq!(
            remaining_time_at(deadline, 301000),
            Ok(Duration::from_secs(300))
        );
        assert_eq!(remaining_time_at(deadline, 601000), Err("timeout"));
        assert!(deadline_reached(1000, 600999, 601000, total));
        assert!(deadline_reached(1000, 30999, 31000, 30000));
    }
    #[test]
    #[ignore = "Explicit manual real-proxy verification; sends one harmless message"]
    fn real_proxy_stream_canary() {
        let path = std::path::PathBuf::from(std::env::var_os("USERPROFILE").unwrap())
            .join(".workbuddy/models.json");
        let v: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let p = v
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "gpt-6-astra")
            .unwrap();
        let base = crate::model_config::normalize_url(p["url"].as_str().unwrap()).unwrap();
        let count = AtomicU64::new(0);
        let result = tauri::async_runtime::block_on(stream(
            json!({"baseUrl":base,"model":"gpt-6-astra","timeoutSeconds":90}),
            p["apiKey"].as_str().unwrap().into(),
            json!([{"role":"user","content":"Reply with exactly: LineDog connection OK"}]),
            |text| {
                count.fetch_add(text.len() as u64, Ordering::SeqCst);
            },
            Arc::new(AtomicU64::new(0)),
        ));
        assert!(result.is_ok(), "sanitized result: {result:?}");
        assert!(count.load(Ordering::SeqCst) > 0);
        println!(
            "Codex real stream completed; received {} bytes; response content omitted",
            count.load(Ordering::SeqCst)
        );
    }
}
