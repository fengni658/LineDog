use crate::{
    diagnostics::{safe_event, Diagnostics},
    model_config::{normalize_url, ModelConfig},
};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static ID: AtomicU64 = AtomicU64::new(0);
fn temp(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "linedog-080-test-{}-{}-{}",
        std::process::id(),
        label,
        ID.fetch_add(1, Ordering::SeqCst)
    ))
}
#[test]
fn no_sensitive_fields_or_untrusted_text() {
    let row=safe_event("request_failed",&json!({"apiKey":"sk-secret","Authorization":"Bearer secret","message":"user private text","url":"https://user:pass@example.com/?key=x","code":"secret error","state":"sk-secret","config_id":"https://example.com","request_id":"ld-12"})).unwrap();
    assert_eq!(row, json!({"event":"request_failed","request_id":"ld-12"}));
    assert!(safe_event("sk-secret", &json!({})).is_none());
}
#[test]
fn log_export_filters_disk_injection_and_preserves_file() {
    let root = temp("export");
    fs::create_dir_all(&root).unwrap();
    let log = Diagnostics::new(root.clone());
    log.record("startup", json!({}));
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(root.join("diagnostic-0.jsonl"))
        .unwrap();
    writeln!(f,"{}",json!({"event":"request_failed","apiKey":"sk-secret","code":"authentication","message":"private body","utc_ms":1})).unwrap();
    let snapshot = log.snapshot();
    let text = snapshot.to_string();
    assert!(!text.contains("sk-secret"));
    assert!(!text.contains("private body"));
    assert!(text.contains("authentication"));
    assert_eq!(snapshot["records"].as_array().unwrap().len(), 2);
    assert!(root.join("diagnostic-0.jsonl").exists());
    drop(f);
    fs::remove_file(root.join("diagnostic-0.jsonl")).unwrap();
    fs::remove_dir(root).unwrap();
}
#[test]
fn behavior_wait_diagnostics_are_whitelisted_and_export_current_reasons() {
    let root = temp("behavior-wait");
    let log = Diagnostics::new(root.clone());
    log.record("behavior_wait", json!({"state":"REST","home_stage":"WAKE_HOLD","wait_reason":"input_unknown","paused":false,"input_unknown":true,"home_pending":true,"input_blocked":false,"title":"private title","x":100}));
    log.record("input_status", json!({"input_status":"unavailable","input_kind":"error","input_code":"worker-timeout","approximate":true,"message":"private error"}));
    let snapshot = log.snapshot();
    assert_eq!(
        snapshot["current_state"]["behavior_wait"]["home_stage"],
        "WAKE_HOLD"
    );
    assert_eq!(
        snapshot["current_state"]["behavior_wait"]["wait_reason"],
        "input_unknown"
    );
    assert_eq!(snapshot["current_state"]["behavior_wait"]["paused"], false);
    assert_eq!(
        snapshot["current_state"]["input_status"]["input_code"],
        "worker-timeout"
    );
    assert!(!snapshot.to_string().contains("private"));
    let rejected = safe_event("behavior_wait", &json!({"home_stage":"private", "wait_reason":"private", "paused":"private", "input_code":"worker-timeout"})).unwrap();
    assert_eq!(rejected, json!({"event":"behavior_wait"}));
    let rejected = safe_event("input_status", &json!({"input_code":"private title", "input_status":"private", "input_kind":"private", "approximate":"private"})).unwrap();
    assert_eq!(rejected, json!({"event":"input_status"}));
    fs::remove_file(root.join("diagnostic-0.jsonl")).unwrap();
    fs::remove_dir(root).unwrap();
}
#[test]
fn input_identity_diagnostics_export_only_fixed_mismatch_reasons() {
    let root = temp("input-identity");
    let log = Diagnostics::new(root.clone());
    for reason in [
        "timestamp",
        "request-revision",
        "monitor-revision",
        "dispose-generation",
        "superseded-request",
        "superseded-monitor",
        "multiple",
    ] {
        log.record("input_status", json!({"input_status":"rejected", "input_code":"request-mismatch", "identity_mismatch":reason, "requestRevision":123, "message":"private"}));
        assert_eq!(
            log.snapshot()["current_state"]["input_status"]["identity_mismatch"],
            reason
        );
    }
    let text = log.snapshot().to_string();
    assert!(!text.contains("private"));
    assert!(!text.contains("requestRevision"));
    for data in [
        json!({"input_code":"ok", "identity_mismatch":"timestamp"}),
        json!({"input_code":"request-mismatch", "identity_mismatch":"private"}),
    ] {
        assert!(safe_event("input_status", &data)
            .unwrap()
            .get("identity_mismatch")
            .is_none());
    }
    fs::remove_file(root.join("diagnostic-0.jsonl")).unwrap();
    fs::remove_dir(root).unwrap();
}
#[test]
fn logs_rotate_and_fail_without_panicking() {
    let root = temp("rotate");
    fs::create_dir_all(&root).unwrap();
    for i in 0..5 {
        fs::write(
            root.join(format!("diagnostic-{i}.jsonl")),
            vec![b' '; 2 * 1024 * 1024],
        )
        .unwrap();
    }
    let log = Diagnostics::new(root.clone());
    log.record("startup", json!({}));
    assert_eq!(fs::read_dir(&root).unwrap().count(), 5);
    assert!(fs::metadata(root.join("diagnostic-0.jsonl")).unwrap().len() < 1024);
    for i in 0..5 {
        fs::remove_file(root.join(format!("diagnostic-{i}.jsonl"))).unwrap();
    }
    fs::remove_dir(&root).unwrap();
    fs::write(&root, b"not a directory").unwrap();
    let bad = Diagnostics::new(root.clone());
    bad.record("startup", json!({}));
    assert!(!bad.available());
    assert_eq!(bad.snapshot()["logging_available"], false);
    fs::remove_file(root).unwrap();
}
#[test]
fn repeated_errors_are_aggregated() {
    let root = temp("repeat");
    let log = Diagnostics::new(root.clone());
    for _ in 0..100 {
        log.record("native_error", json!({"code":"unknown"}));
    }
    let v = log.snapshot();
    assert_eq!(v["records"].as_array().unwrap().len(), 2);
    assert_eq!(v["records"][1]["count"], 99);
    fs::remove_file(root.join("diagnostic-0.jsonl")).unwrap();
    fs::remove_dir(root).unwrap();
}
#[test]
fn validates_url_before_any_request() {
    assert_eq!(
        normalize_url("http://127.0.0.1:18317/v1/chat/completions").unwrap(),
        "http://127.0.0.1:18317/v1"
    );
    assert_eq!(
        normalize_url("https://example.com/").unwrap(),
        "https://example.com/v1"
    );
    for url in [
        "http://example.com/v1",
        "https://user:key@example.com/v1",
        "https://example.com/v1?key=secret",
        "https://example.com/v1#secret",
        "file:///tmp/key",
    ] {
        assert!(normalize_url(url).is_err());
    }
}
#[test]
fn config_dpapi_roundtrip_default_and_no_key_disclosure() {
    let root = temp("config");
    fs::create_dir_all(&root).unwrap();
    let path = root.join("models-v1.json");
    fs::write(
        &path,
        json!({"profiles":[],"defaultId":"ld-0","imported":false}).to_string(),
    )
    .unwrap();
    let config = ModelConfig::new(root.clone());
    let id=config.save(json!({"name":"test","baseUrl":"https://example.com/v1","model":"test-model","apiKey":"sk-test-secret-080","timeoutSeconds":180}),true).unwrap()["id"].as_str().unwrap().to_string();
    assert!(!fs::read_to_string(&path)
        .unwrap()
        .contains("sk-test-secret"));
    assert!(!config
        .public()
        .unwrap()
        .to_string()
        .contains("sk-test-secret"));
    assert_eq!(config.resolve(&id).unwrap().1, "sk-test-secret-080");
    assert_eq!(config.public().unwrap()["defaultId"], id);
    config.initialize().unwrap();
    assert_eq!(
        config.public().unwrap()["profiles"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    config.save(json!({"id":id,"name":"other","baseUrl":"https://other.example.com/v1","model":"test-model","apiKey":"","timeoutSeconds":180}),false).unwrap();
    assert_eq!(config.resolve(&id).unwrap_err(), "authentication");
    fs::write(&path, "broken").unwrap();
    assert!(config.initialize().is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "broken");
    fs::remove_file(&path).unwrap();
    fs::remove_dir(root).unwrap();
}
#[test]
fn corrupted_encrypted_key_is_not_exposed() {
    let root = temp("badkey");
    fs::create_dir_all(&root).unwrap();
    let path = root.join("models-v1.json");
    fs::write(
        &path,
        json!({"profiles":[{"id":"ld-1","secret":[1,2,3]}],"defaultId":"ld-1"}).to_string(),
    )
    .unwrap();
    let c = ModelConfig::new(root.clone());
    assert_eq!(c.public().unwrap()["profiles"][0]["keyError"], true);
    assert_eq!(c.resolve("ld-1").unwrap_err(), "config");
    fs::remove_file(path).unwrap();
    fs::remove_dir(root).unwrap();
}
