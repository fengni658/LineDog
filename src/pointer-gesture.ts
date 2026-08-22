import type { GlobalPointerSample } from "./native-spike";
import type {
  LogicalPoint,
  LogicalWorkArea,
  PetMotionPort,
} from "./native-motion";
import { RUNTIME_VIEWPORT_SIZE } from "./sprite-renderer";

export const DRAG_START_THRESHOLD_LOGICAL_PX = 6;

export type PointerGesturePhase = "NONE" | "ARMED" | "DRAG";
export type PointerGestureEnd =
  | "pointerup"
  | "pointercancel"
  | "lostpointercapture";

export interface GestureRuntimePort {
  beginPointerGesture(): boolean;
  promotePointerGestureToDrag(): boolean;
  movePointerDrag(
    position: LogicalPoint,
    currentMonitorId: string,
    workArea: LogicalWorkArea,
  ): boolean;
  endPointerGesture(options: { readonly triggerHappy: boolean }): Promise<boolean>;
}

export interface PointerSamplePort {
  readPointerSample(): Promise<GlobalPointerSample>;
  setInteractionLock(locked: boolean): Promise<void>;
  setPointerPressed(pressed: boolean): void;
}

type ActiveGesture = {
  readonly pointerId: number;
  phase: "PREPARING" | "ARMED" | "DRAG";
  initialSample?: GlobalPointerSample;
  initialWindowLogical?: LogicalPoint;
  workArea?: LogicalWorkArea;
  currentMonitorId?: string;
  latestSample?: GlobalPointerSample;
};

function assertValidScaleFactor(scaleFactor: number): void {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error("Pointer gesture scale factor must be a finite value greater than zero.");
  }
}

export function physicalPointerDeltaToLogical(
  initialCursorPhysical: LogicalPoint,
  currentCursorPhysical: LogicalPoint,
  startScaleFactor: number,
): LogicalPoint {
  assertValidScaleFactor(startScaleFactor);

  return {
    x: (currentCursorPhysical.x - initialCursorPhysical.x) / startScaleFactor,
    y: (currentCursorPhysical.y - initialCursorPhysical.y) / startScaleFactor,
  };
}

export function clampWindowPositionToWorkArea(
  position: LogicalPoint,
  workArea: LogicalWorkArea,
): LogicalPoint {
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = Math.max(minX, workArea.x + workArea.width - RUNTIME_VIEWPORT_SIZE);
  const maxY = Math.max(minY, workArea.y + workArea.height - RUNTIME_VIEWPORT_SIZE);

  return {
    x: Math.min(Math.max(position.x, minX), maxX),
    y: Math.min(Math.max(position.y, minY), maxY),
  };
}

function distance(point: LogicalPoint): number {
  return Math.hypot(point.x, point.y);
}

export class PointerGestureController {
  private active: ActiveGesture | undefined;

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

  async begin(pointerId: number): Promise<boolean> {
    if (this.active || !this.runtime.beginPointerGesture()) {
      return false;
    }

    const active: ActiveGesture = { pointerId, phase: "PREPARING" };
    this.active = active;
    this.pointerSamplePort.setPointerPressed(true);
    await this.pointerSamplePort.setInteractionLock(true);

    try {
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
      active.initialWindowLogical = { ...snapshot.windowPosition };
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

  handleGlobalPointerSample(sample: GlobalPointerSample): void {
    const active = this.active;

    if (!active) {
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

    return this.complete(active, outcome === "pointerup" && active.phase === "ARMED");
  }

  async cancel(): Promise<void> {
    const active = this.active;

    if (active) {
      await this.complete(active, false);
    }
  }

  private advance(active: ActiveGesture, sample: GlobalPointerSample): void {
    if (
      this.active !== active ||
      !active.initialSample ||
      !active.initialWindowLogical ||
      !active.workArea ||
      !active.currentMonitorId
    ) {
      return;
    }

    const delta = physicalPointerDeltaToLogical(
      active.initialSample.cursorPhysical,
      sample.cursorPhysical,
      active.initialSample.scaleFactor,
    );

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

    const nextPosition = clampWindowPositionToWorkArea(
      {
        x: active.initialWindowLogical.x + delta.x,
        y: active.initialWindowLogical.y + delta.y,
      },
      active.workArea,
    );
    this.runtime.movePointerDrag(
      nextPosition,
      active.currentMonitorId,
      active.workArea,
    );
  }

  private async complete(
    active: ActiveGesture,
    triggerHappy: boolean,
  ): Promise<boolean> {
    if (this.active !== active) {
      return false;
    }

    this.active = undefined;
    this.pointerSamplePort.setPointerPressed(false);
    await this.pointerSamplePort.setInteractionLock(false);
    return this.runtime.endPointerGesture({ triggerHappy });
  }
}
