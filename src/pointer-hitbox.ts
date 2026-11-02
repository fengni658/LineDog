import type {
  NativeLogicalPoint,
  NativePlatformPort,
  NativePointerSnapshotV1,
} from "./native-platform";
import type { LogicalHitBox } from "./pet-manifest";

export type { LogicalHitBox } from "./pet-manifest";

export const VIEWPORT_SIZE = 160;
export const HIT_BOX = {
  x: 32,
  y: 28,
  width: 96,
  height: 110,
} as const satisfies LogicalHitBox;
export const HIT_BOX_EXIT_HYSTERESIS = 8;
export const POLL_INTERVAL_MS = 1000 / 30;

export type LogicalPoint = NativeLogicalPoint;
export type GlobalPointerSample = NativePointerSnapshotV1;

/** The frozen platform subset consumed by the pointer/click-through spike. */
export type NativeWindowPort = Pick<
  NativePlatformPort,
  "pointerSnapshot" | "setWindowClickThrough"
>;

export interface PointerHitBoxView {
  setPressed(pressed: boolean): void;
}

export type PointerHitBoxErrorReporter = (
  operation: string,
  error: unknown,
) => void;

export interface PointerHitBoxOptions {
  reportError?: PointerHitBoxErrorReporter;
  onPointerSample?: (sample: Readonly<GlobalPointerSample>) => void;
}

type Rectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

function isValidHitBox(value: LogicalHitBox): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.x >= 0 &&
    value.y >= 0 &&
    value.width > 0 &&
    value.height > 0 &&
    value.x + value.width <= VIEWPORT_SIZE &&
    value.y + value.height <= VIEWPORT_SIZE
  );
}

function isInside(point: LogicalPoint, rectangle: Rectangle): boolean {
  return (
    point.x >= rectangle.x &&
    point.x <= rectangle.x + rectangle.width &&
    point.y >= rectangle.y &&
    point.y <= rectangle.y + rectangle.height
  );
}

function expand(rectangle: Rectangle, amount: number): Rectangle {
  return {
    x: rectangle.x - amount,
    y: rectangle.y - amount,
    width: rectangle.width + amount * 2,
    height: rectangle.height + amount * 2,
  };
}

export function isPointInsideHitBox(
  point: LogicalPoint,
  hitBox: LogicalHitBox = HIT_BOX,
): boolean {
  return isInside(point, isValidHitBox(hitBox) ? hitBox : HIT_BOX);
}

/** Resolves the active frame hitBox before the animation fallback. */
export function resolveHitBox(
  frameHitBox: LogicalHitBox | undefined,
  animationHitBox: LogicalHitBox | undefined,
  fallback: LogicalHitBox = HIT_BOX,
): LogicalHitBox {
  if (frameHitBox !== undefined && isValidHitBox(frameHitBox)) {
    return { ...frameHitBox };
  }
  if (animationHitBox !== undefined && isValidHitBox(animationHitBox)) {
    return { ...animationHitBox };
  }
  return isValidHitBox(fallback) ? { ...fallback } : { ...HIT_BOX };
}

export function resolveHitState(
  point: LogicalPoint,
  wasInside: boolean,
  hitBox: LogicalHitBox = HIT_BOX,
): boolean {
  const activeHitBox = isValidHitBox(hitBox) ? hitBox : HIT_BOX;
  return isInside(
    point,
    wasInside
      ? expand(activeHitBox, HIT_BOX_EXIT_HYSTERESIS)
      : activeHitBox,
  );
}

export function createOnceErrorReporter(): PointerHitBoxErrorReporter {
  const reportedOperations = new Set<string>();

  return (operation, error) => {
    if (reportedOperations.has(operation)) {
      return;
    }

    reportedOperations.add(operation);
    console.warn(`[LineDog Pointer HitBox] ${operation} failed.`, error);
  };
}

export class PointerHitBoxController {
  private currentHitState = false;
  private currentHitBox: LogicalHitBox = { ...HIT_BOX };
  private lastRequestedIgnoreCursorEvents: boolean | undefined;
  private clickThroughQueue: Promise<void> = Promise.resolve();
  private isPressed = false;
  private pollingTimer: number | undefined;
  private pollInFlight = false;
  private interactionLocked = false;
  private unlockRefreshPending = false;
  private safetyRevision = 0;
  private disposed = false;
  private latestSample: GlobalPointerSample | undefined;
  private readonly reportError: PointerHitBoxErrorReporter;
  private readonly onPointerSample: (sample: Readonly<GlobalPointerSample>) => void;

  constructor(
    private readonly nativeWindow: NativeWindowPort,
    private readonly view: PointerHitBoxView,
    options: PointerHitBoxOptions = {},
  ) {
    this.reportError = options.reportError ?? createOnceErrorReporter();
    this.onPointerSample = options.onPointerSample ?? (() => undefined);
  }

  get latestPointerSample(): Readonly<GlobalPointerSample> | undefined {
    return this.latestSample
      ? {
          ...this.latestSample,
          cursorScreenLogical: { ...this.latestSample.cursorScreenLogical },
          windowOuterTopLeftLogical: {
            ...this.latestSample.windowOuterTopLeftLogical,
          },
          relativeLogical: { ...this.latestSample.relativeLogical },
        }
      : undefined;
  }

  setHitBox(hitBox: LogicalHitBox | undefined): void {
    this.currentHitBox = resolveHitBox(hitBox, undefined);
  }

  isPointInsideCurrentHitBox(point: LogicalPoint): boolean {
    return isPointInsideHitBox(point, this.currentHitBox);
  }

  async readPointerSample(): Promise<GlobalPointerSample> {
    const sample = await this.nativeWindow.pointerSnapshot();
    this.latestSample = {
      ...sample,
      cursorScreenLogical: { ...sample.cursorScreenLogical },
      windowOuterTopLeftLogical: { ...sample.windowOuterTopLeftLogical },
      relativeLogical: { ...sample.relativeLogical },
    };

    try {
      this.onPointerSample(this.latestSample);
    } catch (error) {
      this.reportError("pointer sample callback", error);
    }

    return this.latestSample;
  }

  async samplePointer(): Promise<void> {
    if (this.pollInFlight || this.disposed) {
      return;
    }

    this.pollInFlight = true;
    const revision = this.safetyRevision;

    try {
      const sample = await this.readPointerSample();
      if (this.disposed || revision !== this.safetyRevision) return;
      const nextHitState = resolveHitState(
        sample.relativeLogical,
        this.currentHitState,
        this.currentHitBox,
      );

      this.currentHitState = nextHitState;
      const appliedUnlockedPolicy = !this.interactionLocked;
      await this.requestIgnoreCursorEvents(appliedUnlockedPolicy ? !nextHitState : false);
      if (appliedUnlockedPolicy && revision === this.safetyRevision && !this.interactionLocked) {
        this.unlockRefreshPending = false;
      }
    } catch (error) {
      this.reportError("pointer sampling", error);
    } finally {
      this.pollInFlight = false;
    }
  }

  startPolling(): void {
    if (this.pollingTimer !== undefined) {
      return;
    }

    void this.forceSafeClickThrough();
    void this.samplePointer();
    this.pollingTimer = globalThis.setInterval(() => {
      void this.samplePointer();
    }, POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.pollingTimer === undefined) {
      return;
    }

    globalThis.clearInterval(this.pollingTimer);
    this.pollingTimer = undefined;
    // A release may be waiting for the regular poll. Stopping that timer must
    // not leave its old interaction lock intercepting the desktop indefinitely.
    if (this.unlockRefreshPending && !this.disposed) {
      void this.setInteractionLock(false);
    }
  }

  setPointerPressed(pressed: boolean): void {
    this.setPressed(pressed);
  }

  async setInteractionLock(locked: boolean): Promise<void> {
    if (this.disposed) return;
    this.interactionLocked = locked;

    if (locked) {
      this.safetyRevision += 1;
      this.unlockRefreshPending = false;
      await this.requestIgnoreCursorEvents(false);
      return;
    }

    if (this.pollingTimer !== undefined) {
      // A poll begun under this lock may safely use the now-unlocked state.
      // Keep its epoch, but never revive a pre-lock sample. New locks and blur
      // still invalidate it. Avoid an extra Native read ahead of the next tap.
      this.unlockRefreshPending = true;
      return;
    }

    const revision = ++this.safetyRevision;
    this.unlockRefreshPending = false;
    try {
      const sample = await this.readPointerSample();
      if (this.disposed || revision !== this.safetyRevision) return;
      const nextHitState = resolveHitState(
        sample.relativeLogical,
        this.currentHitState,
        this.currentHitBox,
      );
      this.currentHitState = nextHitState;
      await this.requestIgnoreCursorEvents(!nextHitState);
    } catch (error) {
      this.reportError("pointer sampling", error);
    }
  }

  async forceSafeClickThrough(): Promise<void> {
    this.safetyRevision += 1;
    this.interactionLocked = false;
    this.unlockRefreshPending = false;
    this.currentHitState = false;
    this.setPressed(false);
    await this.requestIgnoreCursorEvents(true);
  }

  dispose(): void {
    this.disposed = true;
    this.stopPolling();
    void this.forceSafeClickThrough();
  }

  private setPressed(pressed: boolean): void {
    if (this.isPressed === pressed) {
      return;
    }

    this.isPressed = pressed;
    this.view.setPressed(pressed);
  }

  private async requestIgnoreCursorEvents(ignore: boolean): Promise<void> {
    // Serialize native writes so a late polling response cannot overwrite a
    // drag lock or the final safe pass-through request.
    const request = this.clickThroughQueue.then(async () => {
      if (this.lastRequestedIgnoreCursorEvents === ignore) return;
      try {
        await this.nativeWindow.setWindowClickThrough({ windowLabel: "main", ignore });
        this.lastRequestedIgnoreCursorEvents = ignore;
      } catch (error) {
        this.lastRequestedIgnoreCursorEvents = undefined;
        this.reportError("set cursor pass-through", error);
      }
    });
    this.clickThroughQueue = request;
    await request;
  }
}
