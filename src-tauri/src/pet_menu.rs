use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem},
    Emitter, Manager, WebviewWindow,
};

pub struct PetMenu(pub Menu<tauri::Wry>);

#[derive(Default)]
pub struct PetControlState {
    ready: bool,
    paused: bool,
    bubbles: bool,
    can_restore: bool,
    busy: bool,
    failed: bool,
}

fn control_items(state: &PetControlState) -> [(&'static str, &'static str, bool); 3] {
    [
        (
            "pet-pause",
            if state.paused {
                "恢复活动"
            } else {
                "安静一下"
            },
            state.ready && !state.busy,
        ),
        (
            "pet-restore",
            if state.busy {
                "正在恢复位置…"
            } else if state.failed {
                "恢复失败，点击重试"
            } else {
                "恢复默认位置"
            },
            state.ready && state.can_restore && !state.busy,
        ),
        (
            "pet-bubbles",
            if state.bubbles {
                "互动气泡：开"
            } else {
                "互动气泡：关"
            },
            state.ready && !state.busy,
        ),
    ]
}

pub fn build(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "chat", "聊天", true, None::<&str>)?)?;
    for (id, text, enabled) in control_items(&PetControlState::default()) {
        menu.append(&MenuItem::with_id(app, id, text, enabled, None::<&str>)?)?;
    }
    for (id, text) in [
        ("settings", "模型与联网设置"),
        ("diagnostics", "导出诊断日志"),
        ("quit", "退出"),
    ] {
        menu.append(&MenuItem::with_id(app, id, text, true, None::<&str>)?)?;
    }
    Ok(menu)
}

#[tauri::command]
pub fn pet_control_state(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: Value,
) -> Result<(), &'static str> {
    if window.label() != "main" {
        return Err("config");
    }
    let flag = |key| state.get(key).and_then(Value::as_bool).ok_or("config");
    let state = PetControlState {
        ready: flag("ready")?,
        paused: flag("paused")?,
        bubbles: flag("bubbles")?,
        can_restore: flag("canRestore")?,
        busy: flag("busy")?,
        failed: flag("failed")?,
    };
    let menu = &app.state::<PetMenu>().0;
    for (id, text, enabled) in control_items(&state) {
        let item = menu.get(id).ok_or("config")?;
        let item = item.as_menuitem().ok_or("config")?;
        item.set_text(text).map_err(|_| "config")?;
        item.set_enabled(enabled).map_err(|_| "config")?;
    }
    Ok(())
}

pub fn dispatch(app: &tauri::AppHandle, id: &str) {
    // The native menu transports intent only; the Runtime rechecks availability.
    let _ = app.emit_to("main", "pet-control", id);
    match id {
        "quit" => crate::handle_quit_tray_menu_event(app),
        "chat" | "settings" | "diagnostics" => {
            let _ = crate::chat_window::open(app, id);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn controls_are_disabled_before_runtime_ready() {
        assert!(control_items(&PetControlState::default())
            .iter()
            .all(|item| !item.2));
    }
    #[test]
    fn runtime_snapshot_drives_both_menu_labels_and_retry() {
        let state = PetControlState {
            ready: true,
            paused: true,
            bubbles: true,
            can_restore: true,
            failed: true,
            ..Default::default()
        };
        let items = control_items(&state);
        assert_eq!(items[0], ("pet-pause", "恢复活动", true));
        assert_eq!(items[1], ("pet-restore", "恢复失败，点击重试", true));
        assert_eq!(items[2], ("pet-bubbles", "互动气泡：开", true));
        assert!(control_items(&PetControlState {
            busy: true,
            ..state
        })
        .iter()
        .all(|item| !item.2));
    }
}
