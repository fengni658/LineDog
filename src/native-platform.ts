import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const NATIVE_PLATFORM_PROTOCOL_VERSION = "linedog.native/v1" as const;
export const NATIVE_WINDOW_SIZE_LOGICAL = 160;

export type NativePlatformProtocolVersion =
  typeof NATIVE_PLATFORM_PROTOCOL_VERSION;

export type NativeWindowLabel = "main" | "home";
export type NativeSurface = NativeWindowLabel;

export type NativeLogicalPoint = Readonly<{
  x: number;
  y: number;
}>;

export type NativeLogicalRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type NativeWindowTopLeftLogical = Readonly<{
  space: "WINDOW_TOP_LEFT_LOGICAL";
  x: number;
  y: number;
}>;

export type NativePhysicalRect = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

export interface NativeHomeWindowSnapshot {
  readonly ready: boolean;
  readonly currentMonitorId: string;
  readonly windowScaleFactor: number;
  /** Actual physical outer rectangle divided once by Main's HWND scale. */
  readonly rect: NativeLogicalRect;
}

export interface NativeDesktopSnapshotV1 {
  readonly protocolVersion: NativePlatformProtocolVersion;
  readonly snapshotRevision: number;
  readonly capturedAtMonotonicMs: number;
  readonly currentMonitorId: string;
  readonly workArea: NativeLogicalRect;
  readonly windowPosition: NativeWindowTopLeftLogical;
  readonly monitorScaleFactor: number;
  readonly windowScaleFactor: number;
  readonly homeWindow: NativeHomeWindowSnapshot | null;
}

export interface NativePointerSnapshotV1 {
  readonly protocolVersion: NativePlatformProtocolVersion;
  readonly snapshotRevision: number;
  readonly capturedAtMonotonicMs: number;
  readonly cursorScreenLogical: NativeLogicalPoint;
  readonly windowOuterTopLeftLogical: NativeLogicalPoint;
  readonly relativeLogical: NativeLogicalPoint;
  readonly scaleFactor: number;
}

export type NativeFocusedInputGeometryKind =
  | "none"
  | "dynamic-line"
  | "system-caret"
  | "text-focus-only"
  | "error";

export interface NativeFocusedInputSnapshotRequest {
  /** Sampler sends integer monotonic milliseconds; response echoes unchanged. */
  readonly requestStartedAtMonotonic: number;
  readonly requestRevision: number;
  readonly monitorRevision: number;
  readonly disposeGeneration: number;
}

export interface NativeFocusedInputSnapshotResponse
  extends NativeFocusedInputSnapshotRequest {
  readonly kind: NativeFocusedInputGeometryKind;
  readonly rectPhysical: NativePhysicalRect | null;
  readonly approximate: boolean;
  readonly textFocus: boolean;
  readonly activeCaret: boolean;
  readonly singleVisualBand: boolean;
  readonly caretEvidenceKind: string | null;
  /**
   * `true` when the native worker skipped the sample because it was still
   * busy. The payload then carries no focus information and must not be
   * treated as "no focused input".
   */
  readonly busy: boolean;
  readonly errorCode?: string;
}

export interface NativeSetOverlayFrameArgs {
  readonly coordinateScaleFactor?: number;
  readonly windowLabel: NativeWindowLabel;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeSetOverlayPositionArgs {
  /** Scale of the snapshot whose logical coordinates this request uses. */
  readonly coordinateScaleFactor?: number;
  readonly windowLabel: NativeWindowLabel;
  readonly x: number;
  readonly y: number;
}

export interface NativeSetOverlayVisibilityArgs {
  readonly windowLabel: NativeWindowLabel;
  readonly visible: boolean;
}

export interface NativeSetOverlayOpacityArgs {
  readonly windowLabel: NativeWindowLabel;
  readonly opacity: number;
}

export interface NativeSetWindowClickThroughArgs {
  readonly windowLabel: NativeWindowLabel;
  readonly ignore: boolean;
}

export interface NativeSurfaceReadyV1 {
  readonly protocolVersion: NativePlatformProtocolVersion;
  readonly surface: NativeSurface;
  readonly ready: true;
  readonly alreadyReady: boolean;
}

type NativeEmptyArgs = Readonly<Record<string, never>>;

export interface NativePlatformCommandArgs {
  readonly desktop_snapshot: NativeEmptyArgs;
  readonly focused_input_snapshot: NativeFocusedInputSnapshotRequest;
  readonly pointer_snapshot: NativeEmptyArgs;
  readonly set_overlay_frame: NativeSetOverlayFrameArgs;
  readonly set_overlay_position: NativeSetOverlayPositionArgs;
  readonly set_overlay_visibility: NativeSetOverlayVisibilityArgs;
  readonly set_overlay_opacity: NativeSetOverlayOpacityArgs;
  readonly set_window_click_through: NativeSetWindowClickThroughArgs;
  readonly begin_native_drag: Readonly<{ windowLabel: NativeWindowLabel }>;
  readonly surface_ready: Readonly<{ surface: NativeSurface }>;
  readonly exit_application: NativeEmptyArgs;
}

export type NativePlatformCommandName = keyof NativePlatformCommandArgs;

export type NativePlatformInvoker = <K extends NativePlatformCommandName>(
  command: K,
  args: NativePlatformCommandArgs[K],
) => Promise<unknown>;

export interface NativePlatformPort {
  desktopSnapshot(): Promise<NativeDesktopSnapshotV1>;
  focusedInputSnapshot(
    request: NativeFocusedInputSnapshotRequest,
  ): Promise<NativeFocusedInputSnapshotResponse>;
  pointerSnapshot(): Promise<NativePointerSnapshotV1>;
  setOverlayFrame(args: NativeSetOverlayFrameArgs): Promise<void>;
  setOverlayPosition(args: NativeSetOverlayPositionArgs): Promise<void>;
  setOverlayVisibility(args: NativeSetOverlayVisibilityArgs): Promise<void>;
  setOverlayOpacity(args: NativeSetOverlayOpacityArgs): Promise<void>;
  setWindowClickThrough(args: NativeSetWindowClickThroughArgs): Promise<void>;
  beginNativeDrag(windowLabel: NativeWindowLabel): Promise<void>;
  surfaceReady(surface: NativeSurface): Promise<NativeSurfaceReadyV1>;
  exitApplication(): Promise<void>;
}

const defaultNativeInvoker: NativePlatformInvoker = (command, args) =>
  tauriInvoke<unknown>(command, { ...args });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isNativeWindowLabel(
  value: unknown,
): value is NativeWindowLabel {
  return value === "main" || value === "home";
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNativeLogicalPoint(value: unknown): value is NativeLogicalPoint {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y)
  );
}

function isNativeLogicalRect(value: unknown): value is NativeLogicalRect {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isPositiveFiniteNumber(value.width) &&
    isPositiveFiniteNumber(value.height)
  );
}

function isNativeWindowTopLeftLogical(
  value: unknown,
): value is NativeWindowTopLeftLogical {
  return (
    isRecord(value) &&
    value.space === "WINDOW_TOP_LEFT_LOGICAL" &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y)
  );
}

function isNativePhysicalRect(value: unknown): value is NativePhysicalRect {
  return (
    isRecord(value) &&
    isFiniteNumber(value.left) &&
    isFiniteNumber(value.top) &&
    isFiniteNumber(value.right) &&
    isFiniteNumber(value.bottom) &&
    value.right > value.left &&
    value.bottom > value.top
  );
}

function hasNativeProtocol(value: Record<string, unknown>): boolean {
  return value.protocolVersion === NATIVE_PLATFORM_PROTOCOL_VERSION;
}

export function isNativeDesktopSnapshotV1(
  value: unknown,
): value is NativeDesktopSnapshotV1 {
  return (
    isRecord(value) &&
    hasNativeProtocol(value) &&
    isNonNegativeInteger(value.snapshotRevision) &&
    isFiniteNumber(value.capturedAtMonotonicMs) &&
    value.capturedAtMonotonicMs >= 0 &&
    isNonEmptyString(value.currentMonitorId) &&
    isNativeLogicalRect(value.workArea) &&
    isNativeWindowTopLeftLogical(value.windowPosition) &&
    isPositiveFiniteNumber(value.monitorScaleFactor) &&
    isPositiveFiniteNumber(value.windowScaleFactor) &&
    (value.homeWindow === null || (isRecord(value.homeWindow) &&
      typeof value.homeWindow.ready === "boolean" &&
      isNonEmptyString(value.homeWindow.currentMonitorId) &&
      isPositiveFiniteNumber(value.homeWindow.windowScaleFactor) &&
      isNativeLogicalRect(value.homeWindow.rect)))
  );
}

export function isNativePointerSnapshotV1(
  value: unknown,
): value is NativePointerSnapshotV1 {
  return (
    isRecord(value) &&
    hasNativeProtocol(value) &&
    isNonNegativeInteger(value.snapshotRevision) &&
    isFiniteNumber(value.capturedAtMonotonicMs) &&
    value.capturedAtMonotonicMs >= 0 &&
    isNativeLogicalPoint(value.cursorScreenLogical) &&
    isNativeLogicalPoint(value.windowOuterTopLeftLogical) &&
    isNativeLogicalPoint(value.relativeLogical) &&
    isPositiveFiniteNumber(value.scaleFactor)
  );
}

function isNativeFocusedInputGeometryKind(
  value: unknown,
): value is NativeFocusedInputGeometryKind {
  return (
    value === "none" ||
    value === "dynamic-line" ||
    value === "system-caret" ||
    value === "text-focus-only" ||
    value === "error"
  );
}

export function isNativeFocusedInputSnapshotResponse(
  value: unknown,
): value is NativeFocusedInputSnapshotResponse {
  return (
    isRecord(value) &&
    isFiniteNumber(value.requestStartedAtMonotonic) &&
    isNonNegativeInteger(value.requestRevision) &&
    isNonNegativeInteger(value.monitorRevision) &&
    isNonNegativeInteger(value.disposeGeneration) &&
    isNativeFocusedInputGeometryKind(value.kind) &&
    (value.rectPhysical === null || isNativePhysicalRect(value.rectPhysical)) &&
    typeof value.approximate === "boolean" &&
    typeof value.textFocus === "boolean" &&
    typeof value.activeCaret === "boolean" &&
    typeof value.singleVisualBand === "boolean" &&
    typeof value.busy === "boolean" &&
    (value.caretEvidenceKind === null ||
      typeof value.caretEvidenceKind === "string") &&
    (value.errorCode === undefined || typeof value.errorCode === "string")
  );
}

export function isNativeSurfaceReadyV1(
  value: unknown,
): value is NativeSurfaceReadyV1 {
  return (
    isRecord(value) &&
    hasNativeProtocol(value) &&
    isNativeWindowLabel(value.surface) &&
    value.ready === true &&
    typeof value.alreadyReady === "boolean"
  );
}

function assertNativeWindowLabel(value: NativeWindowLabel): void {
  if (!isNativeWindowLabel(value)) {
    throw new Error("LineDog Native window label is invalid.");
  }
}

function assertFinite(value: number, label: string): void {
  if (!isFiniteNumber(value)) {
    throw new Error(`LineDog Native ${label} must be finite.`);
  }
}

function assertPositive(value: number, label: string): void {
  if (!isPositiveFiniteNumber(value)) {
    throw new Error(
      `LineDog Native ${label} must be finite and greater than zero.`,
    );
  }
}

function assertFocusedInputRequest(
  request: NativeFocusedInputSnapshotRequest,
): void {
  assertFinite(request.requestStartedAtMonotonic, "request timestamp");
  if (!isNonNegativeInteger(request.requestRevision)) {
    throw new Error("LineDog Native request revision is invalid.");
  }
  if (!isNonNegativeInteger(request.monitorRevision)) {
    throw new Error("LineDog Native monitor revision is invalid.");
  }
  if (!isNonNegativeInteger(request.disposeGeneration)) {
    throw new Error("LineDog Native dispose generation is invalid.");
  }
}

export class NativePlatformAdapter implements NativePlatformPort {
  private latestDesktopSnapshot: NativeDesktopSnapshotV1 | undefined;
  constructor(
    private readonly invokeCommand: NativePlatformInvoker =
      defaultNativeInvoker,
    private readonly onDesktopSnapshot?: (snapshot: NativeDesktopSnapshotV1) => void,
  ) {}

  async desktopSnapshot(): Promise<NativeDesktopSnapshotV1> {
    const snapshot = await this.invokeValidated(
      "desktop_snapshot",
      {},
      isNativeDesktopSnapshotV1,
      "desktop snapshot",
    );
    const latest = this.latestDesktopSnapshot;
    // Startup consumers overlap. A late response must neither roll facts back
    // nor abort their one-time initialization when newer valid facts exist.
    if (latest && snapshot.snapshotRevision < latest.snapshotRevision) return latest;
    this.latestDesktopSnapshot = snapshot;
    this.onDesktopSnapshot?.(snapshot);
    return snapshot;
  }

  async focusedInputSnapshot(
    request: NativeFocusedInputSnapshotRequest,
  ): Promise<NativeFocusedInputSnapshotResponse> {
    assertFocusedInputRequest(request);
    return this.invokeValidated(
      "focused_input_snapshot",
      request,
      isNativeFocusedInputSnapshotResponse,
      "focused input snapshot",
    );
  }

  async pointerSnapshot(): Promise<NativePointerSnapshotV1> {
    return this.invokeValidated(
      "pointer_snapshot",
      {},
      isNativePointerSnapshotV1,
      "pointer snapshot",
    );
  }

  async setOverlayFrame(args: NativeSetOverlayFrameArgs): Promise<void> {
    if (args.coordinateScaleFactor !== undefined) assertPositive(args.coordinateScaleFactor, "coordinate scale factor");
    assertNativeWindowLabel(args.windowLabel);
    assertFinite(args.x, "overlay frame x");
    assertFinite(args.y, "overlay frame y");
    assertPositive(args.width, "overlay frame width");
    assertPositive(args.height, "overlay frame height");
    await this.invokeCommand("set_overlay_frame", args);
  }

  async setOverlayPosition(args: NativeSetOverlayPositionArgs): Promise<void> {
    assertNativeWindowLabel(args.windowLabel);
    assertFinite(args.x, "overlay position x");
    assertFinite(args.y, "overlay position y");
    if (args.coordinateScaleFactor !== undefined &&
        (!isFiniteNumber(args.coordinateScaleFactor) || args.coordinateScaleFactor <= 0)) {
      throw new Error("LineDog Native coordinate scale must be positive and finite.");
    }
    await this.invokeCommand("set_overlay_position", args);
  }

  async setOverlayVisibility(
    args: NativeSetOverlayVisibilityArgs,
  ): Promise<void> {
    assertNativeWindowLabel(args.windowLabel);
    await this.invokeCommand("set_overlay_visibility", args);
  }

  async setOverlayOpacity(args: NativeSetOverlayOpacityArgs): Promise<void> {
    assertNativeWindowLabel(args.windowLabel);
    if (!isFiniteNumber(args.opacity) || args.opacity < 0 || args.opacity > 1) {
      throw new Error("LineDog Native overlay opacity must be within [0, 1].");
    }
    await this.invokeCommand("set_overlay_opacity", args);
  }

  async setWindowClickThrough(
    args: NativeSetWindowClickThroughArgs,
  ): Promise<void> {
    assertNativeWindowLabel(args.windowLabel);
    await this.invokeCommand("set_window_click_through", args);
  }

  async beginNativeDrag(windowLabel: NativeWindowLabel): Promise<void> {
    assertNativeWindowLabel(windowLabel);
    await this.invokeCommand("begin_native_drag", { windowLabel });
  }

  async surfaceReady(surface: NativeSurface): Promise<NativeSurfaceReadyV1> {
    assertNativeWindowLabel(surface);
    return this.invokeValidated(
      "surface_ready",
      { surface },
      isNativeSurfaceReadyV1,
      "surface ready",
    );
  }

  async exitApplication(): Promise<void> {
    await this.invokeCommand("exit_application", {});
  }

  private async invokeValidated<T, K extends NativePlatformCommandName>(
    command: K,
    args: NativePlatformCommandArgs[K],
    guard: (value: unknown) => value is T,
    label: string,
  ): Promise<T> {
    const value = await this.invokeCommand(command, args);
    if (!guard(value)) {
      throw new Error(`LineDog Native ${label} payload is invalid.`);
    }
    return value;
  }
}
