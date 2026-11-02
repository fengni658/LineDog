use std::{
    ffi::c_void,
    mem::size_of,
    ptr::null_mut,
    slice,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Map, Value};
use windows::{
    core::{IUnknown, Interface, BOOL, HRESULT},
    Win32::{
        Foundation::{POINT, RECT},
        Graphics::Gdi::ClientToScreen,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_MULTITHREADED, SAFEARRAY,
            },
            Ole::{
                SafeArrayAccessData, SafeArrayDestroy, SafeArrayGetDim, SafeArrayGetLBound,
                SafeArrayGetUBound, SafeArrayUnaccessData,
            },
        },
        UI::{
            Accessibility::{
                CUIAutomation8, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
                IUIAutomationTextPattern2, IUIAutomationTextRange, TextPatternRangeEndpoint_End,
                TextPatternRangeEndpoint_Start, TextUnit_Line, UIA_TextPattern2Id,
                UIA_TextPatternId, UIA_E_NOTSUPPORTED, UIA_PATTERN_ID,
            },
            WindowsAndMessaging::{
                GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, GUITHREADINFO,
            },
        },
    },
};

const RESPONSE_WAIT_BUDGET: Duration = Duration::from_millis(750);
const WORKER_QUEUE_CAPACITY: usize = 1;
/// Saturating cap for the combined `timeout_or_errors` diagnostic counter.
const MAX_TIMEOUT_OR_ERRORS: u8 = 2;
/// Transient failures (worker timeout / queue stall) only trip the gate after
/// this many consecutive occurrences — a slow worker is expected to recover.
const MAX_TRANSIENT_TIMEOUTS: u8 = 2;
/// How long the gate stays tripped before it admits a single half-open probe.
const GATE_HALF_OPEN_AFTER: Duration = Duration::from_secs(30);
const INPUT_GEOMETRY_GATE_MARKER: &str = "LINEDOG_INPUT_GEOMETRY_GATE_V1";

#[derive(Clone, Copy, Debug, PartialEq)]
struct PhysicalRect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl PhysicalRect {
    fn from_rect(rect: RECT) -> Option<Self> {
        Self::from_edges(
            f64::from(rect.left),
            f64::from(rect.top),
            f64::from(rect.right),
            f64::from(rect.bottom),
        )
    }

    fn from_xywh(x: f64, y: f64, width: f64, height: f64) -> Option<Self> {
        Self::from_edges(x, y, x + width, y + height)
    }

    fn from_edges(left: f64, top: f64, right: f64, bottom: f64) -> Option<Self> {
        let rect = Self {
            left,
            top,
            right,
            bottom,
        };
        rect.is_valid().then_some(rect)
    }

    fn is_valid(self) -> bool {
        self.left.is_finite()
            && self.top.is_finite()
            && self.right.is_finite()
            && self.bottom.is_finite()
            && self.right > self.left
            && self.bottom > self.top
    }

    fn union(self, other: Self) -> Self {
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }

    fn to_json(self) -> Value {
        json!({
            "left": self.left,
            "top": self.top,
            "right": self.right,
            "bottom": self.bottom,
        })
    }
}

fn belongs_to_single_visual_band(rectangles: &[PhysicalRect]) -> bool {
    let Some(first) = rectangles.first().copied() else {
        return false;
    };
    let max_top = rectangles
        .iter()
        .map(|rect| rect.top)
        .fold(first.top, f64::max);
    let min_bottom = rectangles
        .iter()
        .map(|rect| rect.bottom)
        .fold(first.bottom, f64::min);
    max_top < min_bottom
}

fn merge_rectangles(rectangles: &[PhysicalRect]) -> Option<PhysicalRect> {
    rectangles
        .iter()
        .copied()
        .reduce(|merged, rect| merged.union(rect))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaretEvidenceKind {
    ProviderActive,
    CollapsedSelection,
    SystemCaretApproximate,
    None,
}

impl CaretEvidenceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::ProviderActive => "provider-active",
            Self::CollapsedSelection => "collapsed-selection",
            Self::SystemCaretApproximate => "system-caret-approximate",
            Self::None => "none",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InputGeometryKind {
    None,
    DynamicLine,
    SystemCaret,
    TextFocusOnly,
    Error,
}

impl InputGeometryKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::DynamicLine => "dynamic-line",
            Self::SystemCaret => "system-caret",
            Self::TextFocusOnly => "text-focus-only",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StableErrorCode {
    RuntimeDisabled,
    WorkerSpawn,
    WorkerStalled,
    WorkerDisconnected,
    WorkerTimeout,
    UiaInitialization,
    UiaFailure,
    TaskJoinFailure,
}

impl StableErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeDisabled => "runtime-disabled",
            Self::WorkerSpawn => "worker-spawn",
            Self::WorkerStalled => "worker-stalled",
            Self::WorkerDisconnected => "worker-disconnected",
            Self::WorkerTimeout => "worker-timeout",
            Self::UiaInitialization => "uia-initialization",
            Self::UiaFailure => "uia-failure",
            Self::TaskJoinFailure => "task-join-failure",
        }
    }

    /// Only failures that mean "this worker can never answer again" are
    /// permanent. A timeout or a full queue is transient — the worker is merely
    /// slow — so those are counted separately and are allowed to heal.
    fn is_permanent(self) -> bool {
        matches!(
            self,
            Self::WorkerSpawn
                | Self::WorkerDisconnected
                | Self::UiaInitialization
                | Self::TaskJoinFailure
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct RequestIdentity {
    request_started_at_monotonic: f64,
    request_revision: u64,
    monitor_revision: u64,
    dispose_generation: u64,
}

#[derive(Clone, Debug, PartialEq)]
struct InputGeometryResponse {
    identity: RequestIdentity,
    kind: InputGeometryKind,
    rect_physical: Option<PhysicalRect>,
    approximate: bool,
    text_focus: bool,
    active_caret: bool,
    single_visual_band: bool,
    caret_evidence_kind: CaretEvidenceKind,
    error_code: Option<StableErrorCode>,
    /// `true` when no sample was taken because the worker is still busy. The
    /// payload then carries no focus information at all and must not be
    /// interpreted as "no focused input".
    busy: bool,
}

impl InputGeometryResponse {
    fn dynamic_line(
        identity: RequestIdentity,
        rect_physical: PhysicalRect,
        caret_evidence_kind: CaretEvidenceKind,
    ) -> Self {
        Self {
            identity,
            kind: InputGeometryKind::DynamicLine,
            rect_physical: Some(rect_physical),
            approximate: false,
            text_focus: true,
            active_caret: true,
            single_visual_band: true,
            caret_evidence_kind,
            error_code: None,
            busy: false,
        }
    }

    fn system_caret(identity: RequestIdentity, rect_physical: PhysicalRect) -> Self {
        Self {
            identity,
            kind: InputGeometryKind::SystemCaret,
            rect_physical: Some(rect_physical),
            approximate: true,
            text_focus: true,
            active_caret: true,
            single_visual_band: true,
            caret_evidence_kind: CaretEvidenceKind::SystemCaretApproximate,
            error_code: None,
            busy: false,
        }
    }

    fn text_focus_only(
        identity: RequestIdentity,
        active_caret: bool,
        caret_evidence_kind: CaretEvidenceKind,
    ) -> Self {
        Self {
            identity,
            kind: InputGeometryKind::TextFocusOnly,
            rect_physical: None,
            approximate: false,
            text_focus: true,
            active_caret,
            single_visual_band: false,
            caret_evidence_kind,
            error_code: None,
            busy: false,
        }
    }

    fn none(identity: RequestIdentity) -> Self {
        Self {
            identity,
            kind: InputGeometryKind::None,
            rect_physical: None,
            approximate: false,
            text_focus: false,
            active_caret: false,
            single_visual_band: false,
            caret_evidence_kind: CaretEvidenceKind::None,
            error_code: None,
            busy: false,
        }
    }

    /// The worker is still busy with a previous sample: no focus information
    /// was produced, which is strictly different from "no focused input".
    fn busy(identity: RequestIdentity) -> Self {
        Self {
            identity,
            kind: InputGeometryKind::None,
            rect_physical: None,
            approximate: false,
            text_focus: false,
            active_caret: false,
            single_visual_band: false,
            caret_evidence_kind: CaretEvidenceKind::None,
            error_code: None,
            busy: true,
        }
    }

    fn error(identity: RequestIdentity, error_code: StableErrorCode) -> Self {
        Self {
            identity,
            kind: InputGeometryKind::Error,
            rect_physical: None,
            approximate: false,
            text_focus: false,
            active_caret: false,
            single_visual_band: false,
            caret_evidence_kind: CaretEvidenceKind::None,
            error_code: Some(error_code),
            busy: false,
        }
    }

    fn to_json(&self) -> Value {
        let mut value = Map::new();
        value.insert("kind".to_owned(), json!(self.kind.as_str()));
        value.insert(
            "rectPhysical".to_owned(),
            self.rect_physical
                .map(PhysicalRect::to_json)
                .unwrap_or(Value::Null),
        );
        value.insert("approximate".to_owned(), json!(self.approximate));
        value.insert("textFocus".to_owned(), json!(self.text_focus));
        value.insert("activeCaret".to_owned(), json!(self.active_caret));
        value.insert(
            "singleVisualBand".to_owned(),
            json!(self.single_visual_band),
        );
        value.insert(
            "caretEvidenceKind".to_owned(),
            json!(self.caret_evidence_kind.as_str()),
        );
        value.insert("busy".to_owned(), json!(self.busy));
        let started_at = self.identity.request_started_at_monotonic;
        // Preserve the sampler's integer transport identity as a JSON integer,
        // rather than routing its echo through serde_json's float parser.
        let timestamp = if started_at >= 0.0
            && started_at <= 9_007_199_254_740_991.0
            && started_at.fract() == 0.0
        {
            json!(started_at as u64)
        } else {
            json!(started_at)
        };
        value.insert("requestStartedAtMonotonic".to_owned(), timestamp);
        value.insert(
            "requestRevision".to_owned(),
            json!(self.identity.request_revision),
        );
        value.insert(
            "monitorRevision".to_owned(),
            json!(self.identity.monitor_revision),
        );
        value.insert(
            "disposeGeneration".to_owned(),
            json!(self.identity.dispose_generation),
        );
        if let Some(error_code) = self.error_code {
            value.insert("errorCode".to_owned(), json!(error_code.as_str()));
        }
        Value::Object(value)
    }
}

struct SafeArrayOwner(*mut SAFEARRAY);

impl Drop for SafeArrayOwner {
    fn drop(&mut self) {
        if !self.0.is_null() {
            let _ = unsafe { SafeArrayDestroy(self.0) };
        }
    }
}

fn bounding_rectangles(
    range: &IUIAutomationTextRange,
) -> Result<Vec<PhysicalRect>, StableErrorCode> {
    let raw = unsafe { range.GetBoundingRectangles() }.map_err(|_| StableErrorCode::UiaFailure)?;
    if raw.is_null() {
        return Ok(Vec::new());
    }
    let owner = SafeArrayOwner(raw);

    if unsafe { SafeArrayGetDim(owner.0) } != 1 {
        return Err(StableErrorCode::UiaFailure);
    }
    if unsafe { (*owner.0).cbElements as usize } != size_of::<f64>() {
        return Err(StableErrorCode::UiaFailure);
    }

    let lower =
        unsafe { SafeArrayGetLBound(owner.0, 1) }.map_err(|_| StableErrorCode::UiaFailure)?;
    let upper =
        unsafe { SafeArrayGetUBound(owner.0, 1) }.map_err(|_| StableErrorCode::UiaFailure)?;
    if upper < lower {
        return Ok(Vec::new());
    }

    let value_count = usize::try_from(i64::from(upper) - i64::from(lower) + 1)
        .map_err(|_| StableErrorCode::UiaFailure)?;
    if value_count % 4 != 0 {
        return Err(StableErrorCode::UiaFailure);
    }

    // SAFETY: `value_count` spans a valid f64 range inside `owner`'s buffer.
    //   - `SafeArrayGetDim == 1` (checked above) makes the array 1-D, so lBound/uBound
    //     describe the same dimension this slice is built from.
    //   - `cbElements == size_of::<f64>()` (checked above) makes the element stride
    //     exactly `f64`, so element-count indexing matches the f64 cast.
    //   - `upper >= lower` keeps the count non-negative and `usize::try_from` rejects
    //     overflow, so the length cannot exceed `isize::MAX` elements.
    //   - `SafeArrayAccessData` succeeded and `owner` keeps the array alive until end
    //     of scope (its `Drop` calls `SafeArrayDestroy`).
    // `to_vec()` copies before `SafeArrayUnaccessData` below, so no slice into the
    // locked buffer outlives the access window.
    let mut data = null_mut::<c_void>();
    unsafe { SafeArrayAccessData(owner.0, &mut data) }.map_err(|_| StableErrorCode::UiaFailure)?;
    let values = unsafe { slice::from_raw_parts(data.cast::<f64>(), value_count) }.to_vec();
    unsafe { SafeArrayUnaccessData(owner.0) }.map_err(|_| StableErrorCode::UiaFailure)?;

    Ok(values
        .chunks_exact(4)
        .filter_map(|quad| PhysicalRect::from_xywh(quad[0], quad[1], quad[2], quad[3]))
        .collect())
}

struct RangeGeometry {
    merged: Option<PhysicalRect>,
    single_visual_band: bool,
}

fn range_geometry(range: &IUIAutomationTextRange) -> Result<RangeGeometry, StableErrorCode> {
    let rectangles = bounding_rectangles(range)?;
    if !rectangles.is_empty() {
        return Ok(RangeGeometry {
            single_visual_band: belongs_to_single_visual_band(&rectangles),
            merged: merge_rectangles(&rectangles),
        });
    }

    let line = unsafe { range.Clone() }.map_err(|_| StableErrorCode::UiaFailure)?;
    unsafe { line.ExpandToEnclosingUnit(TextUnit_Line) }
        .map_err(|_| StableErrorCode::UiaFailure)?;
    let rectangles = bounding_rectangles(&line)?;
    Ok(RangeGeometry {
        single_visual_band: belongs_to_single_visual_band(&rectangles),
        merged: merge_rectangles(&rectangles),
    })
}

struct UiaFacts {
    has_keyboard_focus: bool,
    text_pattern_available: bool,
    active_caret: bool,
    caret_evidence_kind: CaretEvidenceKind,
    geometry: Option<PhysicalRect>,
    single_visual_band: bool,
}

// GetCurrentPatternAs may succeed with a null optional interface. The typed
// binding erases that distinction as Error::empty(), so normalize it here,
// before constructing an interface. Each non-null returned reference is owned
// exactly once and is released even when the result cannot be accepted.
fn optional_uia_pattern<T: Interface>(
    query: impl FnOnce(*mut *mut c_void) -> HRESULT,
) -> Result<Option<T>, StableErrorCode> {
    let mut pointer = null_mut();
    let status = query(&mut pointer);
    let pattern = if pointer.is_null() {
        None
    } else {
        Some(unsafe { T::from_raw(pointer) })
    };
    if status.0 == 0 || (status.is_ok() && pattern.is_some()) {
        Ok(pattern)
    } else if status.0 as u32 == UIA_E_NOTSUPPORTED {
        Ok(None)
    } else {
        Err(StableErrorCode::UiaFailure)
    }
}

fn current_optional_pattern<T: Interface>(
    focused: &IUIAutomationElement,
    id: UIA_PATTERN_ID,
) -> Result<Option<T>, StableErrorCode> {
    optional_uia_pattern(|output| unsafe {
        (Interface::vtable(focused).GetCurrentPatternAs)(
            Interface::as_raw(focused),
            id,
            &T::IID,
            output,
        )
    })
}

fn current_uia_facts(automation: &IUIAutomation) -> Result<UiaFacts, StableErrorCode> {
    let focused: IUIAutomationElement =
        unsafe { automation.GetFocusedElement() }.map_err(|_| StableErrorCode::UiaFailure)?;
    let has_keyboard_focus = unsafe { focused.CurrentHasKeyboardFocus() }
        .map_err(|_| StableErrorCode::UiaFailure)?
        .as_bool();
    let mut facts = UiaFacts {
        has_keyboard_focus,
        text_pattern_available: false,
        active_caret: false,
        caret_evidence_kind: CaretEvidenceKind::None,
        geometry: None,
        single_visual_band: false,
    };
    if !has_keyboard_focus {
        return Ok(facts);
    }

    let mut provider_failed = false;
    if let Some(pattern) =
        current_optional_pattern::<IUIAutomationTextPattern2>(&focused, UIA_TextPattern2Id)?
    {
        facts.text_pattern_available = true;
        let mut active = BOOL::default();
        match unsafe { pattern.GetCaretRange(&mut active) } {
            Ok(caret_range) => {
                facts.active_caret = active.as_bool();
                if facts.active_caret {
                    facts.caret_evidence_kind = CaretEvidenceKind::ProviderActive;
                }
                let geometry = range_geometry(&caret_range)?;
                facts.geometry = geometry.merged;
                facts.single_visual_band = geometry.single_visual_band;
            }
            Err(_) => provider_failed = true,
        }
    }

    if facts.geometry.is_none() || !facts.active_caret {
        if let Some(pattern) =
            current_optional_pattern::<IUIAutomationTextPattern>(&focused, UIA_TextPatternId)?
        {
            facts.text_pattern_available = true;
            let ranges =
                unsafe { pattern.GetSelection() }.map_err(|_| StableErrorCode::UiaFailure)?;
            let length = unsafe { ranges.Length() }.map_err(|_| StableErrorCode::UiaFailure)?;
            if length == 1 {
                let range =
                    unsafe { ranges.GetElement(0) }.map_err(|_| StableErrorCode::UiaFailure)?;
                let collapsed = unsafe {
                    range.CompareEndpoints(
                        TextPatternRangeEndpoint_Start,
                        &range,
                        TextPatternRangeEndpoint_End,
                    )
                }
                .map_err(|_| StableErrorCode::UiaFailure)?
                    == 0;
                let geometry = range_geometry(&range)?;
                if collapsed {
                    facts.active_caret = true;
                    facts.caret_evidence_kind = CaretEvidenceKind::CollapsedSelection;
                    facts.geometry = geometry.merged;
                    facts.single_visual_band = geometry.single_visual_band;
                } else if facts.geometry.is_none() {
                    facts.geometry = geometry.merged;
                    facts.single_visual_band = geometry.single_visual_band;
                }
            }
        }
    }
    if provider_failed && facts.geometry.is_none() {
        return Err(StableErrorCode::UiaFailure);
    }

    Ok(facts)
}

fn current_system_caret() -> Option<PhysicalRect> {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0.is_null() {
        return None;
    }
    let foreground_thread = unsafe { GetWindowThreadProcessId(foreground, None) };
    if foreground_thread == 0 {
        return None;
    }

    let mut info = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetGUIThreadInfo(foreground_thread, &mut info) }.is_err()
        || info.hwndActive != foreground
        || info.hwndFocus.0.is_null()
        || info.hwndCaret.0.is_null()
        || unsafe { GetWindowThreadProcessId(info.hwndFocus, None) } != foreground_thread
        || unsafe { GetWindowThreadProcessId(info.hwndCaret, None) } != foreground_thread
    {
        return None;
    }

    let mut top_left = POINT {
        x: info.rcCaret.left,
        y: info.rcCaret.top,
    };
    let mut bottom_right = POINT {
        x: info.rcCaret.right,
        y: info.rcCaret.bottom,
    };
    if !unsafe { ClientToScreen(info.hwndCaret, &mut top_left) }.as_bool()
        || !unsafe { ClientToScreen(info.hwndCaret, &mut bottom_right) }.as_bool()
    {
        return None;
    }

    let right = bottom_right.x.max(top_left.x.saturating_add(1));
    let bottom = bottom_right.y.max(top_left.y.saturating_add(1));
    PhysicalRect::from_rect(RECT {
        left: top_left.x,
        top: top_left.y,
        right,
        bottom,
    })
}

fn collect_input_geometry(
    automation: &IUIAutomation,
    identity: RequestIdentity,
) -> Result<InputGeometryResponse, StableErrorCode> {
    let facts = current_uia_facts(automation)?;
    let text_focus = facts.has_keyboard_focus && facts.text_pattern_available;

    if let Some(rect) = facts.geometry {
        if text_focus && facts.active_caret && facts.single_visual_band {
            return Ok(InputGeometryResponse::dynamic_line(
                identity,
                rect,
                facts.caret_evidence_kind,
            ));
        }
        return Ok(if text_focus {
            InputGeometryResponse::text_focus_only(
                identity,
                facts.active_caret,
                facts.caret_evidence_kind,
            )
        } else {
            InputGeometryResponse::none(identity)
        });
    }

    if facts.has_keyboard_focus {
        if let Some(rect) = current_system_caret() {
            return Ok(InputGeometryResponse::system_caret(identity, rect));
        }
    }

    Ok(if text_focus {
        InputGeometryResponse::text_focus_only(
            identity,
            facts.active_caret,
            facts.caret_evidence_kind,
        )
    } else {
        InputGeometryResponse::none(identity)
    })
}

struct ComApartment;

impl ComApartment {
    fn initialize_mta() -> Result<Self, StableErrorCode> {
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
            return Err(StableErrorCode::UiaInitialization);
        }
        Ok(Self)
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct WorkerContext {
    automation: IUIAutomation,
    _apartment: ComApartment,
}

impl WorkerContext {
    fn initialize() -> Result<Self, StableErrorCode> {
        let apartment = ComApartment::initialize_mta()?;
        let automation =
            unsafe { CoCreateInstance(&CUIAutomation8, None::<&IUnknown>, CLSCTX_INPROC_SERVER) }
                .map_err(|_| StableErrorCode::UiaInitialization)?;
        Ok(Self {
            automation,
            _apartment: apartment,
        })
    }
}

enum WorkerMessage {
    Sample {
        identity: RequestIdentity,
        response: SyncSender<Result<InputGeometryResponse, StableErrorCode>>,
    },
    Shutdown,
}

fn worker_loop(receiver: Receiver<WorkerMessage>) {
    let context = WorkerContext::initialize();
    while let Ok(message) = receiver.recv() {
        match message {
            WorkerMessage::Sample { identity, response } => {
                let result = match &context {
                    Ok(context) => collect_input_geometry(&context.automation, identity),
                    Err(error_code) => Err(*error_code),
                };
                let _ = response.send(result);
            }
            WorkerMessage::Shutdown => break,
        }
    }
}

#[derive(Default)]
struct RuntimeGate {
    /// Combined transient + permanent failure count (saturating), kept as the
    /// observable "how sick is this worker" diagnostic.
    timeout_or_errors: u8,
    /// Transient failures only: a stalled or slow worker can still recover, so
    /// these never disable the runtime on their own beyond the trip threshold.
    timeouts: u8,
    /// Failures that mean the worker cannot serve requests again.
    permanent_errors: u8,
    disabled: bool,
    disabled_at: Option<Instant>,
}

impl RuntimeGate {
    fn record_failure(&mut self, permanent: bool) {
        self.timeout_or_errors = self
            .timeout_or_errors
            .saturating_add(1)
            .min(MAX_TIMEOUT_OR_ERRORS);
        if permanent {
            self.permanent_errors = self.permanent_errors.saturating_add(1);
            self.disable("permanent");
        } else {
            self.timeouts = self.timeouts.saturating_add(1);
            if self.timeouts >= MAX_TRANSIENT_TIMEOUTS {
                self.disable("transient");
            }
        }
    }

    /// One healthy round-trip heals the gate completely. This is what lets a
    /// half-open probe restore service instead of stranding the runtime forever.
    fn record_success(&mut self) {
        *self = Self::default();
    }

    fn disable(&mut self, cause: &str) {
        if !self.disabled {
            eprintln!(
                "{} gate=disabled cause={} timeouts={} permanent_errors={} probe_after_ms={}",
                INPUT_GEOMETRY_GATE_MARKER,
                cause,
                self.timeouts,
                self.permanent_errors,
                GATE_HALF_OPEN_AFTER.as_millis(),
            );
        }
        self.disabled = true;
        // Restart the cooldown so a failing probe cannot immediately retry.
        self.disabled_at = Some(Instant::now());
    }

    /// Half-open recovery: once the cooldown has elapsed, admit exactly one
    /// probe request. `InFlightPermit` guarantees only one request can be in
    /// flight, so "half-open" really is a single sample. A failure re-trips the
    /// gate; a success clears every counter.
    fn admits(&mut self) -> bool {
        if !self.disabled {
            return true;
        }
        let cooled_down = self.disabled_at.map_or(true, |disabled_at| {
            disabled_at.elapsed() >= GATE_HALF_OPEN_AFTER
        });
        if !cooled_down {
            return false;
        }
        self.disabled = false;
        eprintln!(
            "{} gate=half_open timeouts={} permanent_errors={}",
            INPUT_GEOMETRY_GATE_MARKER, self.timeouts, self.permanent_errors,
        );
        true
    }
}

struct InFlightPermit<'a> {
    in_flight: &'a AtomicBool,
}

impl<'a> InFlightPermit<'a> {
    fn acquire(in_flight: &'a AtomicBool) -> Option<Self> {
        in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self { in_flight })
    }
}

impl Drop for InFlightPermit<'_> {
    fn drop(&mut self) {
        self.in_flight.store(false, Ordering::Release);
    }
}

fn try_send_shutdown(sender: &SyncSender<WorkerMessage>) -> bool {
    sender.try_send(WorkerMessage::Shutdown).is_ok()
}

struct ProducerInner {
    sender: Option<SyncSender<WorkerMessage>>,
    in_flight: AtomicBool,
    gate: Mutex<RuntimeGate>,
}

impl ProducerInner {
    fn gate(&self) -> std::sync::MutexGuard<'_, RuntimeGate> {
        self.gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn record_failure(&self, error_code: StableErrorCode) {
        self.gate().record_failure(error_code.is_permanent());
    }

    fn record_success(&self) {
        self.gate().record_success();
    }

    fn request(&self, identity: RequestIdentity) -> InputGeometryResponse {
        if !self.gate().admits() {
            return InputGeometryResponse::error(identity, StableErrorCode::RuntimeDisabled);
        }
        let Some(_permit) = InFlightPermit::acquire(&self.in_flight) else {
            // The worker is still busy with the previous sample. This is not
            // "no focused input": report it as busy so the frontend can keep
            // the last known geometry instead of dropping avoidance.
            return InputGeometryResponse::busy(identity);
        };
        let Some(sender) = self.sender.as_ref() else {
            self.record_failure(StableErrorCode::WorkerSpawn);
            return InputGeometryResponse::error(identity, StableErrorCode::WorkerSpawn);
        };

        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        match sender.try_send(WorkerMessage::Sample {
            identity,
            response: response_sender,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.record_failure(StableErrorCode::WorkerStalled);
                return InputGeometryResponse::error(identity, StableErrorCode::WorkerStalled);
            }
            Err(TrySendError::Disconnected(_)) => {
                self.record_failure(StableErrorCode::WorkerDisconnected);
                return InputGeometryResponse::error(identity, StableErrorCode::WorkerDisconnected);
            }
        }

        match response_receiver.recv_timeout(RESPONSE_WAIT_BUDGET) {
            Ok(Ok(response)) => {
                self.record_success();
                response
            }
            Ok(Err(error_code)) => {
                self.record_failure(error_code);
                InputGeometryResponse::error(identity, error_code)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.record_failure(StableErrorCode::WorkerTimeout);
                InputGeometryResponse::error(identity, StableErrorCode::WorkerTimeout)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.record_failure(StableErrorCode::WorkerDisconnected);
                InputGeometryResponse::error(identity, StableErrorCode::WorkerDisconnected)
            }
        }
    }
}

impl Drop for ProducerInner {
    fn drop(&mut self) {
        if let Some(sender) = &self.sender {
            let _ = try_send_shutdown(sender);
        }
    }
}

#[derive(Clone)]
pub(crate) struct InputGeometryProducer {
    inner: Arc<ProducerInner>,
}

impl InputGeometryProducer {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = mpsc::sync_channel(WORKER_QUEUE_CAPACITY);
        let sender = match thread::Builder::new()
            .name("linedog-input-geometry-mta".to_owned())
            .spawn(move || worker_loop(receiver))
        {
            Ok(handle) => {
                drop(handle);
                Some(sender)
            }
            Err(_) => None,
        };
        let mut gate = RuntimeGate::default();
        if sender.is_none() {
            gate.record_failure(true);
        }
        Self {
            inner: Arc::new(ProducerInner {
                sender,
                in_flight: AtomicBool::new(false),
                gate: Mutex::new(gate),
            }),
        }
    }
}

pub(crate) async fn request_focused_input_geometry(
    producer: tauri::State<'_, InputGeometryProducer>,
    request_started_at_monotonic: f64,
    request_revision: u64,
    monitor_revision: u64,
    dispose_generation: u64,
) -> Result<Value, ()> {
    let identity = RequestIdentity {
        request_started_at_monotonic,
        request_revision,
        monitor_revision,
        dispose_generation,
    };
    let producer = producer.inner().clone();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || producer.inner.request(identity)).await {
            Ok(response) => response.to_json(),
            Err(_) => {
                InputGeometryResponse::error(identity, StableErrorCode::TaskJoinFailure).to_json()
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::AtomicBool,
        mpsc::{self, TrySendError},
    };

    use serde_json::json;

    use super::*;

    fn identity() -> RequestIdentity {
        RequestIdentity {
            request_started_at_monotonic: 12.5,
            request_revision: 7,
            monitor_revision: 11,
            dispose_generation: 3,
        }
    }

    #[test]
    fn rect_validation_rejects_non_finite_and_non_positive_extents() {
        assert!(PhysicalRect::from_xywh(10.0, 20.0, 30.0, 40.0).is_some());
        assert!(PhysicalRect::from_xywh(f64::NAN, 20.0, 30.0, 40.0).is_none());
        assert!(PhysicalRect::from_xywh(10.0, 20.0, 0.0, 40.0).is_none());
        assert!(PhysicalRect::from_xywh(10.0, 20.0, 30.0, -1.0).is_none());
    }

    #[test]
    fn single_band_is_computed_before_union() {
        let first = PhysicalRect::from_xywh(10.0, 20.0, 30.0, 20.0).unwrap();
        let same_band = PhysicalRect::from_xywh(50.0, 22.0, 10.0, 16.0).unwrap();
        let other_band = PhysicalRect::from_xywh(10.0, 60.0, 30.0, 20.0).unwrap();

        assert!(belongs_to_single_visual_band(&[first, same_band]));
        assert!(!belongs_to_single_visual_band(&[first, other_band]));
        assert_eq!(
            merge_rectangles(&[first, same_band]),
            PhysicalRect::from_xywh(10.0, 20.0, 50.0, 20.0),
        );
    }

    #[test]
    fn dynamic_line_serialization_honors_invariants_and_echoes_identity() {
        let rect = PhysicalRect::from_xywh(100.0, 200.0, 300.0, 40.0).unwrap();
        let response = InputGeometryResponse::dynamic_line(
            identity(),
            rect,
            CaretEvidenceKind::ProviderActive,
        );

        assert_eq!(
            response.to_json(),
            json!({
                "kind": "dynamic-line",
                "rectPhysical": {
                    "left": 100.0,
                    "top": 200.0,
                    "right": 400.0,
                    "bottom": 240.0,
                },
                "approximate": false,
                "textFocus": true,
                "activeCaret": true,
                "singleVisualBand": true,
                "caretEvidenceKind": "provider-active",
                "busy": false,
                "requestStartedAtMonotonic": 12.5,
                "requestRevision": 7,
                "monitorRevision": 11,
                "disposeGeneration": 3,
            }),
        );
    }

    #[test]
    fn busy_is_distinguishable_from_no_focus() {
        let busy = InputGeometryResponse::busy(identity()).to_json();
        assert_eq!(busy["busy"], true);
        assert_eq!(busy["kind"], "none");
        assert!(busy.get("errorCode").is_none());

        let none = InputGeometryResponse::none(identity()).to_json();
        assert_eq!(none["busy"], false);
        assert_ne!(busy["busy"], none["busy"]);
    }

    #[test]
    fn system_caret_and_error_serialization_are_explicit_and_redacted() {
        let rect = PhysicalRect::from_xywh(5.0, 6.0, 1.0, 18.0).unwrap();
        let system = InputGeometryResponse::system_caret(identity(), rect).to_json();
        assert_eq!(system["kind"], "system-caret");
        assert_eq!(system["approximate"], true);
        assert_eq!(system["caretEvidenceKind"], "system-caret-approximate");
        assert!(system.get("errorCode").is_none());

        let error = InputGeometryResponse::error(identity(), StableErrorCode::UiaFailure).to_json();
        assert_eq!(error["kind"], "error");
        assert_eq!(error["rectPhysical"], serde_json::Value::Null);
        assert_eq!(error["errorCode"], "uia-failure");
        assert!(error.get("osError").is_none());
        assert!(error.get("message").is_none());
    }

    #[test]
    fn geometry_free_results_never_serialize_a_rect() {
        for response in [
            InputGeometryResponse::none(identity()),
            InputGeometryResponse::busy(identity()),
            InputGeometryResponse::text_focus_only(
                identity(),
                true,
                CaretEvidenceKind::ProviderActive,
            ),
            InputGeometryResponse::error(identity(), StableErrorCode::RuntimeDisabled),
        ] {
            assert_eq!(response.to_json()["rectPhysical"], serde_json::Value::Null);
        }
    }

    #[test]
    fn optional_patterns_accept_successful_null_and_explicit_absence_only() {
        for status in [HRESULT(0), HRESULT(UIA_E_NOTSUPPORTED as i32)] {
            assert!(optional_uia_pattern::<IUnknown>(|_| status)
                .unwrap()
                .is_none());
        }
        for status in [
            HRESULT(1),
            HRESULT(0x8000_4005_u32 as i32),
            HRESULT(0x8007_0005_u32 as i32),
        ] {
            assert_eq!(
                optional_uia_pattern::<IUnknown>(|_| status).unwrap_err(),
                StableErrorCode::UiaFailure
            );
        }
    }

    #[test]
    fn optional_pattern_owns_and_releases_each_returned_reference_once() {
        use std::sync::atomic::AtomicUsize;
        use windows::core::{IUnknown_Vtbl, GUID};
        #[repr(C)]
        struct Tracked {
            vtable: *const IUnknown_Vtbl,
            refs: AtomicUsize,
            drops: Arc<AtomicUsize>,
        }
        unsafe extern "system" fn query(
            _: *mut c_void,
            _: *const GUID,
            out: *mut *mut c_void,
        ) -> HRESULT {
            unsafe {
                *out = null_mut();
            }
            HRESULT(0x8000_4002_u32 as i32)
        }
        unsafe extern "system" fn add_ref(this: *mut c_void) -> u32 {
            unsafe { &*(this as *mut Tracked) }
                .refs
                .fetch_add(1, Ordering::SeqCst) as u32
                + 1
        }
        unsafe extern "system" fn release(this: *mut c_void) -> u32 {
            let object = unsafe { &*(this as *mut Tracked) };
            let left = object.refs.fetch_sub(1, Ordering::SeqCst) - 1;
            if left == 0 {
                object.drops.fetch_add(1, Ordering::SeqCst);
                drop(unsafe { Box::from_raw(this as *mut Tracked) });
            }
            left as u32
        }
        const VTABLE: IUnknown_Vtbl = IUnknown_Vtbl {
            QueryInterface: query,
            AddRef: add_ref,
            Release: release,
        };
        for status in [
            HRESULT(0),
            HRESULT(1),
            HRESULT(0x8000_4005_u32 as i32),
            HRESULT(UIA_E_NOTSUPPORTED as i32),
        ] {
            let drops = Arc::new(AtomicUsize::new(0));
            let pointer = Box::into_raw(Box::new(Tracked {
                vtable: &VTABLE,
                refs: AtomicUsize::new(1),
                drops: drops.clone(),
            }));
            let result = optional_uia_pattern::<IUnknown>(|out| {
                unsafe {
                    *out = pointer.cast();
                }
                status
            });
            if status.is_ok() {
                assert!(result.as_ref().unwrap().is_some());
                assert_eq!(drops.load(Ordering::SeqCst), 0);
            }
            drop(result);
            assert_eq!(drops.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn integer_request_identity_survives_native_json_parse_and_response_serialization() {
        for timestamp in [0_u64, 2000, 9250, 3_600_000, 9_007_199_254_740_991] {
            let wire = format!("{{\"requestStartedAtMonotonic\":{timestamp}}}");
            let parsed: Value = serde_json::from_str(&wire).unwrap();
            let request = RequestIdentity {
                request_started_at_monotonic: parsed["requestStartedAtMonotonic"].as_f64().unwrap(),
                ..identity()
            };
            let wire_response =
                serde_json::to_string(&InputGeometryResponse::none(request).to_json()).unwrap();
            let response: Value = serde_json::from_str(&wire_response).unwrap();
            assert_eq!(
                response["requestStartedAtMonotonic"].as_f64().unwrap(),
                timestamp as f64
            );
        }
    }

    #[test]
    fn in_flight_gate_allows_exactly_one_request() {
        let in_flight = AtomicBool::new(false);
        let first = InFlightPermit::acquire(&in_flight).expect("first request should acquire");
        assert!(InFlightPermit::acquire(&in_flight).is_none());
        drop(first);
        assert!(InFlightPermit::acquire(&in_flight).is_some());
    }

    #[test]
    fn runtime_gate_disables_after_two_errors_or_one_permanent_stall() {
        let mut recoverable = RuntimeGate::default();
        recoverable.record_failure(false);
        assert!(!recoverable.disabled);
        recoverable.record_failure(false);
        assert!(recoverable.disabled);
        assert_eq!(recoverable.timeout_or_errors, 2);

        let mut permanent = RuntimeGate::default();
        permanent.record_failure(true);
        assert!(permanent.disabled);
        assert_eq!(permanent.timeout_or_errors, 1);
    }

    #[test]
    fn timeouts_and_permanent_failures_are_counted_separately() {
        let mut gate = RuntimeGate::default();
        gate.record_failure(false);
        gate.record_failure(true);

        assert_eq!(gate.timeouts, 1);
        assert_eq!(gate.permanent_errors, 1);
        assert!(gate.disabled);

        let transient_codes = [
            StableErrorCode::WorkerTimeout,
            StableErrorCode::WorkerStalled,
            StableErrorCode::UiaFailure,
            StableErrorCode::RuntimeDisabled,
        ];
        for code in transient_codes {
            assert!(!code.is_permanent(), "{:?} must stay recoverable", code);
        }
        for code in [
            StableErrorCode::WorkerSpawn,
            StableErrorCode::WorkerDisconnected,
            StableErrorCode::UiaInitialization,
            StableErrorCode::TaskJoinFailure,
        ] {
            assert!(code.is_permanent(), "{:?} must stay permanent", code);
        }
    }

    #[test]
    fn runtime_gate_reopens_with_a_single_half_open_probe_then_heals() {
        let mut gate = RuntimeGate::default();
        gate.record_failure(false);
        gate.record_failure(false);
        assert!(gate.disabled, "two timeouts trip the gate");

        gate.disabled_at = Some(Instant::now());
        assert!(!gate.admits(), "no probe before the cooldown elapses");

        gate.disabled_at = Some(Instant::now() - GATE_HALF_OPEN_AFTER);
        assert!(gate.admits(), "cooldown admits one probe");
        assert!(!gate.disabled);

        gate.record_failure(false);
        assert!(gate.disabled, "a failed probe re-trips the gate");
        assert!(!gate.admits(), "and restarts the cooldown");

        gate.disabled_at = Some(Instant::now() - GATE_HALF_OPEN_AFTER);
        assert!(gate.admits());
        gate.record_success();
        assert!(!gate.disabled);
        assert_eq!(gate.timeouts, 0);
        assert_eq!(gate.permanent_errors, 0);
        assert_eq!(gate.timeout_or_errors, 0);
        assert!(gate.disabled_at.is_none());
        assert!(gate.admits());
    }

    #[test]
    fn shutdown_signal_is_nonblocking_when_the_queue_is_full() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        assert!(sender.try_send(WorkerMessage::Shutdown).is_ok());
        assert!(matches!(
            sender.try_send(WorkerMessage::Shutdown),
            Err(TrySendError::Full(WorkerMessage::Shutdown)),
        ));
        assert!(!try_send_shutdown(&sender));
    }
}
