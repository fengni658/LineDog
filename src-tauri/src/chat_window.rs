use crate::diagnostics::Diagnostics;
use serde_json::json;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
pub fn open(app: &tauri::AppHandle, page: &str) -> Result<(), &'static str> {
    if let Some(window) = app.get_webview_window("chat") {
        window.show().map_err(|_| "config")?;
        window.set_focus().map_err(|_| "config")?;
        window.emit("chat-page", page).map_err(|_| "config")?;
    } else {
        WebviewWindowBuilder::new(
            app,
            "chat",
            WebviewUrl::App(format!("index.html?page={page}").into()),
        )
        .title("线条小狗 · 聊天")
        .inner_size(440., 600.)
        .min_inner_size(360., 440.)
        .resizable(true)
        .visible(true)
        .focused(true)
        .build()
        .map_err(|_| "config")?;
    }
    app.state::<Diagnostics>()
        .record("window_open", json!({"surface":"chat"}));
    Ok(())
}
#[tauri::command]
pub fn chat_open(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), &'static str> {
    if !["main", "chat"].contains(&window.label()) {
        return Err("config");
    }
    open(&app, "chat")
}
#[tauri::command]
pub fn chat_context_menu(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), &'static str> {
    if window.label() != "main" {
        return Err("config");
    }
    window
        .popup_menu(&app.state::<crate::pet_menu::PetMenu>().0)
        .map_err(|_| "config")
}
