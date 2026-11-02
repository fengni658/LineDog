#[cfg(test)]
mod chat_tests;
mod chat_window;
mod diagnostics;
mod input_geometry;
mod location_weather;
mod model_config;
mod model_transport;
mod native_platform;
mod pet_menu;
mod research;
#[cfg(test)]
mod research_tests;
mod search_config;
mod window_host;

use input_geometry::{request_focused_input_geometry, InputGeometryProducer};
use native_platform::NativePlatformState;
use tauri::{tray::TrayIconBuilder, Manager, RunEvent, WindowEvent};
use window_host::{WindowHost, HOME_WINDOW_LABEL};

const MAIN_TRAY_ID: &str = "main-tray";
const MAIN_TRAY_TOOLTIP: &str = "线条小狗";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WindowStyleNormalizationStage {
    HwndUnavailable,
    ReadStyleFailed,
    ReadExstyleFailed,
    SetStyleFailed,
    SetExstyleFailed,
    FrameChangeFailed,
    StyleReadbackFailed,
    ExstyleReadbackFailed,
    RequiredStyleMissing,
    RequiredExstyleMissing,
    #[cfg(not(windows))]
    CoreCallFailed,
}

impl WindowStyleNormalizationStage {
    #[cfg(test)]
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::HwndUnavailable => "hwnd_unavailable",
            Self::ReadStyleFailed => "read_style_failed",
            Self::ReadExstyleFailed => "read_exstyle_failed",
            Self::SetStyleFailed => "set_style_failed",
            Self::SetExstyleFailed => "set_exstyle_failed",
            Self::FrameChangeFailed => "frame_change_failed",
            Self::StyleReadbackFailed => "style_readback_failed",
            Self::ExstyleReadbackFailed => "exstyle_readback_failed",
            Self::RequiredStyleMissing => "required_style_missing",
            Self::RequiredExstyleMissing => "required_exstyle_missing",
            #[cfg(not(windows))]
            Self::CoreCallFailed => "core_call_failed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WindowStyleNormalizationDiagnostic {
    stage: WindowStyleNormalizationStage,
    pre_style: u32,
    pre_exstyle: u32,
    post_style: u32,
    post_exstyle: u32,
    last_error: u32,
}

impl WindowStyleNormalizationDiagnostic {
    pub(crate) const fn new(stage: WindowStyleNormalizationStage) -> Self {
        Self {
            stage,
            pre_style: 0,
            pre_exstyle: 0,
            post_style: 0,
            post_exstyle: 0,
            last_error: 0,
        }
    }

    pub(crate) const fn with_failure(
        mut self,
        stage: WindowStyleNormalizationStage,
        last_error: u32,
    ) -> Self {
        self.stage = stage;
        self.last_error = last_error;
        self
    }

    #[cfg(test)]
    pub(crate) fn compact(self) -> String {
        format!(
            "stage={};pre=0x{:08X}/0x{:08X};post=0x{:08X}/0x{:08X};last_error=0x{:08X}",
            self.stage.as_str(),
            self.pre_style,
            self.pre_exstyle,
            self.post_style,
            self.post_exstyle,
            self.last_error,
        )
    }
}

#[cfg(windows)]
pub(crate) mod windows_window_style {
    use std::ffi::c_void;

    use super::{WindowStyleNormalizationDiagnostic, WindowStyleNormalizationStage};

    const GWL_STYLE: i32 = -16;
    const GWL_EXSTYLE: i32 = -20;
    const WS_CAPTION: u32 = 0x00C0_0000;
    const WS_THICKFRAME: u32 = 0x0004_0000;
    const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
    const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    const WS_EX_APPWINDOW: u32 = 0x0004_0000;
    const WS_EX_LAYERED: u32 = 0x0008_0000;
    #[cfg(test)]
    const WS_EX_NOREDIRECTIONBITMAP: u32 = 0x0020_0000;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    #[cfg(test)]
    const SWP_ASYNCWINDOWPOS: u32 = 0x4000;
    const HWND_TOPMOST: isize = -1;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum NativeZOrderTarget {
        Home,
        Main,
    }

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

    fn normalized_required_extended_style(current: u32, ignore_cursor_events: bool) -> u32 {
        let normalized =
            (current & !(WS_EX_APPWINDOW | WS_EX_TRANSPARENT)) | WS_EX_TOOLWINDOW | WS_EX_LAYERED;

        if ignore_cursor_events {
            normalized | WS_EX_TRANSPARENT
        } else {
            normalized
        }
    }

    fn normalized_window_style(current: u32) -> u32 {
        current & !(WS_CAPTION | WS_THICKFRAME)
    }

    fn has_normalized_window_style(style: u32) -> bool {
        style & (WS_CAPTION | WS_THICKFRAME) == 0
    }

    fn has_normalized_required_extended_style(style: u32, ignore_cursor_events: bool) -> bool {
        let has_required_bits = style & WS_EX_APPWINDOW == 0
            && style & WS_EX_TOOLWINDOW != 0
            && style & WS_EX_LAYERED != 0;
        let has_expected_transparency = (style & WS_EX_TRANSPARENT != 0) == ignore_cursor_events;

        has_required_bits && has_expected_transparency
    }

    fn set_window_pos_checked(
        hwnd: *mut c_void,
        insert_after: *mut c_void,
        flags: u32,
    ) -> Result<(), ()> {
        set_window_pos_with_last_error(hwnd, insert_after, flags).map_err(|_| ())
    }

    fn set_window_pos_with_last_error(
        hwnd: *mut c_void,
        insert_after: *mut c_void,
        flags: u32,
    ) -> Result<(), u32> {
        unsafe {
            SetLastError(0);
            let succeeded = SetWindowPos(hwnd, insert_after, 0, 0, 0, 0, flags);
            let last_error = GetLastError();
            checked_set_window_pos_result(succeeded).map_err(|_| last_error)
        }
    }

    fn synchronous_outer_position_flags() -> u32 {
        // Startup positioning runs on the owning event-loop thread. Do not use
        // SWP_ASYNCWINDOWPOS here: the first frontend desktop_snapshot must not
        // observe the template position before the requested move is applied.
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
    }

    fn set_window_pos_at_with_last_error(
        hwnd: *mut c_void,
        x: i32,
        y: i32,
        flags: u32,
    ) -> Result<(), u32> {
        unsafe {
            SetLastError(0);
            let succeeded = SetWindowPos(hwnd, std::ptr::null_mut(), x, y, 0, 0, flags);
            let last_error = GetLastError();
            checked_set_window_pos_result(succeeded).map_err(|_| last_error)
        }
    }

    fn checked_set_window_pos_result(succeeded: i32) -> Result<(), ()> {
        if succeeded == 0 {
            Err(())
        } else {
            Ok(())
        }
    }

    fn native_z_order_reassertion_targets() -> [NativeZOrderTarget; 2] {
        [NativeZOrderTarget::Home, NativeZOrderTarget::Main]
    }

    fn native_z_order_reassertion_flags() -> u32 {
        SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    }

    fn native_z_order_failure_code(target: NativeZOrderTarget) -> &'static str {
        match target {
            NativeZOrderTarget::Home => "home_z_order_failed",
            NativeZOrderTarget::Main => "main_z_order_failed",
        }
    }

    fn non_activating_show_flags() -> u32 {
        SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW
    }

    fn get_window_long_ptr_checked(hwnd: *mut c_void, index: i32) -> Result<u32, u32> {
        unsafe {
            SetLastError(0);
            let value = GetWindowLongPtrW(hwnd, index);
            let last_error = GetLastError();
            if value == 0 && last_error != 0 {
                return Err(last_error);
            }
            // `GetWindowLongPtrW` is `isize`-wide; a window style must fit in
            // `u32`. Convert instead of truncating so an unexpected high word
            // fails closed rather than silently producing a different style.
            u32::try_from(value).map_err(|_| last_error)
        }
    }

    fn set_window_long_ptr_checked(hwnd: *mut c_void, index: i32, value: u32) -> Result<(), u32> {
        unsafe {
            SetLastError(0);
            let previous = SetWindowLongPtrW(hwnd, index, value as isize);
            let last_error = GetLastError();
            if previous == 0 && last_error != 0 {
                Err(last_error)
            } else {
                Ok(())
            }
        }
    }

    fn normalize<R: tauri::Runtime>(
        window: &tauri::WebviewWindow<R>,
        ignore_cursor_events: bool,
    ) -> Result<(), WindowStyleNormalizationDiagnostic> {
        let hwnd = window
            .hwnd()
            .map_err(|_| {
                WindowStyleNormalizationDiagnostic::new(
                    WindowStyleNormalizationStage::HwndUnavailable,
                )
            })?
            .0;
        let mut diagnostic =
            WindowStyleNormalizationDiagnostic::new(WindowStyleNormalizationStage::HwndUnavailable);

        {
            let current_style =
                get_window_long_ptr_checked(hwnd, GWL_STYLE).map_err(|last_error| {
                    diagnostic
                        .with_failure(WindowStyleNormalizationStage::ReadStyleFailed, last_error)
                })?;
            diagnostic.pre_style = current_style;
            let desired_style = normalized_window_style(current_style);
            let current_extended_style =
                get_window_long_ptr_checked(hwnd, GWL_EXSTYLE).map_err(|last_error| {
                    diagnostic
                        .with_failure(WindowStyleNormalizationStage::ReadExstyleFailed, last_error)
                })?;
            diagnostic.pre_exstyle = current_extended_style;
            let required_extended_style =
                normalized_required_extended_style(current_extended_style, ignore_cursor_events);
            let mut frame_changed = false;

            if desired_style != current_style {
                set_window_long_ptr_checked(hwnd, GWL_STYLE, desired_style).map_err(
                    |last_error| {
                        diagnostic
                            .with_failure(WindowStyleNormalizationStage::SetStyleFailed, last_error)
                    },
                )?;
                frame_changed = true;
            }

            if required_extended_style != current_extended_style {
                set_window_long_ptr_checked(hwnd, GWL_EXSTYLE, required_extended_style).map_err(
                    |last_error| {
                        diagnostic.with_failure(
                            WindowStyleNormalizationStage::SetExstyleFailed,
                            last_error,
                        )
                    },
                )?;
                frame_changed = true;
            }

            if frame_changed {
                let flags =
                    SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED;
                set_window_pos_with_last_error(hwnd, std::ptr::null_mut(), flags).map_err(
                    |last_error| {
                        diagnostic.with_failure(
                            WindowStyleNormalizationStage::FrameChangeFailed,
                            last_error,
                        )
                    },
                )?;
            }

            let applied_style =
                get_window_long_ptr_checked(hwnd, GWL_STYLE).map_err(|last_error| {
                    diagnostic.with_failure(
                        WindowStyleNormalizationStage::StyleReadbackFailed,
                        last_error,
                    )
                })?;
            diagnostic.post_style = applied_style;
            if !has_normalized_window_style(applied_style) {
                return Err(
                    diagnostic.with_failure(WindowStyleNormalizationStage::RequiredStyleMissing, 0)
                );
            }

            let applied_extended_style =
                get_window_long_ptr_checked(hwnd, GWL_EXSTYLE).map_err(|last_error| {
                    diagnostic.with_failure(
                        WindowStyleNormalizationStage::ExstyleReadbackFailed,
                        last_error,
                    )
                })?;
            diagnostic.post_exstyle = applied_extended_style;
            if !has_normalized_required_extended_style(applied_extended_style, ignore_cursor_events)
            {
                return Err(diagnostic
                    .with_failure(WindowStyleNormalizationStage::RequiredExstyleMissing, 0));
            }

            Ok(())
        }
    }

    pub fn apply<R: tauri::Runtime>(
        window: &tauri::WebviewWindow<R>,
        ignore_cursor_events: bool,
    ) -> Result<(), WindowStyleNormalizationDiagnostic> {
        normalize(window, ignore_cursor_events)
    }

    pub fn show_without_activation<R: tauri::Runtime>(
        window: &tauri::WebviewWindow<R>,
    ) -> Result<(), ()> {
        let hwnd = window.hwnd().map_err(|_| ())?.0;
        set_window_pos_checked(hwnd, std::ptr::null_mut(), non_activating_show_flags())
    }

    pub fn set_outer_position_synchronously<R: tauri::Runtime>(
        window: &tauri::WebviewWindow<R>,
        position: tauri::PhysicalPosition<i32>,
    ) -> Result<(), ()> {
        let hwnd = window.hwnd().map_err(|_| ())?.0;
        set_window_pos_at_with_last_error(
            hwnd,
            position.x,
            position.y,
            synchronous_outer_position_flags(),
        )
        .map_err(|_| ())
    }

    pub fn ensure_main_above_home<R: tauri::Runtime>(
        home: &tauri::WebviewWindow<R>,
        main: &tauri::WebviewWindow<R>,
    ) -> Result<(), &'static str> {
        let home_hwnd = home.hwnd().map_err(|_| "home_hwnd_unavailable")?.0;
        let main_hwnd = main.hwnd().map_err(|_| "main_hwnd_unavailable")?.0;
        let topmost = HWND_TOPMOST as *mut c_void;

        for target in native_z_order_reassertion_targets() {
            let hwnd = match target {
                NativeZOrderTarget::Home => home_hwnd,
                NativeZOrderTarget::Main => main_hwnd,
            };
            set_window_pos_with_last_error(hwnd, topmost, native_z_order_reassertion_flags())
                .map_err(|_| native_z_order_failure_code(target))?;
        }

        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn applies_transparent_for_ignored_windows_and_preserves_unrelated_bits() {
            const WS_EX_TOPMOST: u32 = 0x0000_0008;
            const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
            let unrelated_extended_style_bits = WS_EX_TOPMOST | WS_EX_NOACTIVATE | 0x0000_0010;
            let input = unrelated_extended_style_bits | WS_EX_APPWINDOW;

            assert_eq!(
                normalized_required_extended_style(input, true),
                unrelated_extended_style_bits
                    | WS_EX_TOOLWINDOW
                    | WS_EX_LAYERED
                    | WS_EX_TRANSPARENT
            );
        }

        #[test]
        fn clears_transparent_for_interactive_normalization() {
            const WS_EX_TOPMOST: u32 = 0x0000_0008;
            const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
            let unrelated_extended_style_bits = WS_EX_TOPMOST | WS_EX_NOACTIVATE | 0x0000_0010;
            let input = unrelated_extended_style_bits | WS_EX_TRANSPARENT | WS_EX_APPWINDOW;

            assert_eq!(
                normalized_required_extended_style(input, false),
                unrelated_extended_style_bits | WS_EX_TOOLWINDOW | WS_EX_LAYERED
            );
        }

        #[test]
        fn toggles_true_false_true_without_reintroducing_appwindow_or_frame_bits() {
            const WS_EX_TOPMOST: u32 = 0x0000_0008;
            const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
            let initial_extended_style = WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_APPWINDOW;
            let ignored = normalized_required_extended_style(initial_extended_style, true);
            let interactive = normalized_required_extended_style(ignored, false);
            let ignored_again = normalized_required_extended_style(interactive, true);

            assert!(ignored & WS_EX_TRANSPARENT != 0);
            assert!(interactive & WS_EX_TRANSPARENT == 0);
            assert_eq!(ignored_again, ignored);
            assert!(ignored_again & WS_EX_APPWINDOW == 0);
            assert!(ignored_again & WS_EX_TOOLWINDOW != 0);
            assert!(ignored_again & WS_EX_LAYERED != 0);
        }

        #[test]
        fn same_requested_state_is_idempotent() {
            let initial_extended_style = 0x0800_0038 | WS_EX_APPWINDOW;
            let ignored = normalized_required_extended_style(initial_extended_style, true);
            let interactive = normalized_required_extended_style(initial_extended_style, false);

            assert_eq!(normalized_required_extended_style(ignored, true), ignored);
            assert_eq!(
                normalized_required_extended_style(interactive, false),
                interactive
            );
        }

        #[test]
        fn removes_caption_and_size_frame_while_preserving_unrelated_style_bits() {
            let unrelated_window_style_bits = 0x1408_0000;
            let input = unrelated_window_style_bits | 0x00C0_0000 | 0x0004_0000;

            assert_eq!(normalized_window_style(input), unrelated_window_style_bits);
        }

        #[test]
        fn normalized_predicates_never_allow_caption_thickframe_or_appwindow_to_recur() {
            let styled = normalized_window_style(0x1408_0000 | WS_CAPTION | WS_THICKFRAME);

            assert!(has_normalized_window_style(styled));
            assert!(!has_normalized_window_style(styled | WS_CAPTION));
            assert!(!has_normalized_window_style(styled | WS_THICKFRAME));

            for ignore_cursor_events in [true, false] {
                let extended = normalized_required_extended_style(
                    0x0800_0008 | WS_EX_APPWINDOW | WS_EX_TRANSPARENT,
                    ignore_cursor_events,
                );

                assert!(has_normalized_required_extended_style(
                    extended,
                    ignore_cursor_events,
                ));
                assert!(!has_normalized_required_extended_style(
                    extended | WS_EX_APPWINDOW,
                    ignore_cursor_events,
                ));
            }
        }

        #[test]
        fn home_runtime_predicate_allows_missing_no_redirection_bitmap() {
            let required = normalized_required_extended_style(WS_EX_APPWINDOW, true);

            assert_eq!(required & WS_EX_NOREDIRECTIONBITMAP, 0);
            assert!(has_normalized_required_extended_style(required, true));
        }

        #[test]
        fn home_runtime_normalization_preserves_preexisting_no_redirection_bitmap() {
            let normalized = normalized_required_extended_style(
                WS_EX_APPWINDOW | WS_EX_NOREDIRECTIONBITMAP,
                true,
            );

            assert!(normalized & WS_EX_NOREDIRECTIONBITMAP != 0);
            assert!(has_normalized_required_extended_style(normalized, true));
        }

        #[test]
        fn style_normalization_failure_stages_and_compact_format_are_stable() {
            let cases = [
                (
                    WindowStyleNormalizationStage::HwndUnavailable,
                    "hwnd_unavailable",
                ),
                (
                    WindowStyleNormalizationStage::ReadStyleFailed,
                    "read_style_failed",
                ),
                (
                    WindowStyleNormalizationStage::ReadExstyleFailed,
                    "read_exstyle_failed",
                ),
                (
                    WindowStyleNormalizationStage::SetStyleFailed,
                    "set_style_failed",
                ),
                (
                    WindowStyleNormalizationStage::SetExstyleFailed,
                    "set_exstyle_failed",
                ),
                (
                    WindowStyleNormalizationStage::FrameChangeFailed,
                    "frame_change_failed",
                ),
                (
                    WindowStyleNormalizationStage::StyleReadbackFailed,
                    "style_readback_failed",
                ),
                (
                    WindowStyleNormalizationStage::ExstyleReadbackFailed,
                    "exstyle_readback_failed",
                ),
                (
                    WindowStyleNormalizationStage::RequiredStyleMissing,
                    "required_style_missing",
                ),
                (
                    WindowStyleNormalizationStage::RequiredExstyleMissing,
                    "required_exstyle_missing",
                ),
            ];

            for (stage, name) in cases {
                assert_eq!(stage.as_str(), name);
            }

            let diagnostic = WindowStyleNormalizationDiagnostic {
                stage: WindowStyleNormalizationStage::RequiredExstyleMissing,
                pre_style: 0x1408_0000,
                pre_exstyle: 0x0808_00B8,
                post_style: 0x1408_0000,
                post_exstyle: 0x0808_00B8,
                last_error: 0,
            };
            assert_eq!(
                diagnostic.compact(),
                "stage=required_exstyle_missing;pre=0x14080000/0x080800B8;post=0x14080000/0x080800B8;last_error=0x00000000"
            );
        }

        #[test]
        fn required_extended_style_rejects_each_missing_required_bit() {
            let required = normalized_required_extended_style(0, true);

            assert!(has_normalized_required_extended_style(required, true));
            assert!(!has_normalized_required_extended_style(
                required | WS_EX_APPWINDOW,
                true,
            ));
            assert!(!has_normalized_required_extended_style(
                required & !WS_EX_TOOLWINDOW,
                true,
            ));
            assert!(!has_normalized_required_extended_style(
                required & !WS_EX_LAYERED,
                true,
            ));
            assert!(!has_normalized_required_extended_style(
                required & !WS_EX_TRANSPARENT,
                true,
            ));
        }

        #[test]
        fn native_z_order_flags_never_activate_or_move_or_resize() {
            let flags = native_z_order_reassertion_flags();
            assert_eq!(flags, 0x0013);
            assert_eq!(flags & SWP_NOZORDER, 0);
        }

        #[test]
        fn native_z_order_reassertion_places_home_then_main_at_topmost() {
            assert_eq!(
                native_z_order_reassertion_targets(),
                [NativeZOrderTarget::Home, NativeZOrderTarget::Main]
            );
            assert_eq!(HWND_TOPMOST, -1);
        }

        #[test]
        fn native_z_order_reassertion_fails_closed_with_a_stable_window_code() {
            assert_eq!(
                native_z_order_failure_code(NativeZOrderTarget::Home),
                "home_z_order_failed"
            );
            assert_eq!(
                native_z_order_failure_code(NativeZOrderTarget::Main),
                "main_z_order_failed"
            );
            assert_eq!(checked_set_window_pos_result(0), Err(()));
        }

        #[test]
        fn non_activating_main_show_flags_include_show_without_activation_or_z_order_changes() {
            let flags = non_activating_show_flags();

            assert_eq!(flags, 0x0057);
            assert_ne!(flags & SWP_SHOWWINDOW, 0);
            assert_ne!(flags & SWP_NOACTIVATE, 0);
            assert_ne!(flags & SWP_NOZORDER, 0);
            assert_ne!(flags & SWP_NOMOVE, 0);
            assert_ne!(flags & SWP_NOSIZE, 0);
        }

        #[test]
        fn non_activating_main_show_fails_closed_when_the_native_call_fails() {
            assert_eq!(checked_set_window_pos_result(0), Err(()));
            assert_eq!(checked_set_window_pos_result(1), Ok(()));
        }

        #[test]
        fn synchronous_startup_position_does_not_queue_async_reposition() {
            let flags = synchronous_outer_position_flags();

            assert_eq!(flags, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
            assert_ne!(flags & SWP_NOSIZE, 0);
            assert_ne!(flags & SWP_NOZORDER, 0);
            assert_ne!(flags & SWP_NOACTIVATE, 0);
            assert_eq!(flags & SWP_NOMOVE, 0);
            assert_eq!(flags & SWP_ASYNCWINDOWPOS, 0);
        }
    }
}

/// Stable error code surfaced to the frontend when click-through
/// normalization fails. Kept next to the platform forks below so every entry
/// point reports the same code instead of re-deriving it.
#[cfg(windows)]
pub(crate) const CLICK_THROUGH_FAILURE_CODE: &str = "windows_style_normalization_failed";
#[cfg(not(windows))]
pub(crate) const CLICK_THROUGH_FAILURE_CODE: &str = "set_ignore_cursor_events_failed";

#[cfg(windows)]
pub(crate) fn apply_click_through<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    ignore_cursor_events: bool,
) -> Result<(), WindowStyleNormalizationDiagnostic> {
    windows_window_style::apply(window, ignore_cursor_events)
}

#[cfg(not(windows))]
pub(crate) fn apply_click_through<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    ignore_cursor_events: bool,
) -> Result<(), WindowStyleNormalizationDiagnostic> {
    window
        .set_ignore_cursor_events(ignore_cursor_events)
        .map_err(|_| {
            WindowStyleNormalizationDiagnostic::new(WindowStyleNormalizationStage::CoreCallFailed)
        })
}

#[cfg(windows)]
pub(crate) fn show_surface_without_activation<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), ()> {
    windows_window_style::show_without_activation(window)
}

#[cfg(not(windows))]
pub(crate) fn show_surface_without_activation<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), ()> {
    window.show().map_err(|_| ())
}

#[tauri::command(rename_all = "camelCase")]
async fn focused_input_snapshot(
    producer: tauri::State<'_, InputGeometryProducer>,
    request_started_at_monotonic: f64,
    request_revision: u64,
    monitor_revision: u64,
    dispose_generation: u64,
) -> Result<serde_json::Value, ()> {
    request_focused_input_geometry(
        producer,
        request_started_at_monotonic,
        request_revision,
        monitor_revision,
        dispose_generation,
    )
    .await
}

fn handle_quit_tray_menu_event(app: &tauri::AppHandle) {
    app.state::<model_transport::Requests>().cancel(app);
    app.state::<diagnostics::Diagnostics>()
        .record("exit", serde_json::json!({}));
    app.state::<WindowHost>().mark_explicit_exit_requested();
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(InputGeometryProducer::new())
        .manage(NativePlatformState::new())
        .manage(WindowHost::new())
        .manage(model_transport::Requests::default())
        .on_menu_event(|app, event| {
            pet_menu::dispatch(app, event.id.as_ref());
        })
        .invoke_handler(tauri::generate_handler![
            pet_menu::pet_control_state,
            chat_window::chat_open,
            chat_window::chat_context_menu,
            model_config::model_configs,
            model_config::model_save,
            model_config::model_check,
            model_config::model_catalog,
            model_transport::chat_start,
            model_transport::chat_cancel,
            search_config::search_config,
            search_config::search_save,
            search_config::search_test,
            location_weather::location_get,
            location_weather::location_search,
            location_weather::location_save,
            location_weather::location_device,
            search_config::report_export,
            research::research_forget,
            diagnostics::diagnostic_event,
            diagnostics::diagnostic_status,
            diagnostics::diagnostic_export,
            native_platform::desktop_snapshot,
            focused_input_snapshot,
            native_platform::pointer_snapshot,
            native_platform::set_overlay_frame,
            native_platform::set_overlay_position,
            native_platform::set_overlay_visibility,
            native_platform::set_overlay_opacity,
            native_platform::set_window_click_through,
            native_platform::begin_native_drag,
            native_platform::surface_ready,
            native_platform::exit_application
        ])
        .setup(|app| {
            let data_root = app.path().app_local_data_dir()?;
            app.manage(diagnostics::Diagnostics::new(data_root.join("diagnostics")));
            app.manage(search_config::SearchConfig::new(data_root.clone()));
            app.manage(location_weather::Locations::new(data_root.clone()));
            app.manage(research::ResearchCache::default());
            app.manage(model_config::ModelConfig::new(data_root));
            app.state::<diagnostics::Diagnostics>()
                .record("startup", serde_json::json!({}));
            // WebView IPC can arrive while bootstrap creates the other window.
            // Its first control-state publication must already have a menu.
            let menu = pet_menu::build(app.handle())?;
            app.manage(pet_menu::PetMenu(menu.clone()));
            app.state::<WindowHost>()
                .bootstrap(app)
                .map_err(std::io::Error::other)?;

            let tray_icon = tauri::image::Image::new_owned(
                include_bytes!("../icons/linedog-tray.rgba").to_vec(),
                64,
                64,
            );
            TrayIconBuilder::with_id(MAIN_TRAY_ID)
                .tooltip(MAIN_TRAY_TOOLTIP)
                .icon(tray_icon)
                .menu(&menu)
                .build(app)?;

            // Explicit command-line entry also permits exercising the normal chat
            // window on desktops whose tool windows are omitted by UI automation.
            if std::env::args().any(|arg| arg == "--chat") {
                chat_window::open(app.handle(), "chat").map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building LineDog application");

    app.run(|app, event| match event {
        RunEvent::WindowEvent {
            ref label,
            event: WindowEvent::CloseRequested { ref api, .. },
            ..
        } if label == "chat" => {
            api.prevent_close();
            app.state::<model_transport::Requests>().cancel(app);
            if let Some(window) = app.get_webview_window("chat") {
                let _ = window.hide();
            }
            app.state::<diagnostics::Diagnostics>()
                .record("window_close", serde_json::json!({"surface":"chat"}));
        }
        RunEvent::WindowEvent { label, event, .. }
            if label == HOME_WINDOW_LABEL && matches!(event, WindowEvent::Destroyed) =>
        {
            app.state::<WindowHost>().mark_home_destroyed();
        }
        _ => {}
    })
}
