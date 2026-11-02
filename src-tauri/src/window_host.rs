use std::{
    io::Write,
    sync::{Mutex, MutexGuard},
};

use tauri::{
    App, AppHandle, Manager, PhysicalPosition, Runtime, WebviewWindow, WebviewWindowBuilder,
};

use crate::{
    apply_click_through, native_platform::apply_window_opacity, show_surface_without_activation,
};

pub(crate) const HOME_WINDOW_LABEL: &str = "home";
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
pub(crate) const HOME_STARTUP_DIAGNOSTIC_MARKER: &str = "LINEDOG_HOME_STARTUP_V1";

const HOME_RIGHT_MARGIN_LOGICAL: f64 = 24.0;
const NATIVE_PET_FOOT_ANCHOR_LOGICAL_PX: f64 = 140.0;
const HOME_BOTTOM_MARGIN_LOGICAL: f64 = 0.0;

/// A surface that can report readiness. Parsing once up front removes the
/// repeated label matching that previously required an `unreachable!()` arm.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostSurface {
    Main,
    Home,
}

impl HostSurface {
    fn parse(label: &str) -> Option<Self> {
        match label {
            MAIN_WINDOW_LABEL => Some(Self::Main),
            HOME_WINDOW_LABEL => Some(Self::Home),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HomeStartupDiagnosticPhase {
    Bootstrap,
    Lifecycle,
}

impl HomeStartupDiagnosticPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Bootstrap => "BOOTSTRAP",
            Self::Lifecycle => "LIFECYCLE",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HomeStartupDiagnosticResult {
    Shown,
    GroundOnly,
}

impl HomeStartupDiagnosticResult {
    fn as_str(self) -> &'static str {
        match self {
            Self::Shown => "SHOWN",
            Self::GroundOnly => "GROUND_ONLY",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HomeStartupDiagnosticReason {
    None,
    HomeNativeWindowDestroyed,
}

impl HomeStartupDiagnosticReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "NONE",
            Self::HomeNativeWindowDestroyed => "HOME_NATIVE_WINDOW_DESTROYED",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct HomeStartupDiagnosticRecord {
    phase: HomeStartupDiagnosticPhase,
    result: HomeStartupDiagnosticResult,
    reason: HomeStartupDiagnosticReason,
}

fn format_home_startup_diagnostic(record: HomeStartupDiagnosticRecord) -> String {
    format!(
        "{} phase={} result={} reason={}",
        HOME_STARTUP_DIAGNOSTIC_MARKER,
        record.phase.as_str(),
        record.result.as_str(),
        record.reason.as_str(),
    )
}

fn write_home_startup_diagnostic(output: &mut impl Write, record: HomeStartupDiagnosticRecord) {
    let _ = writeln!(output, "{}", format_home_startup_diagnostic(record));
    let _ = output.flush();
}

fn emit_home_startup_diagnostic(record: HomeStartupDiagnosticRecord) {
    let stderr = std::io::stderr();
    let mut stderr = stderr.lock();
    write_home_startup_diagnostic(&mut stderr, record);
}

#[derive(Debug, Default)]
struct WindowHostState {
    main_surface_ready: bool,
    home_surface_ready: bool,
    home_was_shown: bool,
    startup_diagnostic_emitted: bool,
    lifecycle_diagnostic_emitted: bool,
    explicit_exit_requested: bool,
}

pub(crate) struct WindowHost {
    state: Mutex<WindowHostState>,
}

impl WindowHost {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(WindowHostState::default()),
        }
    }

    fn state(&self) -> MutexGuard<'_, WindowHostState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn bootstrap(&self, app: &App) -> Result<(), &'static str> {
        // Main must exist before Home is created: Home's frontend bootstrap calls
        // `desktopSnapshot()`, which resolves the Main window to read the monitor
        // and WorkArea. Creating Home first lets its WebView fail closed with
        // `main_window_unavailable` before Main is ever built, which permanently
        // strands Home (no surface_ready, no startup SHOWN marker).
        let main = build_template_window(app, MAIN_WINDOW_LABEL)?;
        apply_click_through(&main, true).map_err(|_| "main_style_normalization_failed")?;

        let home = build_template_window(app, HOME_WINDOW_LABEL)?;
        apply_click_through(&home, true).map_err(|_| "home_style_normalization_failed")?;

        self.position_windows(&home, &main)?;
        reassert_main_above_home(&home, &main)?;
        show_surface_without_activation(&main).map_err(|_| "main_show_failed")?;

        // Home is shown without activation but fully transparent (alpha 0) at
        // bootstrap. A `visible: false` WebView2 window never paints, which
        // pauses requestAnimationFrame and image decode — deadlocking the TS
        // Home bootstrap's "decode + one paint frame before surface_ready"
        // contract. Showing the HWND at alpha 0 lets the compositor run while
        // remaining invisible to the user until surface_ready raises opacity.
        #[cfg(windows)]
        {
            show_surface_without_activation(&home).map_err(|_| "home_show_failed")?;
            apply_window_opacity(&home, 0.0).map_err(|_| "home_opacity_failed")?;
        }
        #[cfg(not(windows))]
        {
            let _ = &home;
        }
        Ok(())
    }

    pub(crate) fn surface_ready<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        surface: &str,
    ) -> Result<bool, String> {
        let Some(target) = HostSurface::parse(surface) else {
            return Err("surface_invalid".to_owned());
        };
        if self.is_ready(target) {
            return Ok(true);
        }

        // Everything below touches Win32/OS APIs (several synchronous
        // SetWindowPos / SetLayeredWindowAttributes calls) and must therefore run
        // without the state mutex held, otherwise every other WindowHost reader
        // blocks for the whole duration of the native round-trips.
        if target == HostSurface::Home {
            let home = app
                .get_webview_window(HOME_WINDOW_LABEL)
                .ok_or_else(|| "home_window_unavailable".to_owned())?;
            let main = app
                .get_webview_window(MAIN_WINDOW_LABEL)
                .ok_or_else(|| "main_window_unavailable".to_owned())?;

            if apply_click_through(&home, true).is_err() {
                let _ = home.hide();
                return Err("home_style_normalization_failed".to_owned());
            }
            if show_surface_without_activation(&home).is_err() {
                let _ = home.hide();
                return Err("home_show_failed".to_owned());
            }
            #[cfg(windows)]
            if apply_window_opacity(&home, 1.0).is_err() {
                let _ = home.hide();
                return Err("home_opacity_failed".to_owned());
            }
            if reassert_main_above_home(&home, &main).is_err() {
                let _ = home.hide();
                return Err("home_z_order_failed".to_owned());
            }
        }

        // Commit under a short critical section. The readiness flag is re-read
        // here because the unlocked OS work above may have overlapped with a
        // concurrent caller that already committed this same surface.
        let diagnostic = {
            let mut state = self.state();
            if Self::is_ready_locked(&state, target) {
                return Ok(true);
            }
            match target {
                HostSurface::Main => state.main_surface_ready = true,
                HostSurface::Home => {
                    state.home_was_shown = true;
                    state.home_surface_ready = true;
                }
            }
            if target == HostSurface::Home && !state.startup_diagnostic_emitted {
                state.startup_diagnostic_emitted = true;
                Some(HomeStartupDiagnosticRecord {
                    phase: HomeStartupDiagnosticPhase::Bootstrap,
                    result: HomeStartupDiagnosticResult::Shown,
                    reason: HomeStartupDiagnosticReason::None,
                })
            } else {
                None
            }
        };

        if let Some(diagnostic) = diagnostic {
            emit_home_startup_diagnostic(diagnostic);
        }
        Ok(false)
    }

    fn is_ready(&self, target: HostSurface) -> bool {
        Self::is_ready_locked(&self.state(), target)
    }

    pub(crate) fn home_is_ready(&self) -> bool {
        self.is_ready(HostSurface::Home)
    }

    fn is_ready_locked(state: &WindowHostState, target: HostSurface) -> bool {
        match target {
            HostSurface::Main => state.main_surface_ready,
            HostSurface::Home => state.home_surface_ready,
        }
    }

    pub(crate) fn mark_explicit_exit_requested(&self) {
        self.state().explicit_exit_requested = true;
    }

    pub(crate) fn mark_home_destroyed(&self) {
        let diagnostic = {
            let mut state = self.state();
            if state.explicit_exit_requested
                || !state.home_was_shown
                || state.lifecycle_diagnostic_emitted
            {
                None
            } else {
                state.home_was_shown = false;
                state.lifecycle_diagnostic_emitted = true;
                Some(HomeStartupDiagnosticRecord {
                    phase: HomeStartupDiagnosticPhase::Lifecycle,
                    result: HomeStartupDiagnosticResult::GroundOnly,
                    reason: HomeStartupDiagnosticReason::HomeNativeWindowDestroyed,
                })
            }
        };

        if let Some(diagnostic) = diagnostic {
            emit_home_startup_diagnostic(diagnostic);
        }
    }

    fn position_windows<R: Runtime>(
        &self,
        home: &WebviewWindow<R>,
        main: &WebviewWindow<R>,
    ) -> Result<(), &'static str> {
        let monitor = main
            .primary_monitor()
            .map_err(|_| "primary_monitor_unavailable")?
            .ok_or("primary_monitor_unavailable")?;
        let work_area = monitor.work_area();
        let scale_factor = monitor.scale_factor();
        if !scale_factor.is_finite() || scale_factor <= 0.0 {
            return Err("primary_monitor_scale_invalid");
        }
        let work_area = WorkAreaPhysical {
            x: work_area.position.x,
            y: work_area.position.y,
            width: work_area.size.width,
            height: work_area.size.height,
        };

        let main_size = main.outer_size().map_err(|_| "main_size_unavailable")?;
        let (main_x, main_y) =
            native_main_surface_top_left(work_area, scale_factor, main_size.width)?;
        let main_position = PhysicalPosition::new(main_x, main_y);
        // `bootstrap` is called from Tauri's setup hook on the runtime event-loop
        // thread. Keep startup positioning on that owning thread so the Windows
        // synchronous SetWindowPos path cannot be converted into cross-thread work.
        set_window_outer_position(&main, main_position).map_err(|_| "main_position_failed")?;
        let actual_main_position = main
            .outer_position()
            .map_err(|_| "main_position_readback_failed")?;
        if actual_main_position != main_position {
            return Err("main_position_mismatch");
        }

        let home_size = home.outer_size().map_err(|_| "home_size_unavailable")?;
        let (home_x, home_y) = native_home_surface_top_left(
            work_area,
            scale_factor,
            home_size.width,
            home_size.height,
        )?;
        let home_position = PhysicalPosition::new(home_x, home_y);
        set_window_outer_position(&home, home_position).map_err(|_| "home_position_failed")?;
        let actual_home_position = home
            .outer_position()
            .map_err(|_| "home_position_readback_failed")?;
        if actual_home_position != home_position {
            return Err("home_position_mismatch");
        }
        Ok(())
    }
}

fn set_window_outer_position<R: Runtime>(
    window: &WebviewWindow<R>,
    position: PhysicalPosition<i32>,
) -> Result<(), ()> {
    #[cfg(windows)]
    {
        crate::windows_window_style::set_outer_position_synchronously(window, position)
    }

    #[cfg(not(windows))]
    {
        window.set_position(position).map_err(|_| ())
    }
}

fn build_template_window<R: Runtime, M: Manager<R>>(
    manager: &M,
    label: &str,
) -> Result<WebviewWindow<R>, &'static str> {
    let config = manager
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == label)
        .ok_or("window_template_missing")?;
    WebviewWindowBuilder::from_config(manager, config)
        .map_err(|_| "window_template_invalid")?
        .build()
        .map_err(|_| "window_create_failed")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WorkAreaPhysical {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn round_native_physical(value: f64) -> Result<i32, &'static str> {
    if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err("physical_position_invalid");
    }
    Ok(value.round() as i32)
}

fn native_main_surface_top_left(
    work_area: WorkAreaPhysical,
    scale_factor: f64,
    main_width: u32,
) -> Result<(i32, i32), &'static str> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 || main_width == 0 {
        return Err("main_geometry_invalid");
    }

    let main_x =
        f64::from(work_area.x) + (f64::from(work_area.width) - f64::from(main_width)) / 2.0;
    let main_y = native_main_ground_top_y(work_area, scale_factor)?;
    Ok((round_native_physical(main_x)?, main_y))
}

fn native_main_ground_top_y(
    work_area: WorkAreaPhysical,
    scale_factor: f64,
) -> Result<i32, &'static str> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return Err("primary_monitor_scale_invalid");
    }

    let work_area_bottom = f64::from(work_area.y) + f64::from(work_area.height);
    let foot_anchor_physical = NATIVE_PET_FOOT_ANCHOR_LOGICAL_PX * scale_factor;
    round_native_physical(work_area_bottom - foot_anchor_physical)
}

fn native_home_surface_top_left(
    work_area: WorkAreaPhysical,
    scale_factor: f64,
    home_width: u32,
    home_height: u32,
) -> Result<(i32, i32), &'static str> {
    if !scale_factor.is_finite()
        || scale_factor <= 0.0
        || work_area.width == 0
        || work_area.height == 0
        || home_width == 0
        || home_height == 0
    {
        return Err("home_geometry_invalid");
    }

    let right_margin_physical = HOME_RIGHT_MARGIN_LOGICAL * scale_factor;
    let bottom_margin_physical = HOME_BOTTOM_MARGIN_LOGICAL * scale_factor;
    let x = f64::from(work_area.x) + f64::from(work_area.width)
        - right_margin_physical
        - f64::from(home_width);
    let y = f64::from(work_area.y) + f64::from(work_area.height)
        - bottom_margin_physical
        - f64::from(home_height);
    Ok((round_native_physical(x)?, round_native_physical(y)?))
}

fn reassert_main_above_home<R: Runtime>(
    home: &WebviewWindow<R>,
    main: &WebviewWindow<R>,
) -> Result<(), &'static str> {
    #[cfg(windows)]
    {
        crate::windows_window_style::ensure_main_above_home(home, main)
    }

    #[cfg(not(windows))]
    {
        let _ = (home, main);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_diagnostic_is_stable_and_contains_no_identity_data() {
        let line = format_home_startup_diagnostic(HomeStartupDiagnosticRecord {
            phase: HomeStartupDiagnosticPhase::Bootstrap,
            result: HomeStartupDiagnosticResult::Shown,
            reason: HomeStartupDiagnosticReason::None,
        });

        assert_eq!(
            line,
            "LINEDOG_HOME_STARTUP_V1 phase=BOOTSTRAP result=SHOWN reason=NONE"
        );
        assert!(!line.contains("path"));
        assert!(!line.contains("PID"));
        assert!(!line.contains("HWND"));
    }

    #[test]
    fn lifecycle_diagnostic_is_stable_and_redacted() {
        let line = format_home_startup_diagnostic(HomeStartupDiagnosticRecord {
            phase: HomeStartupDiagnosticPhase::Lifecycle,
            result: HomeStartupDiagnosticResult::GroundOnly,
            reason: HomeStartupDiagnosticReason::HomeNativeWindowDestroyed,
        });

        assert_eq!(
            line,
            "LINEDOG_HOME_STARTUP_V1 phase=LIFECYCLE result=GROUND_ONLY reason=HOME_NATIVE_WINDOW_DESTROYED"
        );
        assert!(!line.contains("path"));
        assert!(!line.contains("SID"));
    }

    #[test]
    fn native_main_ground_top_tracks_the_foot_anchor_across_dpi_scales() {
        let work_area = WorkAreaPhysical {
            x: 0,
            y: 0,
            width: 1_600,
            height: 1_000,
        };
        let cases = [(1.0, 860), (1.25, 825), (1.5, 790), (1.75, 755), (2.0, 720)];

        for (scale_factor, expected_top) in cases {
            assert_eq!(
                native_main_ground_top_y(work_area, scale_factor),
                Ok(expected_top),
                "scale factor {scale_factor}"
            );
        }
    }

    #[test]
    fn native_main_surface_top_left_centers_and_anchors_to_workarea() {
        let work_area = WorkAreaPhysical {
            x: 0,
            y: 0,
            width: 1_600,
            height: 1_000,
        };

        assert_eq!(
            native_main_surface_top_left(work_area, 1.0, 160),
            Ok((720, 860))
        );
        assert_eq!(
            native_main_surface_top_left(work_area, 2.0, 320),
            Ok((640, 720))
        );
    }

    #[test]
    fn native_main_geometry_rejects_invalid_scale_or_empty_width() {
        let work_area = WorkAreaPhysical {
            x: 0,
            y: 0,
            width: 1_920,
            height: 1_080,
        };

        assert_eq!(
            native_main_surface_top_left(work_area, 0.0, 160),
            Err("main_geometry_invalid")
        );
        assert_eq!(
            native_main_surface_top_left(work_area, 1.0, 0),
            Err("main_geometry_invalid")
        );
    }

    #[test]
    fn native_home_surface_top_left_stays_above_workarea_bottom() {
        let position = native_home_surface_top_left(
            WorkAreaPhysical {
                x: 0,
                y: 0,
                width: 1_920,
                height: 1_080,
            },
            1.0,
            256,
            256,
        )
        .expect("valid Home geometry");

        assert_eq!(position, (1_640, 824));
        assert_eq!(position.1 + 256, 1_080);
    }

    #[test]
    fn native_home_bottom_stays_on_workarea_bottom_across_dpi() {
        for scale_factor in [1.0, 1.25, 1.5, 1.75, 2.0] {
            let work_area = WorkAreaPhysical {
                x: -2_400,
                y: -120,
                width: 2_400,
                height: 1_350,
            };
            let home_size = (256.0_f64 * scale_factor).round() as u32;
            let (_, top_y) =
                native_home_surface_top_left(work_area, scale_factor, home_size, home_size)
                    .expect("valid scaled Home geometry");
            let home_bottom = f64::from(top_y) + f64::from(home_size);
            let work_area_bottom = f64::from(work_area.y) + f64::from(work_area.height);

            assert!(
                (home_bottom - work_area_bottom).abs() <= 0.5,
                "scale factor {scale_factor}: Home bottom {home_bottom}, WorkArea bottom {work_area_bottom}",
            );
        }
    }

    #[test]
    fn native_geometry_rejects_invalid_scale_or_empty_home() {
        let work_area = WorkAreaPhysical {
            x: 0,
            y: 0,
            width: 1_920,
            height: 1_080,
        };

        assert_eq!(
            native_home_surface_top_left(work_area, 0.0, 256, 256),
            Err("home_geometry_invalid")
        );
        assert_eq!(
            native_home_surface_top_left(work_area, 1.0, 0, 256),
            Err("home_geometry_invalid")
        );
    }
}
