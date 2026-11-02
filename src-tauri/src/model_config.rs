use crate::diagnostics::{now, Diagnostics};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, WebviewWindow};

pub struct ModelConfig {
    path: PathBuf,
    lock: Mutex<()>,
}
pub fn chat_only(window: &WebviewWindow) -> Result<(), &'static str> {
    if window.label() == "chat" {
        Ok(())
    } else {
        Err("config")
    }
}
pub fn normalize_url(input: &str) -> Result<String, &'static str> {
    let mut url = reqwest::Url::parse(input.trim()).map_err(|_| "config")?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if !(url.scheme() == "https" || url.scheme() == "http" && local)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("config");
    }
    let path = url
        .path()
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions")
        .to_string();
    url.set_path(if path.is_empty() { "/v1" } else { &path });
    Ok(url.to_string().trim_end_matches('/').to_string())
}
pub(crate) fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, &'static str> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::*,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        let result = if encrypt {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        result.map_err(|_| "config")?;
        let protected = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(protected)
    }
}
fn key_bytes(value: &Value) -> Result<Vec<u8>, &'static str> {
    value
        .as_array()
        .ok_or("config")?
        .iter()
        .map(|v| {
            v.as_u64()
                .filter(|n| *n <= 255)
                .map(|n| n as u8)
                .ok_or("config")
        })
        .collect()
}
impl ModelConfig {
    pub fn new(root: PathBuf) -> Self {
        Self {
            path: root.join("models-v1.json"),
            lock: Mutex::new(()),
        }
    }
    fn load(&self) -> Result<Value, &'static str> {
        let bytes = fs::read(&self.path).map_err(|_| "storage")?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| "config")?;
        if !v["profiles"].is_array() || !v["defaultId"].is_string() {
            return Err("config");
        }
        Ok(v)
    }
    fn persist(&self, v: &Value) -> Result<(), &'static str> {
        fs::create_dir_all(self.path.parent().ok_or("storage")?).map_err(|_| "storage")?;
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(v).map_err(|_| "config")?)
            .map_err(|_| "storage")?;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };
        let from: Vec<u16> = tmp
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let to: Vec<u16> = self
            .path
            .as_os_str()
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
    pub fn initialize(&self) -> Result<(), &'static str> {
        let _lock = self.lock.lock().map_err(|_| "config")?;
        if self.path.exists() {
            return self.load().map(|_| ());
        }
        let mut profile = json!({"id":"ld-0","name":"Codex · CLIProxyAPI","baseUrl":"http://127.0.0.1:18317/v1","model":"gpt-6-astra","timeoutSeconds":180,"secret":[]});
        let mut imported = false;
        if let Some(home) = std::env::var_os("USERPROFILE") {
            if let Ok(bytes) = fs::read(PathBuf::from(home).join(".workbuddy/models.json")) {
                if let Ok(entries) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(entry) = entries
                        .as_array()
                        .and_then(|a| a.iter().find(|e| e["id"] == "gpt-6-astra"))
                    {
                        if let (Some(url), Some(key)) =
                            (entry["url"].as_str(), entry["apiKey"].as_str())
                        {
                            if let Ok(base) = normalize_url(url) {
                                profile["baseUrl"] = json!(base);
                                profile["secret"] = json!(crypt(key.as_bytes(), true)?);
                                imported = true;
                            }
                        }
                    }
                }
            }
        }
        self.persist(&json!({"profiles":[profile],"defaultId":"ld-0","imported":imported}))
    }
    pub fn public(&self) -> Result<Value, &'static str> {
        let _lock = self.lock.lock().map_err(|_| "config")?;
        let mut v = self.load()?;
        for p in v["profiles"].as_array_mut().ok_or("config")? {
            let secret = key_bytes(&p["secret"])?;
            p["hasKey"] = json!(!secret.is_empty());
            p["keyError"] = json!(!secret.is_empty() && crypt(&secret, false).is_err());
            p.as_object_mut().ok_or("config")?.remove("secret");
        }
        Ok(v)
    }
    pub fn resolve(&self, id: &str) -> Result<(Value, String), &'static str> {
        let _lock = self.lock.lock().map_err(|_| "config")?;
        let v = self.load()?;
        let mut p = v["profiles"]
            .as_array()
            .ok_or("config")?
            .iter()
            .find(|p| p["id"] == id)
            .cloned()
            .ok_or("config")?;
        let encrypted = key_bytes(&p["secret"])?;
        if encrypted.is_empty() {
            return Err("authentication");
        }
        let key = String::from_utf8(crypt(&encrypted, false)?).map_err(|_| "config")?;
        p.as_object_mut().ok_or("config")?.remove("secret");
        Ok((p, key))
    }
    pub fn save(&self, input: Value, make_default: bool) -> Result<Value, &'static str> {
        let _lock = self.lock.lock().map_err(|_| "config")?;
        let mut v = self.load()?;
        let name = input["name"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 120)
            .ok_or("config")?;
        let model = input["model"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 200)
            .ok_or("config")?;
        let base = normalize_url(input["baseUrl"].as_str().ok_or("config")?)?;
        let timeout = input["timeoutSeconds"]
            .as_u64()
            .filter(|n| (30..=600).contains(n))
            .ok_or("config")?;
        let profiles = v["profiles"].as_array_mut().ok_or("config")?;
        let index = input["id"]
            .as_str()
            .and_then(|id| profiles.iter().position(|p| p["id"] == id));
        let id = index
            .map(|i| profiles[i]["id"].as_str().unwrap_or("ld-0").to_string())
            .unwrap_or_else(|| format!("ld-{}", now()));
        let key = input["apiKey"].as_str().unwrap_or("");
        if key.len() > 16384 {
            return Err("config");
        }
        let secret = if key.is_empty() {
            index
                .filter(|&i| profiles[i]["baseUrl"] == base)
                .map(|i| profiles[i]["secret"].clone())
                .unwrap_or(json!([]))
        } else {
            json!(crypt(key.as_bytes(), true)?)
        };
        let effort = input["reasoningEffort"].as_str().unwrap_or("");
        if ![
            "", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ]
        .contains(&effort)
        {
            return Err("config");
        }
        let p = json!({"id":id,"name":name.trim(),"model":model.trim(),"reasoningEffort":effort,"baseUrl":base,"timeoutSeconds":timeout,"secret":secret});
        if let Some(i) = index {
            profiles[i] = p;
        } else {
            if profiles.len() >= 20 {
                return Err("config");
            }
            profiles.push(p);
        }
        if make_default {
            v["defaultId"] = json!(id);
        }
        self.persist(&v)?;
        Ok(json!({"id":id}))
    }
}
#[tauri::command]
pub fn model_configs(window: WebviewWindow, app: tauri::AppHandle) -> Result<Value, &'static str> {
    chat_only(&window)?;
    let existed = app.state::<ModelConfig>().path.exists();
    app.state::<ModelConfig>().initialize()?;
    if !existed {
        app.state::<Diagnostics>()
            .record("config_imported", json!({"config_id":"ld-0"}));
    }
    app.state::<ModelConfig>().public()
}
#[tauri::command]
pub fn model_save(
    window: WebviewWindow,
    app: tauri::AppHandle,
    profile: Value,
    make_default: bool,
) -> Result<Value, &'static str> {
    chat_only(&window)?;
    let result = app.state::<ModelConfig>().save(profile, make_default)?;
    app.state::<Diagnostics>()
        .record("config_saved", json!({"config_id":result["id"]}));
    Ok(result)
}
#[tauri::command]
pub async fn model_check(
    window: WebviewWindow,
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<bool, &'static str> {
    chat_only(&window)?;
    let (p, key) = app.state::<ModelConfig>().resolve(&profile_id)?;
    let models = fetch_models(&p, key).await?;
    Ok(models
        .iter()
        .any(|m| m == p["model"].as_str().unwrap_or("")))
}
#[tauri::command]
pub async fn model_catalog(
    window: WebviewWindow,
    app: tauri::AppHandle,
    profile_id: String,
) -> Result<Vec<String>, &'static str> {
    chat_only(&window)?;
    let (p, key) = app.state::<ModelConfig>().resolve(&profile_id)?;
    fetch_models(&p, key).await
}
async fn fetch_models(p: &Value, key: String) -> Result<Vec<String>, &'static str> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| "connection")?;
    let mut r = client
        .get(format!("{}/models", p["baseUrl"].as_str().ok_or("config")?))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|_| "connection")?;
    if !r.status().is_success() {
        return Err(crate::model_transport::status_error(r.status().as_u16()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| "response")? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("response");
        }
        bytes.extend_from_slice(&chunk);
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| "response")?;
    let mut models: Vec<String> = v["data"]
        .as_array()
        .ok_or("response")?
        .iter()
        .filter_map(|m| m["id"].as_str())
        .filter(|id| !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control))
        .map(str::to_owned)
        .collect();
    models.sort();
    models.dedup();
    Ok(models)
}
