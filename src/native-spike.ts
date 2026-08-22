export const VIEWPORT_SIZE = 160;
export const HIT_BOX = { x: 32, y: 28, width: 96, height: 110 } as const;
export const HIT_BOX_EXIT_HYSTERESIS = 8;
export const POLL_INTERVAL_MS = 1000 / 30;
export const HAPPY_FEEDBACK_DURATION_MS = 260;

export type PhysicalPoint = Readonly<{ x: number; y: number }>;
export type LogicalPoint = Readonly<{ x: number; y: number }>;

export interface NativeWindowPort {
  cursorPosition(): Promise<PhysicalPoint>;
  outerPosition(): Promise<PhysicalPoint>;
  scaleFactor(): Promise<number>;
  setIgnoreCursorEvents(ignore: boolean): Promise<void>;
}

export type ClickThroughCommandInvoker = (
  command: string,
  args: { ignore: boolean },
) => Promise<void>;

export function invokeWindowClickThrough(
  invokeCommand: ClickThroughCommandInvoker,
  ignore: boolean,
): Promise<void> {
  return invokeCommand("set_window_click_through", { ignore });
}

export interface GlobalPointerSample {
  readonly cursorPhysical: PhysicalPoint;
  readonly windowOuterPhysical: PhysicalPoint;
  readonly scaleFactor: number;
  readonly relativeLogical: LogicalPoint;
}

export interface NativeSpikeView {
  setPressed(pressed: boolean): void;
  setHappy(happy: boolean): void;
}

export type NativeSpikeErrorReporter = (
  operation: string,
  error: unknown,
) => void;

export interface NativeSpikeOptions {
  happyFeedbackDurationMs?: number;
  reportError?: NativeSpikeErrorReporter;
  onPointerSample?: (sample: Readonly<GlobalPointerSample>) => void;
}

type Rectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

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

export function physicalToRelativeLogical(
  cursorPhysical: PhysicalPoint,
  windowOuterPhysical: PhysicalPoint,
  scaleFactor: number,
): LogicalPoint {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error("The window scale factor must be a finite value greater than zero.");
  }

  return {
    x: (cursorPhysical.x - windowOuterPhysical.x) / scaleFactor,
    y: (cursorPhysical.y - windowOuterPhysical.y) / scaleFactor,
  };
}

export function resolveHitState(
  point: LogicalPoint,
  wasInside: boolean,
): boolean {
  return isInside(
    point,
    wasInside ? expand(HIT_BOX, HIT_BOX_EXIT_HYSTERESIS) : HIT_BOX,
  );
}

export function createOnceErrorReporter(): NativeSpikeErrorReporter {
  const reportedOperations = new Set<string>();

  return (operation, error) => {
    if (reportedOperations.has(operation)) {
      return;
    }

    reportedOperations.add(operation);
    console.warn(`[LineDog Native Spike] ${operation} failed.`, error);
  };
}

export class NativeSpikeController {
  private currentHitState = false;
  private lastRequestedIgnoreCursorEvents: boolean | undefined;
  private isPressed = false;
  private happyTimer: number | undefined;
  private pollingTimer: number | undefined;
  private pollInFlight = false;
  private interactionLocked = false;
  private latestSample: GlobalPointerSample | undefined;
  private readonly happyFeedbackDurationMs: number;
  private readonly reportError: NativeSpikeErrorReporter;
  private readonly onPointerSample: (sample: Readonly<GlobalPointerSample>) => void;

  constructor(
    private readonly nativeWindow: NativeWindowPort,
    private readonly view: NativeSpikeView,
    options: NativeSpikeOptions = {},
  ) {
    this.happyFeedbackDurationMs =
      options.happyFeedbackDurationMs ?? HAPPY_FEEDBACK_DURATION_MS;
    this.reportError = options.reportError ?? createOnceErrorReporter();
    this.onPointerSample = options.onPointerSample ?? (() => undefined);
  }

  get latestPointerSample(): Readonly<GlobalPointerSample> | undefined {
    return this.latestSample
      ? {
          cursorPhysical: { ...this.latestSample.cursorPhysical },
          windowOuterPhysical: { ...this.latestSample.windowOuterPhysical },
          scaleFactor: this.latestSample.scaleFactor,
          relativeLogical: { ...this.latestSample.relativeLogical },
        }
      : undefined;
  }

  async readPointerSample(): Promise<GlobalPointerSample> {
    const [cursorPhysical, windowOuterPhysical, scaleFactor] = await Promise.all([
      this.nativeWindow.cursorPosition(),
      this.nativeWindow.outerPosition(),
      this.nativeWindow.scaleFactor(),
    ]);
    const sample: GlobalPointerSample = {
      cursorPhysical: { ...cursorPhysical },
      windowOuterPhysical: { ...windowOuterPhysical },
      scaleFactor,
      relativeLogical: physicalToRelativeLogical(
        cursorPhysical,
        windowOuterPhysical,
        scaleFactor,
      ),
    };

    this.latestSample = sample;

    try {
      this.onPointerSample(sample);
    } catch (error) {
      this.reportError("pointer sample callback", error);
    }

    return sample;
  }

  async samplePointer(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }

    this.pollInFlight = true;

    try {
      const sample = await this.readPointerSample();
      const nextHitState = resolveHitState(
        sample.relativeLogical,
        this.currentHitState,
      );

      this.currentHitState = nextHitState;
      if (!this.interactionLocked) {
        await this.requestIgnoreCursorEvents(!nextHitState);
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
  }

  setPointerPressed(pressed: boolean): void {
    this.setPressed(pressed);
  }

  async setInteractionLock(locked: boolean): Promise<void> {
    if (this.interactionLocked === locked) {
      return;
    }

    this.interactionLocked = locked;

    if (locked) {
      await this.requestIgnoreCursorEvents(false);
      return;
    }

    try {
      const sample = await this.readPointerSample();
      const nextHitState = resolveHitState(
        sample.relativeLogical,
        this.currentHitState,
      );
      this.currentHitState = nextHitState;
      await this.requestIgnoreCursorEvents(!nextHitState);
    } catch (error) {
      this.reportError("pointer sampling", error);
    }
  }

  triggerHappyFeedback(): void {
    if (this.happyTimer !== undefined) {
      globalThis.clearTimeout(this.happyTimer);
    }

    this.view.setHappy(true);
    this.happyTimer = globalThis.setTimeout(() => {
      this.happyTimer = undefined;
      this.view.setHappy(false);
    }, this.happyFeedbackDurationMs);
  }

  async forceSafeClickThrough(): Promise<void> {
    this.interactionLocked = false;
    this.currentHitState = false;
    this.setPressed(false);
    await this.requestIgnoreCursorEvents(true);
  }

  dispose(): void {
    this.stopPolling();

    if (this.happyTimer !== undefined) {
      globalThis.clearTimeout(this.happyTimer);
      this.happyTimer = undefined;
      this.view.setHappy(false);
    }
  }

  private setPressed(pressed: boolean): void {
    if (this.isPressed === pressed) {
      return;
    }

    this.isPressed = pressed;
    this.view.setPressed(pressed);
  }

  private async requestIgnoreCursorEvents(ignore: boolean): Promise<void> {
    if (this.lastRequestedIgnoreCursorEvents === ignore) {
      return;
    }

    this.lastRequestedIgnoreCursorEvents = ignore;

    try {
      await this.nativeWindow.setIgnoreCursorEvents(ignore);
    } catch (error) {
      this.reportError("set cursor pass-through", error);
    }
  }
}
