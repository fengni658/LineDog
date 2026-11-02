use crate::{
    diagnostics::report_dialog,
    model_config::{chat_only, crypt},
};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, WebviewWindow};

pub struct SearchConfig {
    path: PathBuf,
    lock: Mutex<()>,
}
impl SearchConfig {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join("search-v1.bin"),
            lock: Mutex::new(()),
        }
    }
    pub fn key(&self) -> Result<String, &'static str> {
        let _guard = self.lock.lock().map_err(|_| "config")?;
        if !self.path.exists() {
            return Err("search_key");
        }
        String::from_utf8(crypt(&fs::read(&self.path).map_err(|_| "storage")?, false)?)
            .map_err(|_| "config")
    }
    fn save(&self, key: &str) -> Result<(), &'static str> {
        if key.trim().is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
            return Err("search_key");
        }
        let _guard = self.lock.lock().map_err(|_| "config")?;
        fs::create_dir_all(self.path.parent().ok_or("storage")?).map_err(|_| "storage")?;
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, crypt(key.trim().as_bytes(), true)?).map_err(|_| "storage")?;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };
        let from: Vec<u16> = tmp
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let to: Vec<u16> = self
            .path
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|_| "storage")
        }
    }
}
#[tauri::command]
pub fn search_config(window: WebviewWindow, app: tauri::AppHandle) -> Result<Value, &'static str> {
    chat_only(&window)?;
    let state = app.state::<SearchConfig>();
    Ok(json!({"hasKey":state.key().is_ok(),"keyError":state.path.exists() && state.key().is_err()}))
}
#[tauri::command]
pub fn search_save(
    window: WebviewWindow,
    app: tauri::AppHandle,
    api_key: String,
) -> Result<(), &'static str> {
    chat_only(&window)?;
    app.state::<SearchConfig>().save(&api_key)
}
#[tauri::command]
pub async fn search_test(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Value, &'static str> {
    chat_only(&window)?;
    let key = app.state::<SearchConfig>().key()?;
    // Explicit button explains this is a real basic search and may consume credits.
    let v = crate::research::tavily("search", &key, &json!({"query":"Tavily documentation","search_depth":"basic","auto_parameters":false,"max_results":1,"include_answer":false,"include_images":false,"include_usage":true}),20).await?;
    Ok(
        json!({"count":v["results"].as_array().map_or(0,Vec::len),"usage":v["usage"]["credits"].as_f64()}),
    )
}
#[tauri::command]
pub async fn report_export(
    window: WebviewWindow,
    format: String,
    report: Value,
) -> Result<bool, &'static str> {
    chat_only(&window)?;
    if !matches!(format.as_str(), "md" | "json") {
        return Err("config");
    }
    let bytes = if format == "md" {
        report.as_str().ok_or("config")?.as_bytes().to_vec()
    } else {
        serde_json::to_vec_pretty(&report).map_err(|_| "config")?
    };
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("context");
    }
    let owner = window.hwnd().map_err(|_| "storage")?.0 as isize;
    let path =
        tauri::async_runtime::spawn_blocking(move || report_dialog(owner, "research", &format))
            .await
            .map_err(|_| "storage")??;
    let Some(path) = path else { return Ok(false) };
    fs::write(path, bytes).map_err(|_| "storage")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_key_is_encrypted_and_corruption_is_reported() {
        let root = std::env::temp_dir().join(format!(
            "linedog-search-config-{}",
            crate::diagnostics::now()
        ));
        let c = SearchConfig::new(root.clone());
        assert_eq!(c.key(), Err("search_key"));
        c.save("tvly-fixture-secret").unwrap();
        assert_eq!(c.key().unwrap(), "tvly-fixture-secret");
        assert!(
            !String::from_utf8_lossy(&fs::read(&c.path).unwrap()).contains("tvly-fixture-secret")
        );
        fs::write(&c.path, b"corrupt").unwrap();
        assert!(c.key().is_err());
        fs::remove_file(&c.path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
