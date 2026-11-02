use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use serde_json::{json, Value};
use tauri::{LogicalPosition, LogicalSize, Manager, Runtime};

use crate::window_host::{WindowHost, HOME_WINDOW_LABEL, MAIN_WINDOW_LABEL};

pub(crate) const NATIVE_PLATFORM_PROTOCOL_VERSION: &str = "linedog.native/v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeSurface {
    Main,
    Home,
}

impl NativeSurface {
    fn parse(label: &str) -> Result<Self, String> {
        match label {
            MAIN_WINDOW_LABEL => Ok(Self::Main),
            HOME_WINDOW_LABEL => Ok(Self::Home),
            _ => Err("surface_invalid".to_owned()),
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Main => MAIN_WINDOW_LABEL,
            Self::Home => HOME_WINDOW_LABEL,
        }
    }
}

pub(crate) struct NativePlatformState {
    started_at: Instant,
    snapshot_revision: AtomicU64,
}

impl NativePlatformState {
    pub(crate) fn new() -> Self {
        Self {
            started_at: Instant::now(),
            snapshot_revision: AtomicU64::new(0),
        }
    }

    fn next_snapshot_revision(&self) -> u64 {
        self.snapshot_revision.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn captured_at_monotonic_ms(&self) -> u128 {
        self.started_at.elapsed().as_millis()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct LogicalPoint {
    x: f64,
    y: f64,
}

impl LogicalPoint {
    fn json(self) -> Value {
        json!({
            "x": self.x,
            "y": self.y,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct LogicalRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl LogicalRect {
    fn json(self) -> Value {
        json!({
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        })
    }
}

fn logical_point_from_physical(x: f64, y: f64, scale_factor: f64) -> Result<LogicalPoint, String> {
    validate_scale_factor(scale_factor)?;
    let point = LogicalPoint {
        x: x / scale_factor,
        y: y / scale_factor,
    };
    if point.x.is_finite() && point.y.is_finite() {
        Ok(point)
    } else {
        Err("logical_coordinate_invalid".to_owned())
    }
}

fn logical_rect_from_physical(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
) -> Result<LogicalRect, String> {
    validate_scale_factor(scale_factor)?;
    let rect = LogicalRect {
        x: f64::from(x) / scale_factor,
        y: f64::from(y) / scale_factor,
        width: f64::from(width) / scale_factor,
        height: f64::from(height) / scale_factor,
    };
    if [rect.x, rect.y, rect.width, rect.height]
        .into_iter()
        .all(f64::is_finite)
    {
        Ok(rect)
    } else {
        Err("logical_coordinate_invalid".to_owned())
    }
}

fn validate_scale_factor(scale_factor: f64) -> Result<(), String> {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        Ok(())
    } else {
        Err("scale_factor_invalid".to_owned())
    }
}

fn validate_position(x: f64, y: f64) -> Result<(), String> {
    if [x, y].into_iter().all(f64::is_finite) {
        Ok(())
    } else {
        Err("overlay_position_invalid".to_owned())
    }
}

fn validate_frame(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if [x, y, width, height].into_iter().all(f64::is_finite) && width > 0.0 && height > 0.0 {
        Ok(())
    } else {
        Err("overlay_frame_invalid".to_owned())
    }
}

fn validate_opacity(opacity: f64) -> Result<(), String> {
    if opacity.is_finite() && (0.0..=1.0).contains(&opacity) {
        Ok(())
    } else {
        Err("overlay_opacity_invalid".to_owned())
    }
}

fn opacity_to_alpha(opacity: f64) -> u8 {
    (opacity * f64::from(u8::MAX)).round() as u8
}

fn window_for<R: Runtime>(
    app: &tauri::AppHandle<R>,
    surface: NativeSurface,
) -> Result<tauri::WebviewWindow<R>, String> {
    app.get_webview_window(surface.as_str())
        .ok_or_else(|| format!("{}_window_unavailable", surface.as_str()))
}

fn create_monitor_identity(monitor: &tauri::Monitor) -> String {
    let work_area = monitor.work_area();
    format!(
        "{}|{}:{}:{}:{}|scale={}",
        monitor.name().map(String::as_str).unwrap_or("<unnamed>"),
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
        monitor.scale_factor(),
    )
}

fn select_monitor_index(
    current: Option<&str>,
    primary: Option<&str>,
    available: &[String],
) -> Option<usize> {
    current
        .and_then(|id| available.iter().position(|candidate| candidate == id))
        .or_else(|| primary.and_then(|id| available.iter().position(|candidate| candidate == id)))
}

#[cfg(test)]
mod recovery_monitor_tests {
    use super::select_monitor_index;
    #[test]
    fn valid_current_precedes_primary_and_missing_current_uses_primary() {
        let available = vec!["primary".to_owned(), "negative-secondary".to_owned()];
        assert_eq!(
            select_monitor_index(Some("negative-secondary"), Some("primary"), &available),
            Some(1)
        );
        assert_eq!(
            select_monitor_index(Some("removed"), Some("primary"), &available),
            Some(0)
        );
        assert_eq!(
            select_monitor_index(None, Some("primary"), &available),
            Some(0)
        );
    }
    #[test]
    fn no_valid_monitor_does_not_invent_a_destination() {
        assert_eq!(
            select_monitor_index(Some("removed"), Some("missing"), &[]),
            None
        );
    }
}

#[tauri::command]
pub(crate) async fn desktop_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    // A WebView can invoke us during setup's nested window creation. Capture
    // on the event loop after setup has finished positioning both surfaces.
    // Returning temporary template coordinates would let Runtime overwrite
    // the correct native placement with those old startup coordinates.
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.try_send(capture_desktop_snapshot(&handle));
    })
    .map_err(|_| "desktop_snapshot_dispatch_failed".to_owned())?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "desktop_snapshot_cancelled".to_owned())?
}

fn capture_desktop_snapshot(app: &tauri::AppHandle) -> Result<Value, String> {
    let platform = app.state::<NativePlatformState>();
    let host = app.state::<WindowHost>();
    let revision = platform.next_snapshot_revision();
    let window = window_for(&app, NativeSurface::Main)?;
    let monitors = window
        .available_monitors()
        .map_err(|_| "monitors_unavailable".to_owned())?;
    let current = window
        .current_monitor()
        .map_err(|_| "current_monitor_unavailable".to_owned())?;
    let primary = window
        .primary_monitor()
        .map_err(|_| "primary_monitor_unavailable".to_owned())?;
    let identities: Vec<String> = monitors.iter().map(create_monitor_identity).collect();
    let current_id = current.as_ref().map(create_monitor_identity);
    let primary_id = primary.as_ref().map(create_monitor_identity);
    let index = select_monitor_index(current_id.as_deref(), primary_id.as_deref(), &identities)
        .ok_or_else(|| "current_monitor_unavailable".to_owned())?;
    let monitor = &monitors[index];
    let monitor_scale_factor = monitor.scale_factor();
    let window_scale_factor = window
        .scale_factor()
        .map_err(|_| "window_scale_factor_unavailable".to_owned())?;
    let work_area = monitor.work_area();
    let logical_work_area = logical_rect_from_physical(
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
        window_scale_factor,
    )?;
    let outer_position = window
        .outer_position()
        .map_err(|_| "window_outer_position_unavailable".to_owned())?;
    let logical_window_position = logical_point_from_physical(
        f64::from(outer_position.x),
        f64::from(outer_position.y),
        window_scale_factor,
    )?;

    Ok(json!({
        "protocolVersion": NATIVE_PLATFORM_PROTOCOL_VERSION,
        "snapshotRevision": revision,
        "capturedAtMonotonicMs": platform.captured_at_monotonic_ms(),
        "currentMonitorId": create_monitor_identity(&monitor),
        "workArea": logical_work_area.json(),
        "windowPosition": {
            "space": "WINDOW_TOP_LEFT_LOGICAL",
            "x": logical_window_position.x,
            "y": logical_window_position.y,
        },
        "monitorScaleFactor": monitor_scale_factor,
        "windowScaleFactor": window_scale_factor,
        "homeWindow": home_window_snapshot(&app, &host, window_scale_factor).ok(),
    }))
}

fn home_window_snapshot<R: Runtime>(
    app: &tauri::AppHandle<R>,
    host: &WindowHost,
    main_scale: f64,
) -> Result<Value, String> {
    let home = window_for(app, NativeSurface::Home)?;
    let monitor = home
        .current_monitor()
        .map_err(|_| "home_monitor_unavailable")?
        .ok_or("home_monitor_unavailable")?;
    let position = home
        .outer_position()
        .map_err(|_| "home_position_unavailable")?;
    let size = home.outer_size().map_err(|_| "home_size_unavailable")?;
    let scale = home.scale_factor().map_err(|_| "home_scale_unavailable")?;
    let rect =
        logical_rect_from_physical(position.x, position.y, size.width, size.height, main_scale)?;
    Ok(json!({
        "ready": host.home_is_ready() && home.is_visible().unwrap_or(false),
        "currentMonitorId": create_monitor_identity(&monitor),
        "windowScaleFactor": scale,
        "rect": rect.json(),
    }))
}

#[tauri::command]
pub(crate) fn pointer_snapshot(
    app: tauri::AppHandle,
    platform: tauri::State<'_, NativePlatformState>,
) -> Result<Value, String> {
    let window = window_for(&app, NativeSurface::Main)?;
    let cursor_position = window
        .cursor_position()
        .map_err(|_| "cursor_position_unavailable".to_owned())?;
    let outer_position = window
        .outer_position()
        .map_err(|_| "window_outer_position_unavailable".to_owned())?;
    let scale_factor = window
        .scale_factor()
        .map_err(|_| "window_scale_factor_unavailable".to_owned())?;
    let cursor = logical_point_from_physical(cursor_position.x, cursor_position.y, scale_factor)?;
    let outer = logical_point_from_physical(
        f64::from(outer_position.x),
        f64::from(outer_position.y),
        scale_factor,
    )?;
    let relative = logical_point_from_physical(
        cursor_position.x - f64::from(outer_position.x),
        cursor_position.y - f64::from(outer_position.y),
        scale_factor,
    )?;

    Ok(json!({
        "protocolVersion": NATIVE_PLATFORM_PROTOCOL_VERSION,
        "snapshotRevision": platform.next_snapshot_revision(),
        "capturedAtMonotonicMs": platform.captured_at_monotonic_ms(),
        "cursorScreenLogical": cursor.json(),
        "windowOuterTopLeftLogical": outer.json(),
        "relativeLogical": relative.json(),
        "scaleFactor": scale_factor,
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn set_overlay_frame(
    app: tauri::AppHandle,
    window_label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    coordinate_scale_factor: Option<f64>,
) -> Result<(), String> {
    validate_frame(x, y, width, height)?;
    let surface = NativeSurface::parse(&window_label)?;
    let window = window_for(&app, surface)?;
    if let Some(scale) = coordinate_scale_factor {
        validate_scale_factor(scale)?;
        validate_frame(x * scale, y * scale, width * scale, height * scale)?;
        window
            .set_position(tauri::PhysicalPosition::new(
                (x * scale).round() as i32,
                (y * scale).round() as i32,
            ))
            .map_err(|_| "set_overlay_frame_failed".to_owned())?;
        return window
            .set_size(tauri::PhysicalSize::new(
                (width * scale).round() as u32,
                (height * scale).round() as u32,
            ))
            .map_err(|_| "set_overlay_frame_failed".to_owned());
    }
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|_| "set_overlay_frame_failed".to_owned())?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|_| "set_overlay_frame_failed".to_owned())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn set_overlay_position(
    app: tauri::AppHandle,
    window_label: String,
    x: f64,
    y: f64,
    coordinate_scale_factor: Option<f64>,
) -> Result<(), String> {
    validate_position(x, y)?;
    let surface = NativeSurface::parse(&window_label)?;
    let window = window_for(&app, surface)?;
    if let Some(scale) = coordinate_scale_factor {
        let physical = physical_position_from_logical(x, y, scale)?;
        return window
            .set_position(physical)
            .map_err(|_| "set_overlay_position_failed".to_owned());
    }
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|_| "set_overlay_position_failed".to_owned())
}

fn physical_position_from_logical(
    x: f64,
    y: f64,
    scale: f64,
) -> Result<tauri::PhysicalPosition<i32>, String> {
    validate_scale_factor(scale)?;
    validate_position(x, y)?;
    let (x, y) = (x * scale, y * scale);
    if !x.is_finite()
        || !y.is_finite()
        || x.round() < f64::from(i32::MIN)
        || x.round() > f64::from(i32::MAX)
        || y.round() < f64::from(i32::MIN)
        || y.round() > f64::from(i32::MAX)
    {
        return Err("overlay_position_invalid".to_owned());
    }
    Ok(tauri::PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    ))
}

#[cfg(test)]
mod coordinate_snapshot_tests {
    use super::*;

    #[test]
    fn mixed_dpi_workarea_and_position_round_trip_in_window_space() {
        let window_scale = 1.5;
        let work = logical_rect_from_physical(-1920, 0, 1920, 1080, window_scale).unwrap();
        let window = logical_point_from_physical(-1800.0, 750.0, window_scale).unwrap();
        assert_eq!(work.x, -1280.0);
        assert_eq!(work.height, 720.0);
        assert_eq!(window.x, -1200.0);
        let physical = physical_position_from_logical(window.x, window.y, window_scale).unwrap();
        assert_eq!(physical, tauri::PhysicalPosition::new(-1800, 750));
    }

    #[test]
    fn physical_position_rejects_invalid_or_out_of_range_snapshot_scale() {
        assert!(physical_position_from_logical(1.0, 2.0, 0.0).is_err());
        assert!(physical_position_from_logical(1.0, 2.0, f64::NAN).is_err());
        assert!(physical_position_from_logical(f64::MAX, 2.0, 2.0).is_err());
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn set_overlay_visibility(
    app: tauri::AppHandle,
    window_label: String,
    visible: bool,
) -> Result<(), String> {
    let surface = NativeSurface::parse(&window_label)?;
    let window = window_for(&app, surface)?;
    if visible {
        // Single non-activating show entry point: the platform fork lives in
        // `crate::show_surface_without_activation` only.
        crate::show_surface_without_activation(&window)
            .map_err(|_| "set_overlay_visibility_failed".to_owned())
    } else {
        window
            .hide()
            .map_err(|_| "set_overlay_visibility_failed".to_owned())
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn set_overlay_opacity(
    app: tauri::AppHandle,
    window_label: String,
    opacity: f64,
) -> Result<(), String> {
    validate_opacity(opacity)?;
    let surface = NativeSurface::parse(&window_label)?;
    let window = window_for(&app, surface)?;
    apply_window_opacity(&window, opacity)
}

#[cfg(windows)]
pub(crate) fn apply_window_opacity<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    opacity: f64,
) -> Result<(), String> {
    use windows::Win32::Foundation::{COLORREF, HWND};
    use windows::Win32::UI::WindowsAndMessaging::{SetLayeredWindowAttributes, LWA_ALPHA};

    let hwnd = window.hwnd().map_err(|_| "hwnd_unavailable".to_owned())?;
    unsafe {
        SetLayeredWindowAttributes(
            HWND(hwnd.0),
            COLORREF(0),
            opacity_to_alpha(opacity),
            LWA_ALPHA,
        )
        .map_err(|_| "set_overlay_opacity_failed".to_owned())
    }
}

#[cfg(not(windows))]
pub(crate) fn apply_window_opacity<R: Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _opacity: f64,
) -> Result<(), String> {
    Err("set_overlay_opacity_unsupported".to_owned())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn set_window_click_through(
    app: tauri::AppHandle,
    window_label: String,
    ignore: bool,
) -> Result<(), String> {
    let surface = NativeSurface::parse(&window_label)?;
    let window = window_for(&app, surface)?;
    // Single click-through entry point: the platform fork lives in
    // `crate::apply_click_through` only.
    crate::apply_click_through(&window, ignore)
        .map_err(|_| crate::CLICK_THROUGH_FAILURE_CODE.to_owned())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn begin_native_drag(app: tauri::AppHandle, window_label: String) -> Result<(), String> {
    let surface = NativeSurface::parse(&window_label)?;
    let window = window_for(&app, surface)?;
    window
        .start_dragging()
        .map_err(|_| "begin_native_drag_failed".to_owned())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) fn surface_ready(
    app: tauri::AppHandle,
    host: tauri::State<'_, WindowHost>,
    surface: String,
) -> Result<Value, String> {
    let surface = NativeSurface::parse(&surface)?;
    let already_ready = host.surface_ready(&app, surface.as_str())?;
    Ok(json!({
        "protocolVersion": NATIVE_PLATFORM_PROTOCOL_VERSION,
        "surface": surface.as_str(),
        "ready": true,
        "alreadyReady": already_ready,
    }))
}

#[tauri::command]
pub(crate) fn exit_application(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<WindowHost>().mark_explicit_exit_requested();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn surface_identity_is_closed_and_stable() {
        assert_eq!(NativeSurface::parse("main"), Ok(NativeSurface::Main));
        assert_eq!(NativeSurface::parse("home"), Ok(NativeSurface::Home));
        assert_eq!(
            NativeSurface::parse("MAIN"),
            Err("surface_invalid".to_owned())
        );
        assert_eq!(
            NativeSurface::parse("other"),
            Err("surface_invalid".to_owned())
        );
    }

    #[test]
    fn frame_position_and_opacity_validation_is_fail_closed() {
        assert!(validate_position(-10.0, 20.0).is_ok());
        assert_eq!(
            validate_position(f64::NAN, 0.0),
            Err("overlay_position_invalid".to_owned())
        );
        assert!(validate_frame(-10.0, 20.0, 160.0, 160.0).is_ok());
        assert_eq!(
            validate_frame(0.0, 0.0, 0.0, 160.0),
            Err("overlay_frame_invalid".to_owned())
        );
        assert_eq!(
            validate_frame(f64::NAN, 0.0, 160.0, 160.0),
            Err("overlay_frame_invalid".to_owned())
        );
        assert!(validate_opacity(0.0).is_ok());
        assert!(validate_opacity(1.0).is_ok());
        assert_eq!(
            validate_opacity(1.1),
            Err("overlay_opacity_invalid".to_owned())
        );
        assert_eq!(
            validate_opacity(f64::INFINITY),
            Err("overlay_opacity_invalid".to_owned())
        );
    }

    #[test]
    fn physical_facts_use_one_explicit_logical_conversion() {
        let work_area = logical_rect_from_physical(-1920, 0, 1920, 1080, 1.5).unwrap();
        assert_eq!(
            work_area,
            LogicalRect {
                x: -1280.0,
                y: 0.0,
                width: 1280.0,
                height: 720.0,
            }
        );

        let relative = logical_point_from_physical(144.0, 96.0, 1.5).unwrap();
        assert_eq!(relative, LogicalPoint { x: 96.0, y: 64.0 });
        assert_eq!(relative.json(), json!({ "x": 96.0, "y": 64.0 }));
    }

    #[test]
    fn opacity_conversion_covers_native_alpha_endpoints() {
        assert_eq!(opacity_to_alpha(0.0), 0);
        assert_eq!(opacity_to_alpha(0.5), 128);
        assert_eq!(opacity_to_alpha(1.0), 255);
    }

    #[test]
    fn snapshot_revision_is_monotonic_and_process_local() {
        let platform = NativePlatformState::new();
        assert_eq!(platform.next_snapshot_revision(), 1);
        assert_eq!(platform.next_snapshot_revision(), 2);
        assert!(platform.captured_at_monotonic_ms() < 60_000);
    }
}
