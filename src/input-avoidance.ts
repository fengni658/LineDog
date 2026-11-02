import { systemTimelineClock, type TimelineClock } from "./animation-timeline";
import type { LogicalWorkArea } from "./native-motion";
import type {
  NativeDesktopSnapshotV1,
  NativeFocusedInputGeometryKind,
  NativeFocusedInputSnapshotRequest,
  NativeFocusedInputSnapshotResponse,
  NativePhysicalRect,
} from "./native-platform";
import { RUNTIME_VIEWPORT_SIZE } from "./sprite-renderer";

export const FOCUSED_INPUT_POLL_INTERVAL_MS = 250;
export const FOCUSED_INPUT_STALE_AFTER_MS = 750;
export const INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX = 24;

export type FocusedInputGeometryKind = NativeFocusedInputGeometryKind;

export type PhysicalRect = NativePhysicalRect;

export type LogicalRect = PhysicalRect;

export type FocusedInputGeometryRequest = NativeFocusedInputSnapshotRequest;
export type FocusedInputGeometryResponse = NativeFocusedInputSnapshotResponse;

export type FocusedInputFactKind =
  | "none"
  | "dynamic-line"
  | "system-caret"
  | "text-focus-only";

/**
 * The only frontend fact shape consumed by Pet Runtime for focused-input
 * avoidance. Monitor/session metadata is deliberately anonymous context for
 * collision ownership; no focused-window title, process, text, or content is
 * retained here.
 */
export type FocusedInputFact = Readonly<{
  readonly kind: FocusedInputFactKind;
  readonly forbiddenRegion?: LogicalRect;
  readonly approximate: boolean;
  readonly revision: number;
  readonly monitorId?: string;
  readonly workArea?: LogicalWorkArea;
  readonly monitorRevision?: number;
  readonly focusSessionId?: string;
}>;

type AdaptedInputGeometry = Pick<
  FocusedInputFact,
  "kind" | "forbiddenRegion" | "approximate" | "monitorId" | "workArea"
>;

const NATIVE_INPUT_ERROR_CODES = ["runtime-disabled", "worker-spawn", "worker-stalled",
  "worker-disconnected", "worker-timeout", "uia-initialization", "uia-failure", "task-join-failure"] as const;
export type InputIdentityMismatch = "timestamp" | "request-revision" | "monitor-revision" |
  "dispose-generation" | "superseded-request" | "superseded-monitor" | "multiple";
export type FocusedInputDiagnostic = Readonly<{
  input_status: "accepted" | "unavailable" | "rejected" | "busy";
  input_kind: FocusedInputGeometryKind | "unknown";
  input_code: typeof NATIVE_INPUT_ERROR_CODES[number] | "ok" | "unknown" | "desktop-unavailable" |
    "request-failed" | "request-mismatch" | "stale-response" | "monitor-changed" | "worker-busy" | "geometry-unavailable";
  approximate: boolean;
  identity_mismatch?: InputIdentityMismatch;
}>;

export interface FocusedInputGeometryAdapterOptions {
  readonly clock?: TimelineClock;
  readonly readDesktopSnapshot: () => Promise<NativeDesktopSnapshotV1 | null>;
  readonly readFocusedInputSnapshot: (
    request: FocusedInputGeometryRequest,
  ) => Promise<FocusedInputGeometryResponse>;
  readonly onFact: (fact: FocusedInputFact) => void;
  readonly onDiagnostic?: (diagnostic: FocusedInputDiagnostic) => void;
}

type MonitorContext = Readonly<{
  monitorId: string;
  workArea: LogicalWorkArea;
  scaleFactor: number;
}>;

// Shares the runtime time base: a second, locally defined clock would produce
// timestamps that cannot be compared with the runtime's own.
const systemMonotonicClock: TimelineClock = systemTimelineClock;

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function isValidRect(rect: PhysicalRect | null): rect is PhysicalRect {
  return (
    rect !== null &&
    isFiniteNumber(rect.left) &&
    isFiniteNumber(rect.top) &&
    isFiniteNumber(rect.right) &&
    isFiniteNumber(rect.bottom) &&
    rect.right > rect.left &&
    rect.bottom > rect.top
  );
}

function createMonitorContext(
  snapshot: NativeDesktopSnapshotV1 | null,
): MonitorContext | undefined {
  if (!snapshot) {
    return undefined;
  }

  if (
    !isFiniteNumber(snapshot.windowScaleFactor) ||
    snapshot.windowScaleFactor <= 0 ||
    !isFiniteNumber(snapshot.workArea.x) ||
    !isFiniteNumber(snapshot.workArea.y) ||
    !isFiniteNumber(snapshot.workArea.width) ||
    !isFiniteNumber(snapshot.workArea.height) ||
    snapshot.workArea.width <= 0 ||
    snapshot.workArea.height <= 0 ||
    snapshot.currentMonitorId.length === 0
  ) {
    return undefined;
  }

  return {
    monitorId: snapshot.currentMonitorId,
    workArea: { ...snapshot.workArea },
    scaleFactor: snapshot.windowScaleFactor,
  };
}

function intersectRects(
  left: LogicalRect,
  right: LogicalRect,
): LogicalRect | undefined {
  const intersection = {
    left: Math.max(left.left, right.left),
    top: Math.max(left.top, right.top),
    right: Math.min(left.right, right.right),
    bottom: Math.min(left.bottom, right.bottom),
  };

  return intersection.right > intersection.left &&
    intersection.bottom > intersection.top
    ? intersection
    : undefined;
}

function physicalRectToLogicalOnce(
  rect: PhysicalRect,
  scaleFactor: number,
): LogicalRect {
  return {
    left: rect.left / scaleFactor,
    top: rect.top / scaleFactor,
    right: rect.right / scaleFactor,
    bottom: rect.bottom / scaleFactor,
  };
}

function expandAndClipRegion(
  region: LogicalRect,
  workArea: LogicalWorkArea,
): LogicalRect | undefined {
  const workAreaRight = workArea.x + workArea.width;
  const workAreaBottom = workArea.y + workArea.height;
  const expanded = {
    left: Math.max(
      workArea.x,
      region.left - INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
    ),
    top: Math.max(
      workArea.y,
      region.top - INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
    ),
    right: Math.min(
      workAreaRight,
      region.right + INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
    ),
    bottom: Math.min(
      workAreaBottom,
      region.bottom + INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
    ),
  };

  return expanded.right > expanded.left && expanded.bottom > expanded.top
    ? expanded
    : undefined;
}

function noneForMonitor(
  context?: MonitorContext,
  approximate = false,
): AdaptedInputGeometry {
  return {
    kind: "none",
    approximate,
    monitorId: context?.monitorId,
    workArea: context?.workArea,
  };
}

export function adaptFocusedInputGeometry(
  response: FocusedInputGeometryResponse,
  snapshot: NativeDesktopSnapshotV1 | null,
): AdaptedInputGeometry {
  const context = createMonitorContext(snapshot);
  if (!context) {
    return noneForMonitor(undefined, true);
  }

  if (response.kind === "none") {
    // Native's explicit no-focus response has no rectangle. Only its complete,
    // consistent shape can clear unknown input; busy/error are not no-focus.
    const trusted = response.busy === false && response.approximate === false &&
      response.textFocus === false && response.activeCaret === false &&
      response.singleVisualBand === false && response.caretEvidenceKind === "none" &&
      response.rectPhysical === null && response.errorCode === undefined;
    return noneForMonitor(context, !trusted);
  }

  if (response.kind === "text-focus-only") {
    if (!response.textFocus) {
      return noneForMonitor(context, response.approximate);
    }

    const workAreaRight = context.workArea.x + context.workArea.width;
    const workAreaBottom = context.workArea.y + context.workArea.height;
    const fallbackRegion = {
      left: context.workArea.x + context.workArea.width * 0.25,
      right: workAreaRight - context.workArea.width * 0.25,
      top: workAreaBottom - RUNTIME_VIEWPORT_SIZE,
      bottom: workAreaBottom,
    };
    const forbiddenRegion = expandAndClipRegion(
      fallbackRegion,
      context.workArea,
    );

    return forbiddenRegion
      ? {
          kind: "text-focus-only",
          approximate: response.approximate,
          monitorId: context.monitorId,
          workArea: context.workArea,
          forbiddenRegion,
        }
      : noneForMonitor(context, true);
  }

  if (response.kind === "system-caret") {
    // The system caret is a useful classification, but its rectangle is an
    // approximate OS fallback rather than a safe collision target. Preserve
    // the fact kind and approximation bit for observability while omitting a
    // forbidden region so Runtime remains fail-closed for movement.
    return response.textFocus && isValidRect(response.rectPhysical)
      ? {
          kind: "system-caret",
          approximate: response.approximate,
          monitorId: context.monitorId,
          workArea: context.workArea,
        }
      : noneForMonitor(context, true);
  }

  if (response.kind !== "dynamic-line" || !isValidRect(response.rectPhysical)) {
    return noneForMonitor(
      context,
      response.kind === "error" ||
        !isValidRect(response.rectPhysical) ||
        response.approximate,
    );
  }

  const logicalRegion = physicalRectToLogicalOnce(
    response.rectPhysical,
    context.scaleFactor,
  );
  const logicalWorkArea: LogicalRect = {
    left: context.workArea.x,
    top: context.workArea.y,
    right: context.workArea.x + context.workArea.width,
    bottom: context.workArea.y + context.workArea.height,
  };
  const logicalIntersection = intersectRects(logicalRegion, logicalWorkArea);
  if (!logicalIntersection) {
    return noneForMonitor(context, true);
  }

  const forbiddenRegion = expandAndClipRegion(
    logicalIntersection,
    context.workArea,
  );

  return forbiddenRegion
    ? {
        kind: "dynamic-line",
        approximate: response.approximate,
        monitorId: context.monitorId,
        workArea: context.workArea,
        forbiddenRegion,
      }
    : noneForMonitor(context, true);
}

export class FocusedInputGeometryAdapter {
  private readonly clock: TimelineClock;
  private readonly readDesktopSnapshot: () => Promise<NativeDesktopSnapshotV1 | null>;
  private readonly readFocusedInputSnapshot: (
    request: FocusedInputGeometryRequest,
  ) => Promise<FocusedInputGeometryResponse>;
  private readonly onFact: (fact: FocusedInputFact) => void;
  private readonly onDiagnostic: ((diagnostic: FocusedInputDiagnostic) => void) | undefined;
  private diagnosticSignature = "";
  private pollTimer: unknown | undefined;
  private requestInFlight = false;
  private running = false;
  private disposed = false;
  private requestRevision = 0;
  private monitorRevision = 0;
  private disposeGeneration = 0;
  private revision = 0;
  private focusSessionSequence = 0;
  private focusSessionId: string | undefined;
  private currentMonitorId: string | undefined;

  constructor(options: FocusedInputGeometryAdapterOptions) {
    this.clock = options.clock ?? systemMonotonicClock;
    this.readDesktopSnapshot = options.readDesktopSnapshot;
    this.readFocusedInputSnapshot = options.readFocusedInputSnapshot;
    this.onFact = options.onFact;
    this.onDiagnostic = options.onDiagnostic;
  }

  start(): void {
    if (this.running || this.disposed) {
      return;
    }

    this.running = true;
    this.schedulePoll(0);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.running = false;
    this.disposeGeneration += 1;
    if (this.pollTimer !== undefined) {
      this.clock.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running || this.pollTimer !== undefined) {
      return;
    }

    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = undefined;
      this.schedulePoll(FOCUSED_INPUT_POLL_INTERVAL_MS);

      if (this.requestInFlight) {
        return;
      }

      this.requestInFlight = true;
      void this.pollOnce().finally(() => {
        this.requestInFlight = false;
      });
    }, delayMs);
  }

  private async pollOnce(): Promise<void> {
    const requestGeneration = this.disposeGeneration;
    const snapshot = await this.readDesktopSnapshotSafely();
    if (!this.isGenerationCurrent(requestGeneration)) {
      return;
    }

    const monitorContext = createMonitorContext(snapshot);
    if (!monitorContext) {
      this.emitUnacceptedNone();
      return;
    }

    this.trackMonitor(monitorContext.monitorId);
    const startedAt = this.clock.now();
    const request: FocusedInputGeometryRequest = {
      // Integer transport identity survives the Rust/JS JSON round trip. Keep
      // high resolution locally for the unchanged 750 ms freshness boundary.
      requestStartedAtMonotonic: Math.floor(startedAt),
      requestRevision: ++this.requestRevision,
      monitorRevision: this.monitorRevision,
      disposeGeneration: requestGeneration,
    };

    let response: FocusedInputGeometryResponse;
    try {
      response = await this.readFocusedInputSnapshot(request);
    } catch {
      if (this.isRequestCurrent(request)) {
        this.emitUnacceptedNone(monitorContext, "request-failed");
      }
      return;
    }

    if (!this.isGenerationCurrent(requestGeneration)) {
      return;
    }

    const mismatches: InputIdentityMismatch[] = [];
    if (response.requestStartedAtMonotonic !== request.requestStartedAtMonotonic) mismatches.push("timestamp");
    if (response.requestRevision !== request.requestRevision) mismatches.push("request-revision");
    if (response.monitorRevision !== request.monitorRevision) mismatches.push("monitor-revision");
    if (response.disposeGeneration !== request.disposeGeneration) mismatches.push("dispose-generation");
    if (request.requestRevision !== this.requestRevision) mismatches.push("superseded-request");
    if (request.monitorRevision !== this.monitorRevision) mismatches.push("superseded-monitor");
    if (mismatches.length > 0) {
      const identityMismatch = mismatches.length === 1 ? mismatches[0] : "multiple";
      if (this.isRequestCurrent(request)) {
        this.emitUnacceptedNone(monitorContext, "request-mismatch", identityMismatch);
      } else {
        // An obsolete response must not replace a newer fact, even with none.
        this.emitDiagnostic({ input_status: "rejected", input_kind: "unknown",
          input_code: "request-mismatch", approximate: true, identity_mismatch: identityMismatch });
      }
      return;
    }

    if (
      this.clock.now() - startedAt >
      FOCUSED_INPUT_STALE_AFTER_MS
    ) {
      this.emitUnacceptedNone(monitorContext, "stale-response");
      return;
    }

    const currentSnapshot = await this.readDesktopSnapshotSafely();
    if (!this.isRequestCurrent(request)) {
      return;
    }

    const currentMonitorContext = createMonitorContext(currentSnapshot);
    if (!currentMonitorContext) {
      this.emitUnacceptedNone();
      return;
    }

    this.trackMonitor(currentMonitorContext.monitorId);
    if (
      currentMonitorContext.monitorId !== monitorContext.monitorId ||
      this.monitorRevision !== request.monitorRevision
    ) {
      this.emitUnacceptedNone(currentMonitorContext, "monitor-changed");
      return;
    }

    if (response.busy) {
      // The native worker still had a sample in flight: this response carries
      // no focus information at all. Keep the last known fact instead of
      // collapsing avoidance into "no focused input".
      this.emitDiagnostic({ input_status: "busy", input_kind: "unknown", input_code: "worker-busy", approximate: true });
      return;
    }

    // Re-reading the desktop is asynchronous too; it cannot extend a fact's
    // lifetime past the original sampling request.
    if (this.clock.now() - startedAt > FOCUSED_INPUT_STALE_AFTER_MS) {
      this.emitUnacceptedNone(currentMonitorContext, "stale-response");
      return;
    }

    this.updateFocusSession(response);
    const adapted = adaptFocusedInputGeometry(response, currentSnapshot);
    this.emitFact(adapted);
    const unavailable = !adapted.forbiddenRegion && (adapted.kind !== "none" || adapted.approximate);
    const inputCode: FocusedInputDiagnostic["input_code"] = response.kind === "error"
      ? NATIVE_INPUT_ERROR_CODES.find(code => code === response.errorCode) ?? "unknown"
      : unavailable ? "geometry-unavailable" : "ok";
    this.emitDiagnostic({ input_status: unavailable ? "unavailable" : "accepted",
      input_kind: response.kind, input_code: inputCode, approximate: adapted.approximate });
  }

  private async readDesktopSnapshotSafely(): Promise<NativeDesktopSnapshotV1 | null> {
    try {
      return await this.readDesktopSnapshot();
    } catch {
      return null;
    }
  }

  private trackMonitor(monitorId: string): void {
    if (monitorId === this.currentMonitorId) {
      return;
    }

    this.currentMonitorId = monitorId;
    this.monitorRevision += 1;
    this.focusSessionId = undefined;
  }

  private updateFocusSession(response: FocusedInputGeometryResponse): void {
    if (response.kind === "none" || !response.textFocus) {
      this.focusSessionId = undefined;
      return;
    }

    if (!this.focusSessionId) {
      this.focusSessionSequence += 1;
      this.focusSessionId = `focus-${this.focusSessionSequence}`;
    }
  }

  private emitFact(adapted: AdaptedInputGeometry): void {
    this.onFact({
      ...adapted,
      revision: ++this.revision,
      monitorRevision: this.monitorRevision,
      focusSessionId: this.focusSessionId,
    });
  }

  private emitUnacceptedNone(context?: MonitorContext, code: FocusedInputDiagnostic["input_code"] = "desktop-unavailable", identityMismatch?: InputIdentityMismatch): void {
    this.emitFact(noneForMonitor(context, true));
    this.emitDiagnostic({ input_status: "rejected", input_kind: "unknown", input_code: code, approximate: true,
      ...(identityMismatch ? { identity_mismatch: identityMismatch } : {}) });
  }

  private emitDiagnostic(diagnostic: FocusedInputDiagnostic): void {
    if (!this.onDiagnostic || this.disposed) return;
    const signature = JSON.stringify(diagnostic);
    if (signature === this.diagnosticSignature) return;
    this.diagnosticSignature = signature;
    try { this.onDiagnostic(diagnostic); } catch { /* Diagnostics cannot interrupt input sampling. */ }
  }

  private isGenerationCurrent(generation: number): boolean {
    return (
      this.running &&
      !this.disposed &&
      generation === this.disposeGeneration
    );
  }

  private isRequestCurrent(request: FocusedInputGeometryRequest): boolean {
    return (
      this.isGenerationCurrent(request.disposeGeneration) &&
      request.requestRevision === this.requestRevision &&
      request.monitorRevision === this.monitorRevision
    );
  }
}
