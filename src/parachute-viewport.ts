import {
  NATIVE_WINDOW_SIZE_LOGICAL,
  type NativeDesktopSnapshotV1,
  type NativeFocusedInputSnapshotRequest,
  type NativePlatformPort,
  type NativeSetOverlayFrameArgs,
  type NativeSetOverlayOpacityArgs,
  type NativeSetOverlayPositionArgs,
  type NativeSetOverlayVisibilityArgs,
  type NativeSetWindowClickThroughArgs,
  type NativeSurface,
  type NativeWindowLabel,
} from "./native-platform";
import { PET_BEHAVIOR_CONFIG, RUNTIME_FOOT_BASELINE_LOGICAL_PX } from "./pet-behavior-core";

export const PARACHUTE_TOP_INSET_LOGICAL = PET_BEHAVIOR_CONFIG.parachute.viewportTopInsetLogicalPx;
type TopInset = 0 | typeof PARACHUTE_TOP_INSET_LOGICAL;
type PhysicalAnchor = Readonly<{ x: number; y: number; scale: number; preserveFoot?: boolean }>;

export interface ParachuteViewportOptions {
  readonly onInsetChange?: (inset: TopInset) => void;
  readonly onDesktopSnapshot?: (snapshot: NativeDesktopSnapshotV1) => void;
  readonly onUnsafe?: (error: Error) => void;
  readonly reportError?: (operation: string, error: unknown) => void;
}

/**
 * Native Main may temporarily be 160x240, while every consumer still uses
 * the 160x160 dog canvas. Native facts and commands cross this boundary once.
 * The serial boundary also prevents samples observing a half-applied frame.
 */
export class ParachuteViewportAdapter implements NativePlatformPort {
  private inset: TopInset = 0;
  private known = true;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private recoveryAnchor: PhysicalAnchor | undefined;
  private lastWindowScale: number | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly native: NativePlatformPort,
    private readonly options: ParachuteViewportOptions = {},
  ) {}

  get topInset(): TopInset { return this.inset; }
  get geometryKnown(): boolean { return this.known; }

  setExpanded(expanded: boolean): Promise<boolean> {
    const generation = ++this.generation;
    return this.serialize(async () => {
      this.assertActive();
      if (generation !== this.generation) return false;
      const nextInset: TopInset = expanded ? PARACHUTE_TOP_INSET_LOGICAL : 0;
      if (this.known && this.inset === nextInset) return true;
      // Collapsing is the explicit repair path after an incomplete rollback.
      if (!this.known) {
        if (expanded || !this.recoveryAnchor) this.assertKnown();
        const anchor = this.recoveryAnchor!;
        try {
          const actual = await this.writeVerifiedFrame(anchor, 0);
          this.commitInset(0);
          if (actual.windowScaleFactor !== anchor.scale) this.publishSnapshot(actual);
          return generation === this.generation;
        } catch (error) {
          this.markUnsafe(error);
          throw error;
        }
      }
      const snapshot = await this.native.desktopSnapshot();
      if (generation !== this.generation) return false;
      const previousInset = this.inset;
      const anchor = this.anchorFrom(snapshot, previousInset);
      // Leave room above the dog even if the monitor changed after Runtime's
      // eligibility check. Refusing here leaves ordinary FALL available.
      if (expanded && snapshot.windowPosition.y + previousInset - nextInset < snapshot.workArea.y) return false;
      let actual: NativeDesktopSnapshotV1;
      try {
        actual = await this.writeVerifiedFrame(anchor, nextInset);
      } catch (error) {
        await this.rollback(anchor, previousInset, error);
        throw error;
      }
      if (generation !== this.generation) {
        // A later drag/collapse/layout request owns the outcome. Do not flash
        // a stale CSS inset, and restore before allowing queued moves through.
        await this.rollback(anchor, previousInset, new Error("parachute_viewport_cancelled"));
        return false;
      }
      this.commitInset(nextInset);
      if (actual.windowScaleFactor !== anchor.scale) this.publishSnapshot(actual);
      return generation === this.generation;
    });
  }

  desktopSnapshot(): Promise<NativeDesktopSnapshotV1> {
    return this.serialize(async () => {
      this.assertActive();
      this.assertKnown();
      let raw = await this.native.desktopSnapshot();
      if (this.inset && this.lastWindowScale !== undefined && raw.windowScaleFactor !== this.lastWindowScale) {
        // An OS DPI transition may resize the physical surface. Reassert its
        // logical dimensions at the currently visible dog position.
        const anchor = this.anchorFrom(raw, this.inset);
        try {
          raw = await this.writeVerifiedFrame(anchor, this.inset);
        } catch (error) {
          await this.rollback(anchor, this.inset, error);
          throw error;
        }
      }
      this.lastWindowScale = raw.windowScaleFactor;
      return this.publishSnapshot(raw);
    });
  }

  pointerSnapshot() {
    return this.serialize(async () => {
      this.assertActive();
      this.assertKnown();
      const raw = await this.native.pointerSnapshot();
      return {
        ...raw,
        windowOuterTopLeftLogical: { ...raw.windowOuterTopLeftLogical, y: raw.windowOuterTopLeftLogical.y + this.inset },
        relativeLogical: { ...raw.relativeLogical, y: raw.relativeLogical.y - this.inset },
      };
    });
  }

  setOverlayPosition(args: NativeSetOverlayPositionArgs): Promise<void> {
    if (args.windowLabel !== "main") return this.native.setOverlayPosition(args);
    return this.serialize(async () => {
      this.assertActive();
      this.assertKnown();
      if (!this.inset) return this.native.setOverlayPosition(args);
      const before = await this.native.desktopSnapshot();
      const scaleAlreadyChanged = this.lastWindowScale !== undefined && before.windowScaleFactor !== this.lastWindowScale;
      const scale = args.coordinateScaleFactor ?? before.windowScaleFactor;
      const anchor = { x: args.x * scale, y: args.y * scale, scale: before.windowScaleFactor };
      // Motion coordinates can still belong to the previous monitor's scale.
      // CSS inset belongs to the actual HWND, so convert its physical size
      // into that command's coordinate space before the native conversion.
      await this.native.setOverlayPosition({ ...args, coordinateScaleFactor: scale,
        y: args.y - this.inset * before.windowScaleFactor / scale });
      const actual = await this.native.desktopSnapshot();
      this.lastWindowScale = actual.windowScaleFactor;
      if (scaleAlreadyChanged || actual.windowScaleFactor !== before.windowScaleFactor) {
        const atCurrentScale = { ...anchor, scale: actual.windowScaleFactor };
        try {
          const corrected = await this.writeVerifiedFrame(atCurrentScale, this.inset);
          this.publishSnapshot(corrected);
        } catch (error) {
          await this.rollback(atCurrentScale, this.inset, error);
          throw error;
        }
      }
    });
  }

  setOverlayFrame(args: NativeSetOverlayFrameArgs): Promise<void> {
    if (args.windowLabel !== "main") return this.native.setOverlayFrame(args);
    // A canonical layout command supersedes any pending parachute expansion.
    ++this.generation;
    return this.serialize(async () => {
      this.assertActive();
      if (args.width !== NATIVE_WINDOW_SIZE_LOGICAL || args.height !== NATIVE_WINDOW_SIZE_LOGICAL) {
        throw new Error("parachute_viewport_requires_canonical_frame");
      }
      const previousInset = this.inset;
      const before = this.known ? await this.native.desktopSnapshot() : undefined;
      const previous = before ? this.anchorFrom(before, previousInset) : this.recoveryAnchor;
      const scale = args.coordinateScaleFactor ?? before?.windowScaleFactor ?? previous?.scale;
      if (!scale) throw new Error("parachute_viewport_geometry_unknown");
      const target = { x: args.x * scale, y: args.y * scale, scale };
      try {
        await this.writeVerifiedFrame(target, 0);
      } catch (error) {
        if (previous) await this.rollback(previous, previousInset, error);
        else this.markUnsafe(error);
        throw error;
      }
      this.commitInset(0);
    });
  }

  focusedInputSnapshot(request: NativeFocusedInputSnapshotRequest) {
    return this.native.focusedInputSnapshot(request);
  }
  setOverlayVisibility(args: NativeSetOverlayVisibilityArgs) { return this.native.setOverlayVisibility(args); }
  setOverlayOpacity(args: NativeSetOverlayOpacityArgs) { return this.native.setOverlayOpacity(args); }
  setWindowClickThrough(args: NativeSetWindowClickThroughArgs): Promise<void> {
    if (args.windowLabel !== "main") return this.native.setWindowClickThrough(args);
    return this.serialize(async () => {
      this.assertActive();
      if (!args.ignore) this.assertKnown();
      await this.native.setWindowClickThrough(args);
    });
  }
  beginNativeDrag(windowLabel: NativeWindowLabel): Promise<void> {
    if (windowLabel !== "main") return this.native.beginNativeDrag(windowLabel);
    return this.serialize(async () => {
      this.assertActive();
      this.assertKnown();
      await this.native.beginNativeDrag(windowLabel);
    });
  }
  surfaceReady(surface: NativeSurface) { return this.native.surfaceReady(surface); }
  exitApplication() { return this.native.exitApplication(); }

  /** Invalidate callbacks immediately and restore any temporary native inset. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    ++this.generation;
    this.disposal = this.serialize(async () => {
      if (this.known && !this.inset) return;
      const anchor = this.known
        ? this.anchorFrom(await this.native.desktopSnapshot(), this.inset)
        : this.recoveryAnchor;
      if (!anchor) this.assertKnown();
      try {
        await this.writeVerifiedFrame(anchor!, 0);
        this.commitInset(0);
      } catch (error) {
        this.markUnsafe(error);
        throw error;
      }
    });
    return this.disposal;
  }

  private anchorFrom(snapshot: NativeDesktopSnapshotV1, inset: TopInset): PhysicalAnchor {
    return {
      x: snapshot.windowPosition.x * snapshot.windowScaleFactor,
      y: (snapshot.windowPosition.y + inset) * snapshot.windowScaleFactor,
      scale: snapshot.windowScaleFactor,
      preserveFoot: true,
    };
  }

  private async writeVerifiedFrame(anchor: PhysicalAnchor, inset: TopInset,
    initialScale = anchor.scale): Promise<NativeDesktopSnapshotV1> {
    this.recoveryAnchor = anchor;
    let scale = initialScale;
    // A move can change HWND DPI. A second write fixes the dimensions and
    // inset in the new space; continuing scale churn fails closed.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Expansion/collapse is a viewport change, so retain the visible foot
      // center even if that frame changes DPI. Explicit layout/motion targets
      // instead retain their caller's physical top-left coordinates.
      const scaleDelta = anchor.preserveFoot ? anchor.scale - scale : 0;
      const x = anchor.x + NATIVE_WINDOW_SIZE_LOGICAL / 2 * scaleDelta;
      const y = anchor.y + RUNTIME_FOOT_BASELINE_LOGICAL_PX * scaleDelta;
      await this.native.setOverlayFrame({ windowLabel: "main", coordinateScaleFactor: scale,
        x: x / scale, y: y / scale - inset,
        width: NATIVE_WINDOW_SIZE_LOGICAL, height: NATIVE_WINDOW_SIZE_LOGICAL + inset });
      const actual = await this.native.desktopSnapshot();
      this.lastWindowScale = actual.windowScaleFactor;
      const matches = Math.abs(actual.windowPosition.x * scale - x) <= 0.500001 &&
        Math.abs((actual.windowPosition.y + inset) * scale - y) <= 0.500001;
      if (actual.windowScaleFactor === scale && matches) return actual;
      if (actual.windowScaleFactor === scale) throw new Error("parachute_viewport_readback_mismatch");
      scale = actual.windowScaleFactor;
    }
    throw new Error("parachute_viewport_unstable_scale");
  }

  private async rollback(anchor: PhysicalAnchor, inset: TopInset, originalError: unknown): Promise<void> {
    try {
      // The native command can fail after either position or size has changed.
      // Reapply both, rather than assuming its rejection means no mutation.
      const actual = await this.writeVerifiedFrame(anchor, inset, this.lastWindowScale ?? anchor.scale);
      this.commitInset(inset);
      if (actual.windowScaleFactor !== anchor.scale) this.publishSnapshot(actual);
    } catch (rollbackError) {
      this.markUnsafe(new AggregateError([originalError, rollbackError], "parachute_viewport_geometry_unknown"));
      throw new Error("parachute_viewport_geometry_unknown", { cause: rollbackError });
    }
  }

  private commitInset(inset: TopInset): void {
    const changed = this.inset !== inset;
    this.inset = inset;
    this.known = true;
    if (changed) this.observe(() => this.options.onInsetChange?.(inset));
  }

  private publishSnapshot(raw: NativeDesktopSnapshotV1): NativeDesktopSnapshotV1 {
    const snapshot = { ...raw, windowPosition: { ...raw.windowPosition, y: raw.windowPosition.y + this.inset } };
    this.observe(() => this.options.onDesktopSnapshot?.(snapshot));
    return snapshot;
  }

  private markUnsafe(error: unknown): void {
    this.known = false;
    this.observe(() => this.options.onUnsafe?.(error instanceof Error ? error : new Error("parachute_viewport_geometry_unknown")));
  }

  private assertKnown(): void {
    if (!this.known) throw new Error("parachute_viewport_geometry_unknown");
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("parachute_viewport_disposed");
  }

  private observe(callback: () => void): void {
    if (this.disposed) return;
    try { callback(); }
    catch (error) {
      try { this.options.reportError?.("parachute viewport observer", error); }
      catch { /* An observer cannot undo an already committed native frame. */ }
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
