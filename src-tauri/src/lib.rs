use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, PhysicalPosition, Wry,
};
use tauri_plugin_updater::{Update, UpdaterExt};

const MAIN_WINDOW_LABEL: &str = "main";
const CHECK_FOR_UPDATES_MENU_ITEM_ID: &str = "check-for-updates";
const UPDATE_STATUS_MENU_ITEM_ID: &str = "update-status";
const QUIT_MENU_ITEM_ID: &str = "quit";
const CLICK_THROUGH_MAIN_WINDOW_UNAVAILABLE: &str = "main_window_unavailable";
const CLICK_THROUGH_CORE_CALL_FAILED: &str = "set_ignore_cursor_events_failed";
const CLICK_THROUGH_STYLE_NORMALIZATION_FAILED: &str = "windows_style_normalization_failed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Installing,
    UpToDate,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpdateAction {
    Check,
    Install,
    Ignore,
}

struct UpdateStateMachine {
    phase: UpdatePhase,
}

impl Default for UpdateStateMachine {
    fn default() -> Self {
        Self {
            phase: UpdatePhase::Idle,
        }
    }
}

impl UpdateStateMachine {
    fn phase(&self) -> UpdatePhase {
        self.phase
    }

    fn click(&mut self) -> UpdateAction {
        match self.phase {
            UpdatePhase::Idle | UpdatePhase::UpToDate | UpdatePhase::Error => {
                self.phase = UpdatePhase::Checking;
                UpdateAction::Check
            }
            UpdatePhase::Available => {
                self.phase = UpdatePhase::Installing;
                UpdateAction::Install
            }
            UpdatePhase::Checking | UpdatePhase::Installing => UpdateAction::Ignore,
        }
    }

    fn complete_check(&mut self, update_available: bool) {
        self.phase = if update_available {
            UpdatePhase::Available
        } else {
            UpdatePhase::UpToDate
        };
    }

    fn fail(&mut self) {
        self.phase = UpdatePhase::Error;
    }
}

struct UpdaterState {
    machine: UpdateStateMachine,
    pending_update: Option<Update>,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self {
            machine: UpdateStateMachine::default(),
            pending_update: None,
        }
    }
}

#[derive(Clone)]
struct UpdaterTrayMenu {
    action: MenuItem<Wry>,
    status: MenuItem<Wry>,
}

enum StartedUpdateAction {
    Check,
    Install(Update),
    Ignore,
}

impl UpdaterState {
    fn start_action(&mut self) -> StartedUpdateAction {
        match self.machine.click() {
            UpdateAction::Check => {
                self.pending_update = None;
                StartedUpdateAction::Check
            }
            UpdateAction::Install => match self.pending_update.take() {
                Some(update) => StartedUpdateAction::Install(update),
                None => {
                    self.machine.fail();
                    StartedUpdateAction::Ignore
                }
            },
            UpdateAction::Ignore => StartedUpdateAction::Ignore,
        }
    }
}

fn render_updater_menu(menu: &UpdaterTrayMenu, phase: UpdatePhase) {
    let (action_text, status_text, action_enabled) = match phase {
        UpdatePhase::Idle => ("检查更新", "更新：尚未检查", true),
        UpdatePhase::Checking => ("正在检查更新…", "更新：正在检查", false),
        UpdatePhase::Available => ("下载并安装更新", "更新可用；再次点击确认下载并安装", true),
        UpdatePhase::Installing => ("正在安装更新…", "更新：正在下载并安装", false),
        UpdatePhase::UpToDate => ("检查更新", "更新：已是最新版本", true),
        UpdatePhase::Error => ("重试检查更新", "更新失败；可重试", true),
    };

    let _ = menu.action.set_text(action_text);
    let _ = menu.action.set_enabled(action_enabled);
    let _ = menu.status.set_text(status_text);
}

fn with_updater_state<T>(
    app: &AppHandle<Wry>,
    operation: impl FnOnce(&mut UpdaterState) -> T,
) -> T {
    let updater_state = app.state::<Mutex<UpdaterState>>();
    let mut updater_state = updater_state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation(&mut updater_state)
}

fn begin_update_action(app: &AppHandle<Wry>, menu: &UpdaterTrayMenu) -> StartedUpdateAction {
    let (action, phase) = with_updater_state(app, |updater_state| {
        let action = updater_state.start_action();
        (action, updater_state.machine.phase())
    });

    render_updater_menu(menu, phase);
    action
}

fn complete_update_check(app: &AppHandle<Wry>, menu: &UpdaterTrayMenu, update: Option<Update>) {
    let phase = with_updater_state(app, |updater_state| {
        let update_available = update.is_some();
        updater_state.pending_update = update;
        updater_state.machine.complete_check(update_available);
        updater_state.machine.phase()
    });

    render_updater_menu(menu, phase);
}

fn mark_update_error(app: &AppHandle<Wry>, menu: &UpdaterTrayMenu) {
    let phase = with_updater_state(app, |updater_state| {
        updater_state.pending_update = None;
        updater_state.machine.fail();
        updater_state.machine.phase()
    });

    render_updater_menu(menu, phase);
}

async fn check_for_update(app: AppHandle<Wry>, menu: UpdaterTrayMenu) {
    let update = match app.updater() {
        Ok(updater) => match updater.check().await {
            Ok(update) => update,
            Err(error) => {
                eprintln!("LineDog updater check failed: {error}");
                mark_update_error(&app, &menu);
                return;
            }
        },
        Err(error) => {
            eprintln!("LineDog updater initialization failed: {error}");
            mark_update_error(&app, &menu);
            return;
        }
    };

    complete_update_check(&app, &menu, update);
}

async fn download_install_and_restart(app: AppHandle<Wry>, menu: UpdaterTrayMenu, update: Update) {
    if let Err(error) = update.download_and_install(|_, _| {}, || {}).await {
        eprintln!("LineDog updater install failed: {error}");
        mark_update_error(&app, &menu);
        return;
    }

    app.restart();
}

#[cfg(windows)]
mod windows_window_style {
    use std::ffi::c_void;

    const GWL_STYLE: i32 = -16;
    const GWL_EXSTYLE: i32 = -20;
    const WS_CAPTION: u32 = 0x00C0_0000;
    const WS_THICKFRAME: u32 = 0x0004_0000;
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    const WS_EX_APPWINDOW: u32 = 0x0004_0000;
    const WS_EX_LAYERED: u32 = 0x0008_0000;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetWindowLongPtrW(hwnd: *mut c_void, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: *mut c_void, index: i32, value: isize) -> isize;
        fn SetWindowPos(
            hwnd: *mut c_void,
            insert_after: *mut c_void,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLastError() -> u32;
        fn SetLastError(error: u32);
    }

    fn normalized_extended_style(current: u32) -> u32 {
        (current & !WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW | WS_EX_LAYERED
    }

    fn normalized_window_style(current: u32) -> u32 {
        current & !(WS_CAPTION | WS_THICKFRAME)
    }

    pub fn normalize<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), ()> {
        let hwnd = window.hwnd().map_err(|_| ())?.0;

        unsafe {
            let current_style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            let desired_style = normalized_window_style(current_style);
            let current_extended_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            let desired_extended_style = normalized_extended_style(current_extended_style);
            let mut frame_changed = false;

            if desired_style != current_style {
                SetLastError(0);
                let previous = SetWindowLongPtrW(hwnd, GWL_STYLE, desired_style as isize);
                if previous == 0 && GetLastError() != 0 {
                    return Err(());
                }
                frame_changed = true;
            }

            if desired_extended_style != current_extended_style {
                SetLastError(0);
                let previous =
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, desired_extended_style as isize);
                if previous == 0 && GetLastError() != 0 {
                    return Err(());
                }
                frame_changed = true;
            }

            if frame_changed {
                let flags =
                    SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED;
                if SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, 0, 0, flags) == 0 {
                    return Err(());
                }
            }

            let applied_style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            if applied_style != normalized_window_style(applied_style) {
                return Err(());
            }

            let applied_extended_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
            if applied_extended_style != normalized_extended_style(applied_extended_style) {
                return Err(());
            }
        }

        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn preserves_unrelated_extended_style_bits() {
            let layered_topmost_transparent = 0x0008_0028;
            let input = layered_topmost_transparent | WS_EX_APPWINDOW;

            assert_eq!(
                normalized_extended_style(input),
                layered_topmost_transparent | WS_EX_TOOLWINDOW
            );
        }

        #[test]
        fn adds_layered_and_preserves_unrelated_extended_style_bits() {
            let unrelated_extended_style_bits = 0x0000_0028;
            let input = unrelated_extended_style_bits | WS_EX_APPWINDOW;

            assert_eq!(
                normalized_extended_style(input),
                unrelated_extended_style_bits | WS_EX_TOOLWINDOW | WS_EX_LAYERED
            );
        }

        #[test]
        fn removes_caption_and_size_frame_while_preserving_unrelated_style_bits() {
            let unrelated_window_style_bits = 0x1408_0000;
            let input = unrelated_window_style_bits | 0x00C0_0000 | 0x0004_0000;

            assert_eq!(normalized_window_style(input), unrelated_window_style_bits);
        }
    }
}

#[cfg(windows)]
fn normalize_main_window_style<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), ()> {
    windows_window_style::normalize(window)
}

#[cfg(not(windows))]
fn normalize_main_window_style<R: tauri::Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> Result<(), ()> {
    Ok(())
}

#[cfg(test)]
mod updater_state_machine_tests {
    use super::*;

    #[test]
    fn second_click_after_available_confirms_install() {
        let mut state = UpdateStateMachine::default();

        assert_eq!(state.click(), UpdateAction::Check);
        assert_eq!(state.phase(), UpdatePhase::Checking);

        state.complete_check(true);
        assert_eq!(state.phase(), UpdatePhase::Available);
        assert_eq!(state.click(), UpdateAction::Install);
        assert_eq!(state.phase(), UpdatePhase::Installing);
    }

    #[test]
    fn repeated_clicks_are_ignored_while_busy() {
        let mut state = UpdateStateMachine::default();

        assert_eq!(state.click(), UpdateAction::Check);
        assert_eq!(state.click(), UpdateAction::Ignore);
        assert_eq!(state.phase(), UpdatePhase::Checking);

        state.complete_check(true);
        assert_eq!(state.click(), UpdateAction::Install);
        assert_eq!(state.click(), UpdateAction::Ignore);
        assert_eq!(state.phase(), UpdatePhase::Installing);
    }

    #[test]
    fn error_returns_to_a_retryable_check() {
        let mut state = UpdateStateMachine::default();

        state.fail();
        assert_eq!(state.click(), UpdateAction::Check);
        assert_eq!(state.phase(), UpdatePhase::Checking);
    }

    #[test]
    fn up_to_date_allows_another_user_requested_check() {
        let mut state = UpdateStateMachine::default();

        state.complete_check(false);
        assert_eq!(state.phase(), UpdatePhase::UpToDate);
        assert_eq!(state.click(), UpdateAction::Check);
        assert_eq!(state.phase(), UpdatePhase::Checking);
    }

    #[test]
    fn available_without_pending_update_enters_error_and_ignores_install() {
        let mut state = UpdaterState::default();

        state.machine.complete_check(true);
        assert_eq!(state.machine.phase(), UpdatePhase::Available);
        assert!(matches!(state.start_action(), StartedUpdateAction::Ignore));
        assert_eq!(state.machine.phase(), UpdatePhase::Error);
        assert!(state.pending_update.is_none());
    }
}

#[tauri::command]
fn set_window_click_through(app: tauri::AppHandle, ignore: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| CLICK_THROUGH_MAIN_WINDOW_UNAVAILABLE.to_owned())?;

    window
        .set_ignore_cursor_events(ignore)
        .map_err(|_| CLICK_THROUGH_CORE_CALL_FAILED.to_owned())?;
    normalize_main_window_style(&window)
        .map_err(|_| CLICK_THROUGH_STYLE_NORMALIZATION_FAILED.to_owned())
}

fn position_main_window_at_primary_work_area_bottom(app: &tauri::App) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };
    let Some(monitor) = app.primary_monitor()? else {
        return Ok(());
    };

    let work_area = monitor.work_area();
    let window_size = window.outer_size()?;
    let x =
        work_area.position.x + (work_area.size.width.saturating_sub(window_size.width) / 2) as i32;
    let y = work_area.position.y + work_area.size.height.saturating_sub(window_size.height) as i32;

    window.set_position(PhysicalPosition::new(x, y))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(UpdaterState::default()))
        .invoke_handler(tauri::generate_handler![set_window_click_through])
        .setup(|app| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                normalize_main_window_style(&window)
                    .map_err(|_| std::io::Error::other(CLICK_THROUGH_STYLE_NORMALIZATION_FAILED))?;
            }

            position_main_window_at_primary_work_area_bottom(app)?;

            let check_for_updates = MenuItem::with_id(
                app,
                CHECK_FOR_UPDATES_MENU_ITEM_ID,
                "检查更新",
                true,
                None::<&str>,
            )?;
            let update_status = MenuItem::with_id(
                app,
                UPDATE_STATUS_MENU_ITEM_ID,
                "更新：尚未检查",
                false,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, QUIT_MENU_ITEM_ID, "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&check_for_updates, &update_status, &quit])?;
            let tray_icon = tauri::image::Image::new_owned(
                include_bytes!("../icons/linedog-tray.rgba").to_vec(),
                64,
                64,
            );
            let updater_menu = UpdaterTrayMenu {
                action: check_for_updates,
                status: update_status,
            };
            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    if event.id.as_ref() == CHECK_FOR_UPDATES_MENU_ITEM_ID {
                        match begin_update_action(app, &updater_menu) {
                            StartedUpdateAction::Check => {
                                let app = app.clone();
                                let menu = updater_menu.clone();
                                tauri::async_runtime::spawn(async move {
                                    check_for_update(app, menu).await;
                                });
                            }
                            StartedUpdateAction::Install(update) => {
                                let app = app.clone();
                                let menu = updater_menu.clone();
                                tauri::async_runtime::spawn(async move {
                                    download_install_and_restart(app, menu, update).await;
                                });
                            }
                            StartedUpdateAction::Ignore => {}
                        }
                    } else if event.id.as_ref() == QUIT_MENU_ITEM_ID {
                        app.exit(0);
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
