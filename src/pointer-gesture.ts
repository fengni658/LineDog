import type {
  LogicalPoint,
  LogicalWorkArea,
  PetMotionPort,
} from "./native-motion";
import type { NativePointerSnapshotV1 } from "./native-platform";
import { clampWindowToWorkArea } from "./pet-behavior-core";

/**
 * 提起门槛。此值不属于 AGENTS.md 冻结基线，可按观感调整。
 * 6px 会让小狗在鼠标轻微抖动时就被瞬间拽起，因此放宽到 12px：
 * 既保留跟手性，又给"被抓住 → 抬起"留出可感知的启动距离。
 */
export const DRAG_START_THRESHOLD_LOGICAL_PX = 12;

export type PointerGesturePhase = "NONE" | "ARMED" | "DRAG";
export type PointerGestureEnd =
  | "pointerup"
  | "pointercancel"
  | "lostpointercapture";

export interface GestureRuntimePort {
  beginPointerGesture(): boolean;
  canConfirmPointerClick?(): boolean;
  promotePointerGestureToDrag(): boolean;
  movePointerDrag(
    position: LogicalPoint,
    currentMonitorId: string,
    workArea: LogicalWorkArea,
  ): boolean;
  endPointerGesture(options: {
    readonly triggerHappy: boolean;
    /** Release remains cancellable while Runtime validates native geometry. */
    readonly isCurrent?: () => boolean;
  }): Promise<boolean>;
}

export interface PointerSamplePort {
  readPointerSample(): Promise<NativePointerSnapshotV1>;
  setInteractionLock(locked: boolean): Promise<void>;
  setPointerPressed(pressed: boolean): void;
}

type ActiveGesture = {
  readonly pointerId: number;
  phase: "PREPARING" | "ARMED" | "DRAG";
  initialSample?: NativePointerSnapshotV1;
  coordinateScaleFactor?: number;
  grabOffsetLogical?: LogicalPoint;
  workArea?: LogicalWorkArea;
  currentMonitorId?: string;
  latestSample?: NativePointerSnapshotV1;
  preparation?: Promise<boolean>;
  releasePending?: boolean;
  cancelled?: boolean;
  finalization?: Promise<boolean>;
};

export function pointerDeltaToLogical(
  initialCursorLogical: LogicalPoint,
  currentCursorLogical: LogicalPoint,
): LogicalPoint {
  return {
    x: currentCursorLogical.x - initialCursorLogical.x,
    y: currentCursorLogical.y - initialCursorLogical.y,
  };
}

function distance(point: LogicalPoint): number {
  return Math.hypot(point.x, point.y);
}

export class PointerGestureController {
  private active: ActiveGesture | undefined;
  private readonly finalizing = new Set<ActiveGesture>();

  constructor(
    private readonly runtime: GestureRuntimePort,
    private readonly pointerSamplePort: PointerSamplePort,
    private readonly motionPort: Pick<PetMotionPort, "resync">,
  ) {}

  get phase(): PointerGesturePhase {
    if (!this.active || this.active.phase === "PREPARING") {
      return this.active ? "ARMED" : "NONE";
    }

    return this.active.phase;
  }

  begin(pointerId: number): Promise<boolean> {
    if (this.active || !this.runtime.beginPointerGesture()) {
      return Promise.resolve(false);
    }

    const active: ActiveGesture = { pointerId, phase: "PREPARING" };
    this.active = active;
    active.preparation = this.prepare(active);
    return active.preparation;
  }

  private async prepare(active: ActiveGesture): Promise<boolean> {
    this.pointerSamplePort.setPointerPressed(true);
    try {
      await this.pointerSamplePort.setInteractionLock(true);
      // Cancellation can finish while the native lock is queued. Do not add
      // obsolete geometry reads ahead of a subsequent real gesture.
      if (this.active !== active) return false;
      const [initialSample, snapshot] = await Promise.all([
        this.pointerSamplePort.readPointerSample(),
        this.motionPort.resync(),
      ]);

      if (this.active !== active) {
        return false;
      }

      if (!snapshot) {
        await this.complete(active, false);
        return false;
      }

      active.initialSample = initialSample;
      active.coordinateScaleFactor = snapshot.windowScaleFactor;
      const cursor = projectCursor(initialSample, snapshot.windowScaleFactor);
      active.grabOffsetLogical = {
        x: cursor.x - snapshot.windowPosition.x,
        y: cursor.y - snapshot.windowPosition.y,
      };
      active.workArea = { ...snapshot.workArea };
      active.currentMonitorId = snapshot.currentMonitorId;
      active.phase = "ARMED";

      if (active.latestSample) {
        this.advance(active, active.latestSample);
      }

      return true;
    } catch {
      if (this.active === active) {
        await this.complete(active, false);
      }
      return false;
    }
  }

  handleGlobalPointerSample(sample: NativePointerSnapshotV1): void {
    const active = this.active;

    if (!active || active.releasePending) {
      return;
    }

    active.latestSample = sample;

    if (active.phase !== "PREPARING") {
      this.advance(active, sample);
    }
  }

  async finish(pointerId: number, outcome: PointerGestureEnd): Promise<boolean> {
    const active = this.active;

    if (!active || active.pointerId !== pointerId) {
      return false;
    }

    if (outcome === "pointerup" && active.phase === "PREPARING" &&
        this.runtime.canConfirmPointerClick?.() !== false) {
      // DOM releases do not await native IPC. Retain a real release until its
      // initial geometry is validated; cancellation still wins immediately.
      active.releasePending = true;
      await active.preparation;
      if (this.active !== active) return false;
    }
    return this.complete(active, outcome === "pointerup" && active.phase === "ARMED");
  }

  async cancel(): Promise<void> {
    for (const ending of this.finalizing) ending.cancelled = true;
    const active = this.active;

    if (active) {
      active.cancelled = true;
      void this.complete(active, false);
    }
    await Promise.all([...this.finalizing].map(ending => ending.finalization));
  }

  private advance(active: ActiveGesture, sample: NativePointerSnapshotV1): void {
    if (
      this.active !== active ||
      !active.initialSample ||
      !active.coordinateScaleFactor ||
      !active.grabOffsetLogical ||
      !active.workArea ||
      !active.currentMonitorId
    ) {
      return;
    }

    const cursor = projectCursor(sample, active.coordinateScaleFactor);
    const delta = pointerDeltaToLogical(projectCursor(active.initialSample, active.coordinateScaleFactor), cursor);

    if (active.phase === "ARMED") {
      if (distance(delta) < DRAG_START_THRESHOLD_LOGICAL_PX) {
        return;
      }

      if (!this.runtime.promotePointerGestureToDrag()) {
        return;
      }

      active.phase = "DRAG";
    }

    if (active.phase !== "DRAG") {
      return;
    }

    const nextPosition = clampWindowToWorkArea(
      {
        x: cursor.x - active.grabOffsetLogical.x,
        y: cursor.y - active.grabOffsetLogical.y,
      },
      active.workArea,
    );
    this.runtime.movePointerDrag(
      nextPosition,
      active.currentMonitorId,
      active.workArea,
    );
  }

  private complete(
    active: ActiveGesture,
    triggerHappy: boolean,
  ): Promise<boolean> {
    if (this.active !== active) {
      return Promise.resolve(false);
    }

    this.active = undefined;
    active.releasePending = true;
    this.finalizing.add(active);
    this.pointerSamplePort.setPointerPressed(false);
    // Establish the old unlock revision before Runtime callbacks can admit a
    // new gesture. Its native readback is cleanup, not a click-feedback gate.
    // Start both even if either port throws synchronously, and retain ownership
    // until both settle so blur/cancel can still revoke a delayed click.
    const unlock = (async () => this.pointerSamplePort.setInteractionLock(false))();
    const end = (async () => this.runtime.endPointerGesture({
      triggerHappy,
      isCurrent: () => !active.cancelled,
    }))();
    active.finalization = Promise.allSettled([end, unlock]).then(([ended, unlocked]) => {
      if (ended.status === "rejected") throw ended.reason;
      if (unlocked.status === "rejected") throw unlocked.reason;
      return ended.value;
    }).finally(() => { this.finalizing.delete(active); });
    return active.finalization;
  }
}

function projectCursor(sample: NativePointerSnapshotV1, scaleFactor: number): LogicalPoint {
  const ratio = sample.scaleFactor / scaleFactor;
  return { x: sample.cursorScreenLogical.x * ratio, y: sample.cursorScreenLogical.y * ratio };
}
