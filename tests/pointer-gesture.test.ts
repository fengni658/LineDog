import { describe, expect, it } from "vitest";

import type { GlobalPointerSample } from "../src/native-spike";
import type {
  LogicalPoint,
  LogicalWorkArea,
  MotionSnapshot,
  PetMotionPort,
} from "../src/native-motion";
import {
  DRAG_START_THRESHOLD_LOGICAL_PX,
  PointerGestureController,
  clampWindowPositionToWorkArea,
  physicalPointerDeltaToLogical,
  type GestureRuntimePort,
  type PointerSamplePort,
} from "../src/pointer-gesture";

class FakeRuntime implements GestureRuntimePort {
  public armCalls = 0;
  public dragCalls = 0;
  public readonly moves: Array<{
    position: LogicalPoint;
    currentMonitorId: string;
  }> = [];
  public readonly ends: boolean[] = [];

  beginPointerGesture(): boolean {
    this.armCalls += 1;
    return true;
  }

  promotePointerGestureToDrag(): boolean {
    this.dragCalls += 1;
    return true;
  }

  movePointerDrag(
    position: LogicalPoint,
    currentMonitorId: string,
    _workArea: LogicalWorkArea,
  ): boolean {
    this.moves.push({ position: { ...position }, currentMonitorId });
    return true;
  }

  async endPointerGesture(options: { triggerHappy: boolean }): Promise<boolean> {
    this.ends.push(options.triggerHappy);
    return options.triggerHappy;
  }
}

class FakePointerPort implements PointerSamplePort {
  public readonly locks: boolean[] = [];
  public readonly pressed: boolean[] = [];

  constructor(private readonly sample: GlobalPointerSample) {}

  async readPointerSample(): Promise<GlobalPointerSample> {
    return this.sample;
  }

  async setInteractionLock(locked: boolean): Promise<void> {
    this.locks.push(locked);
  }

  setPointerPressed(pressed: boolean): void {
    this.pressed.push(pressed);
  }
}

class FakeMotionPort implements Pick<PetMotionPort, "resync"> {
  constructor(public snapshot: MotionSnapshot | null) {}

  async resync(): Promise<MotionSnapshot | null> {
    return this.snapshot;
  }
}

function sample(
  cursorPhysical: { x: number; y: number },
  scaleFactor = 2,
): GlobalPointerSample {
  return {
    cursorPhysical,
    windowOuterPhysical: { x: 100, y: 120 },
    scaleFactor,
    relativeLogical: {
      x: (cursorPhysical.x - 100) / scaleFactor,
      y: (cursorPhysical.y - 120) / scaleFactor,
    },
  };
}

function snapshot(
  workArea = { x: 0, y: 0, width: 400, height: 300 },
  windowPosition = { x: 120, y: 80 },
): MotionSnapshot {
  return {
    currentMonitorId: "current-monitor",
    workArea,
    windowPosition,
  };
}

describe("LineDog Phase C2 pointer-captured gesture split", () => {
  it("keeps movement below 6 logical pixels ARMED, then resyncs and triggers exactly one Happy on pointerup", async () => {
    const runtime = new FakeRuntime();
    const pointer = new FakePointerPort(sample({ x: 200, y: 200 }));
    const gesture = new PointerGestureController(
      runtime,
      pointer,
      new FakeMotionPort(snapshot()),
    );

    await expect(gesture.begin(7)).resolves.toBe(true);
    gesture.handleGlobalPointerSample(sample({ x: 210, y: 200 }));

    expect(gesture.phase).toBe("ARMED");
    expect(runtime.dragCalls).toBe(0);
    expect(runtime.moves).toEqual([]);

    await expect(gesture.finish(7, "pointerup")).resolves.toBe(true);
    expect(runtime.ends).toEqual([true]);
    expect(pointer.locks).toEqual([true, false]);
    expect(pointer.pressed).toEqual([true, false]);
    expect(gesture.phase).toBe("NONE");
  });

  it("enters DRAG at the 6 logical-pixel threshold, converts physical deltas once, and never requests Happy", async () => {
    const runtime = new FakeRuntime();
    const pointer = new FakePointerPort(sample({ x: 200, y: 200 }));
    const gesture = new PointerGestureController(
      runtime,
      pointer,
      new FakeMotionPort(snapshot()),
    );

    await gesture.begin(8);
    gesture.handleGlobalPointerSample(sample({ x: 212, y: 208 }));

    expect(DRAG_START_THRESHOLD_LOGICAL_PX).toBe(6);
    expect(gesture.phase).toBe("DRAG");
    expect(runtime.dragCalls).toBe(1);
    expect(runtime.moves).toEqual([
      {
        position: { x: 126, y: 84 },
        currentMonitorId: "current-monitor",
      },
    ]);

    await expect(gesture.finish(8, "pointerup")).resolves.toBe(false);
    expect(runtime.ends).toEqual([false]);
  });

  it("clamps the full 160x160 window in the current logical work area", async () => {
    expect(
      physicalPointerDeltaToLogical(
        { x: 200, y: 200 },
        { x: 600, y: -100 },
        2,
      ),
    ).toEqual({ x: 200, y: -150 });
    expect(
      clampWindowPositionToWorkArea(
        { x: 300, y: -90 },
        { x: 0, y: 0, width: 200, height: 180 },
      ),
    ).toEqual({ x: 40, y: 0 });
    expect(
      clampWindowPositionToWorkArea(
        { x: 300, y: 300 },
        { x: 0, y: 0, width: 200, height: 180 },
      ),
    ).toEqual({ x: 40, y: 20 });

    const runtime = new FakeRuntime();
    const pointer = new FakePointerPort(sample({ x: 200, y: 200 }));
    const gesture = new PointerGestureController(
      runtime,
      pointer,
      new FakeMotionPort(
        snapshot(
          { x: 0, y: 0, width: 200, height: 180 },
          { x: 20, y: 10 },
        ),
      ),
    );

    await gesture.begin(9);
    gesture.handleGlobalPointerSample(sample({ x: 1_000, y: 1_000 }));

    expect(runtime.moves.at(-1)).toEqual({
      position: { x: 40, y: 20 },
      currentMonitorId: "current-monitor",
    });
  });

  it.each(["pointercancel", "lostpointercapture"] as const)(
    "cleans up %s without Happy",
    async (outcome) => {
      const runtime = new FakeRuntime();
      const pointer = new FakePointerPort(sample({ x: 200, y: 200 }));
      const gesture = new PointerGestureController(
        runtime,
        pointer,
        new FakeMotionPort(snapshot()),
      );

      await gesture.begin(10);
      await expect(gesture.finish(10, outcome)).resolves.toBe(false);

      expect(runtime.ends).toEqual([false]);
      expect(pointer.locks).toEqual([true, false]);
      expect(pointer.pressed).toEqual([true, false]);
      expect(gesture.phase).toBe("NONE");
    },
  );
});
