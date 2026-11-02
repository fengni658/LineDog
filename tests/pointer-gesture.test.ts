import { describe, expect, it } from "vitest";
import {
  NATIVE_PLATFORM_PROTOCOL_VERSION,
  type NativePointerSnapshotV1,
} from "../src/native-platform";
import type {
  LogicalPoint,
  LogicalWorkArea,
  MotionSnapshot,
  PetMotionPort,
  WindowTopLeftLogical,
} from "../src/native-motion";
import { RUNTIME_VIEWPORT_SIZE } from "../src/sprite-renderer";
import {
  DRAG_START_THRESHOLD_LOGICAL_PX,
  PointerGestureController,
  pointerDeltaToLogical,
  type GestureRuntimePort,
  type PointerSamplePort,
} from "../src/pointer-gesture";

const WORK_AREA: LogicalWorkArea = { x: 0, y: 0, width: 800, height: 600 };
const INITIAL_WINDOW: LogicalPoint = { x: 100, y: 100 };
const INITIAL_CURSOR: LogicalPoint = { x: 500, y: 300 };

describe("mixed DPI gesture snapshot", () => {
  it("keeps the grab offset and threshold in the captured window coordinate space", async () => {
    const snapshot = { ...makeSnapshot(), windowScaleFactor: 2 };
    const initialSample = { ...makeSample(point(500, 300)), scaleFactor: 1 };
    const { controller, moves } = createHarness({ snapshot, initialSample });
    await controller.begin(1);
    // Same physical cursor after HWND DPI changes is not a movement.
    controller.handleGlobalPointerSample({ ...makeSample(point(250, 150)), scaleFactor: 2 });
    expect(controller.phase).toBe("ARMED");
    expect(moves).toHaveLength(0);
    controller.handleGlobalPointerSample({ ...makeSample(point(540, 320)), scaleFactor: 1 });
    expect(controller.phase).toBe("DRAG");
    expect(moves.at(-1)?.position).toEqual({ x: 120, y: 110 });
    await controller.finish(1, "pointerup");
  });
});

function point(x: number, y: number): LogicalPoint {
  return { x, y };
}

function windowTopLeft(x: number, y: number): WindowTopLeftLogical {
  return { space: "WINDOW_TOP_LEFT_LOGICAL", x, y };
}

function makeSample(cursor: LogicalPoint): NativePointerSnapshotV1 {
  return {
    protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION,
    snapshotRevision: 1,
    capturedAtMonotonicMs: 0,
    cursorScreenLogical: { ...cursor },
    windowOuterTopLeftLogical: { x: 0, y: 0 },
    relativeLogical: { x: 0, y: 0 },
    scaleFactor: 1,
  };
}

function makeSnapshot(
  windowPosition: LogicalPoint = INITIAL_WINDOW,
): MotionSnapshot {
  return {
    currentMonitorId: "monitor-1",
    windowScaleFactor: 1,
    workArea: { ...WORK_AREA },
    windowPosition: windowTopLeft(windowPosition.x, windowPosition.y),
  };
}

type MoveCall = {
  position: LogicalPoint;
  currentMonitorId: string;
  workArea: LogicalWorkArea;
};

function createHarness(options: {
  readonly begin?: boolean;
  readonly promote?: boolean;
  readonly snapshot?: MotionSnapshot | null;
  readonly initialSample?: NativePointerSnapshotV1;
} = {}) {
  const calls = {
    beginPointerGesture: 0,
    promotePointerGestureToDrag: 0,
    endPointerGesture: [] as boolean[],
  };
  const moves: MoveCall[] = [];
  const lockStates: boolean[] = [];
  const pressedStates: boolean[] = [];

  let allowBegin = options.begin ?? true;
  let allowPromote = options.promote ?? true;
  let snapshot = options.snapshot === undefined ? makeSnapshot() : options.snapshot;

  const runtime: GestureRuntimePort = {
    beginPointerGesture(): boolean {
      calls.beginPointerGesture += 1;
      return allowBegin;
    },
    promotePointerGestureToDrag(): boolean {
      calls.promotePointerGestureToDrag += 1;
      return allowPromote;
    },
    movePointerDrag(position, currentMonitorId, workArea): boolean {
      moves.push({
        position: { ...position },
        currentMonitorId,
        workArea: { ...workArea },
      });
      return true;
    },
    endPointerGesture: async (endOptions) => {
      calls.endPointerGesture.push(endOptions.triggerHappy);
      return true;
    },
  };

  const samplePort: PointerSamplePort = {
    readPointerSample: async () => options.initialSample ?? makeSample(INITIAL_CURSOR),
    setInteractionLock: async (locked) => {
      lockStates.push(locked);
    },
    setPointerPressed: (pressed) => {
      pressedStates.push(pressed);
    },
  };

  const motionPort: Pick<PetMotionPort, "resync"> = {
    resync: async () => snapshot,
  };

  const controller = new PointerGestureController(
    runtime,
    samplePort,
    motionPort,
  );

  return {
    controller,
    calls,
    moves,
    lockStates,
    pressedStates,
    setAllowBegin(value: boolean): void {
      allowBegin = value;
    },
    setAllowPromote(value: boolean): void {
      allowPromote = value;
    },
    setSnapshot(value: MotionSnapshot | null): void {
      snapshot = value;
    },
    /** Moves the cursor to an absolute logical screen position. */
    moveCursorTo(x: number, y: number): void {
      controller.handleGlobalPointerSample(makeSample(point(x, y)));
    },
    /** Moves the cursor by a delta from the initial cursor position. */
    moveCursorBy(dx: number, dy: number): void {
      controller.handleGlobalPointerSample(
        makeSample(point(INITIAL_CURSOR.x + dx, INITIAL_CURSOR.y + dy)),
      );
    },
  };
}

describe("pointer-gesture frozen values", () => {
  it("keeps the drag start threshold frozen", () => {
    expect(DRAG_START_THRESHOLD_LOGICAL_PX).toBe(12);
  });
});

describe("pointerDeltaToLogical", () => {
  it("reports the signed cursor travel", () => {
    expect(pointerDeltaToLogical(point(10, 20), point(13, 16))).toEqual({
      x: 3,
      y: -4,
    });
  });
});

describe("PointerGestureController.begin", () => {
  it("arms the gesture and locks pointer interaction", async () => {
    const harness = createHarness();
    expect(harness.controller.phase).toBe("NONE");

    expect(await harness.controller.begin(7)).toBe(true);
    expect(harness.controller.phase).toBe("ARMED");
    expect(harness.pressedStates).toEqual([true]);
    expect(harness.lockStates).toEqual([true]);
    expect(harness.calls.beginPointerGesture).toBe(1);
  });

  it("refuses to begin while another gesture is active", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);
    expect(await harness.controller.begin(8)).toBe(false);
    expect(harness.calls.beginPointerGesture).toBe(1);
    expect(harness.controller.phase).toBe("ARMED");
  });

  it("defers to the runtime when it rejects the gesture", async () => {
    const harness = createHarness({ begin: false });
    expect(await harness.controller.begin(7)).toBe(false);
    expect(harness.controller.phase).toBe("NONE");
    expect(harness.pressedStates).toEqual([]);
    expect(harness.lockStates).toEqual([]);
  });

  it("tears down cleanly when resync returns null", async () => {
    const harness = createHarness({ snapshot: null });
    expect(await harness.controller.begin(7)).toBe(false);
    expect(harness.controller.phase).toBe("NONE");
    expect(harness.pressedStates).toEqual([true, false]);
    expect(harness.lockStates).toEqual([true, false]);
    expect(harness.calls.endPointerGesture).toEqual([false]);
  });
});

describe("PointerGestureController drag threshold", () => {
  it("stays ARMED below the threshold and does not ask to promote", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);

    // 3-4-5 triangle: distance 5 < 12.
    harness.moveCursorBy(3, 4);
    expect(harness.controller.phase).toBe("ARMED");
    expect(harness.calls.promotePointerGestureToDrag).toBe(0);
    expect(harness.moves).toHaveLength(0);
  });

  it("promotes to DRAG once the threshold is reached", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);

    // 9-12-15 triangle: distance 15 >= 12.
    harness.moveCursorBy(9, 12);
    expect(harness.controller.phase).toBe("DRAG");
    expect(harness.calls.promotePointerGestureToDrag).toBe(1);
    expect(harness.moves).toHaveLength(1);
    expect(harness.moves[0]?.position).toEqual(
      point(INITIAL_WINDOW.x + 9, INITIAL_WINDOW.y + 12),
    );
  });

  it("preserves the initial cursor-to-window grab offset", async () => {
    const harness = createHarness({ snapshot: makeSnapshot(point(425, 240)) });
    await harness.controller.begin(7);

    harness.moveCursorTo(560, 360);

    expect(harness.controller.phase).toBe("DRAG");
    expect(harness.moves.at(-1)?.position).toEqual(point(485, 300));
  });

  it("treats the threshold as an exclusive lower bound", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);

    harness.moveCursorBy(DRAG_START_THRESHOLD_LOGICAL_PX, 0);
    expect(harness.controller.phase).toBe("DRAG");

    const second = createHarness();
    await second.controller.begin(7);
    second.moveCursorBy(DRAG_START_THRESHOLD_LOGICAL_PX - 0.01, 0);
    expect(second.controller.phase).toBe("ARMED");
  });

  it("remains ARMED when the runtime refuses to promote", async () => {
    const harness = createHarness({ promote: false });
    await harness.controller.begin(7);

    harness.moveCursorBy(50, 50);
    expect(harness.controller.phase).toBe("ARMED");
    expect(harness.calls.promotePointerGestureToDrag).toBe(1);
    expect(harness.moves).toHaveLength(0);
  });

  it("clamps the dragged window to the WorkArea", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);

    harness.moveCursorBy(900, 900);

    const maximumX = WORK_AREA.x + WORK_AREA.width - RUNTIME_VIEWPORT_SIZE;
    const maximumY = WORK_AREA.y + WORK_AREA.height - RUNTIME_VIEWPORT_SIZE;
    expect(harness.moves).toHaveLength(1);
    expect(harness.moves[0]?.position).toEqual(point(maximumX, maximumY));
    expect(harness.moves[0]?.currentMonitorId).toBe("monitor-1");
    expect(harness.moves[0]?.workArea).toEqual(WORK_AREA);
  });

  it("ignores samples once the gesture has finished", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);
    await harness.controller.finish(7, "pointercancel");

    harness.moveCursorBy(80, 80);
    expect(harness.moves).toHaveLength(0);
    expect(harness.controller.phase).toBe("NONE");
  });
});

describe("PointerGestureController completion paths", () => {
  it("triggers Happy only for pointerup while still ARMED", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);
    expect(await harness.controller.finish(7, "pointerup")).toBe(true);
    expect(harness.calls.endPointerGesture).toEqual([true]);
    expect(harness.controller.phase).toBe("NONE");
    expect(harness.pressedStates).toEqual([true, false]);
    expect(harness.lockStates).toEqual([true, false]);
  });

  it("does not trigger Happy for pointercancel", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);
    expect(await harness.controller.finish(7, "pointercancel")).toBe(true);
    expect(harness.calls.endPointerGesture).toEqual([false]);
  });

  it("does not trigger Happy for lostpointercapture", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);
    expect(await harness.controller.finish(7, "lostpointercapture")).toBe(true);
    expect(harness.calls.endPointerGesture).toEqual([false]);
  });

  it("does not trigger Happy for pointerup after a real drag", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);
    harness.moveCursorBy(40, 0);
    expect(harness.controller.phase).toBe("DRAG");

    expect(await harness.controller.finish(7, "pointerup")).toBe(true);
    expect(harness.calls.endPointerGesture).toEqual([false]);
  });

  it("ignores a finish for a different pointer id", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);
    expect(await harness.controller.finish(99, "pointerup")).toBe(false);
    expect(harness.calls.endPointerGesture).toEqual([]);
    expect(harness.controller.phase).toBe("ARMED");
  });

  it("cancels without triggering Happy and stays cancelled", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);

    await harness.controller.cancel();
    expect(harness.calls.endPointerGesture).toEqual([false]);
    expect(harness.controller.phase).toBe("NONE");

    await harness.controller.cancel();
    expect(harness.calls.endPointerGesture).toEqual([false]);
  });

  it("allows a new gesture after a completed one", async () => {
    const harness = createHarness();
    await harness.controller.begin(7);
    await harness.controller.finish(7, "pointerup");

    expect(await harness.controller.begin(8)).toBe(true);
    expect(harness.controller.phase).toBe("ARMED");
    expect(harness.calls.beginPointerGesture).toBe(2);
  });
});
