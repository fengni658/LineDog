import { describe, expect, it, vi } from "vitest";
import {
  NATIVE_PLATFORM_PROTOCOL_VERSION,
  type NativePointerSnapshotV1,
} from "../src/native-platform";
import {
  HIT_BOX,
  HIT_BOX_EXIT_HYSTERESIS,
  POLL_INTERVAL_MS,
  VIEWPORT_SIZE,
  PointerHitBoxController,
  createOnceErrorReporter,
  isPointInsideHitBox,
  resolveHitBox,
  resolveHitState,
  type NativeWindowPort,
} from "../src/pointer-hitbox";

/**
 * HIT_BOX = { x: 32, y: 28, width: 96, height: 110 }
 *   inner bounds (wasInside = false): x 32..128, y 28..138 (inclusive)
 *   outer bounds (wasInside = true) : x 24..136, y 20..146 (inclusive)
 */
const HIT_BOX_LEFT = 32;
const HIT_BOX_TOP = 28;
const HIT_BOX_RIGHT = 128;
const HIT_BOX_BOTTOM = 138;
const OUTER_LEFT = HIT_BOX_LEFT - HIT_BOX_EXIT_HYSTERESIS;
const OUTER_RIGHT = HIT_BOX_RIGHT + HIT_BOX_EXIT_HYSTERESIS;
const OUTER_BOTTOM = HIT_BOX_BOTTOM + HIT_BOX_EXIT_HYSTERESIS;

function point(x: number, y: number): { x: number; y: number } {
  return { x, y };
}

function makeSnapshot(relative: {
  x: number;
  y: number;
}): NativePointerSnapshotV1 {
  return {
    protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION,
    snapshotRevision: 1,
    capturedAtMonotonicMs: 0,
    cursorScreenLogical: point(0, 0),
    windowOuterTopLeftLogical: point(0, 0),
    relativeLogical: { ...relative },
    scaleFactor: 1,
  };
}

function createPort(relative: { x: number; y: number }) {
  const clickThroughRequests: boolean[] = [];
  let snapshot = makeSnapshot(relative);

  const port: NativeWindowPort = {
    pointerSnapshot: async () => snapshot,
    setWindowClickThrough: async (args) => {
      clickThroughRequests.push(args.ignore);
    },
  };

  return {
    port,
    clickThroughRequests,
    setRelative(x: number, y: number): void {
      snapshot = makeSnapshot(point(x, y));
    },
  };
}

function createView() {
  const pressedStates: boolean[] = [];
  return {
    view: {
      setPressed(pressed: boolean): void {
        pressedStates.push(pressed);
      },
    },
    pressedStates,
  };
}

describe("pointer-hitbox frozen values", () => {
  it("keeps the product HitBox, hysteresis, viewport, and poll rate frozen", () => {
    expect(VIEWPORT_SIZE).toBe(160);
    expect(HIT_BOX).toEqual({ x: 32, y: 28, width: 96, height: 110 });
    expect(HIT_BOX_EXIT_HYSTERESIS).toBe(8);
    expect(POLL_INTERVAL_MS).toBeCloseTo(1000 / 30);
  });
});

describe("resolveHitState", () => {
  it("treats the inner HitBox boundary as inclusive when outside", () => {
    expect(resolveHitState(point(HIT_BOX_LEFT, HIT_BOX_TOP), false)).toBe(true);
    expect(resolveHitState(point(HIT_BOX_RIGHT, HIT_BOX_BOTTOM), false)).toBe(
      true,
    );
    expect(resolveHitState(point(HIT_BOX_LEFT - 1, HIT_BOX_TOP), false)).toBe(
      false,
    );
    expect(resolveHitState(point(HIT_BOX_RIGHT + 1, HIT_BOX_BOTTOM), false)).toBe(
      false,
    );
  });

  it("expands the boundary by the exit hysteresis only while inside", () => {
    const justOutsideRight = point(HIT_BOX_RIGHT + 4, 80);
    const atOuterRight = point(OUTER_RIGHT, 80);
    const pastOuterRight = point(OUTER_RIGHT + 1, 80);

    expect(resolveHitState(justOutsideRight, false)).toBe(false);
    expect(resolveHitState(justOutsideRight, true)).toBe(true);

    expect(resolveHitState(atOuterRight, true)).toBe(true);
    expect(resolveHitState(atOuterRight, false)).toBe(false);

    expect(resolveHitState(pastOuterRight, true)).toBe(false);
  });

  it("applies the hysteresis on every edge, not only the right one", () => {
    expect(resolveHitState(point(OUTER_LEFT, 80), true)).toBe(true);
    expect(resolveHitState(point(OUTER_LEFT, 80), false)).toBe(false);

    expect(resolveHitState(point(OUTER_LEFT - 1, 80), true)).toBe(false);

    expect(resolveHitState(point(80, OUTER_BOTTOM), true)).toBe(true);
    expect(resolveHitState(point(80, OUTER_BOTTOM), false)).toBe(false);
    expect(resolveHitState(point(80, OUTER_BOTTOM + 1), true)).toBe(false);
  });

  it("falls back to the frozen HitBox when the supplied one is invalid", () => {
    const invalid = { x: 0, y: 0, width: 0, height: 0 };
    // An empty HitBox would make everything "outside"; the fallback keeps the
    // frozen box authoritative instead of turning the whole window transparent.
    expect(resolveHitState(point(80, 80), false, invalid)).toBe(true);
    expect(resolveHitState(point(-500, -500), false, invalid)).toBe(false);
  });
});

describe("resolveHitBox", () => {
  const frameHitBox = { x: 10, y: 12, width: 40, height: 40 };
  const animationHitBox = { x: 50, y: 60, width: 30, height: 30 };
  const fallback = { x: 70, y: 80, width: 20, height: 20 };

  it("prefers frame over animation over fallback", () => {
    expect(resolveHitBox(frameHitBox, animationHitBox, fallback)).toEqual(
      frameHitBox,
    );
    expect(resolveHitBox(undefined, animationHitBox, fallback)).toEqual(
      animationHitBox,
    );
    expect(resolveHitBox(undefined, undefined, fallback)).toEqual(fallback);
  });

  it("skips invalid candidates instead of stopping at the first defined one", () => {
    const zeroArea = { x: 0, y: 0, width: 0, height: 0 };
    const notANumber = {
      x: Number.NaN,
      y: 0,
      width: 10,
      height: 10,
    };
    const outOfViewport = { x: 100, y: 100, width: 999, height: 999 };

    expect(resolveHitBox(zeroArea, animationHitBox, fallback)).toEqual(
      animationHitBox,
    );
    expect(resolveHitBox(notANumber, outOfViewport, fallback)).toEqual(fallback);
  });

  it("returns the frozen HitBox when every candidate is invalid", () => {
    expect(
      resolveHitBox(
        { x: -1, y: 0, width: 10, height: 10 },
        { x: 0, y: 0, width: 0, height: 10 },
        { x: 0, y: 0, width: 10, height: Number.NaN },
      ),
    ).toEqual(HIT_BOX);
  });

  it("returns a copy so callers cannot mutate the frozen default", () => {
    const resolved = resolveHitBox(undefined, undefined);
    expect(resolved).toEqual(HIT_BOX);
    expect(resolved).not.toBe(HIT_BOX);
  });
});

describe("isPointInsideHitBox", () => {
  it("falls back to the frozen HitBox for an invalid box", () => {
    expect(isPointInsideHitBox(point(80, 80))).toBe(true);
    expect(
      isPointInsideHitBox(point(80, 80), { x: 0, y: 0, width: 0, height: 0 }),
    ).toBe(true);
    expect(isPointInsideHitBox(point(-80, -80))).toBe(false);
  });
});

describe("PointerHitBoxController", () => {
  it("issues exactly one click-through write per state change", async () => {
    const { port, clickThroughRequests, setRelative } = createPort(point(80, 80));
    const { view } = createView();
    const controller = new PointerHitBoxController(port, view);

    await controller.samplePointer();
    expect(clickThroughRequests).toEqual([false]);

    // Same hit state: the dedupe must suppress the repeat IPC.
    await controller.samplePointer();
    await controller.samplePointer();
    expect(clickThroughRequests).toEqual([false]);

    setRelative(400, 400);
    await controller.samplePointer();
    expect(clickThroughRequests).toEqual([false, true]);

    await controller.samplePointer();
    expect(clickThroughRequests).toEqual([false, true]);
  });

  it("does not rewrite click-through while the interaction lock is held", async () => {
    const { port, clickThroughRequests, setRelative } = createPort(point(80, 80));
    const { view } = createView();
    const controller = new PointerHitBoxController(port, view);

    await controller.setInteractionLock(true);
    expect(clickThroughRequests).toEqual([false]);

    // The cursor leaves the pet entirely; without the lock this would write
    // `ignore: true`, but a locked interaction owns the click-through state.
    setRelative(400, 400);
    await controller.samplePointer();
    await controller.samplePointer();
    expect(clickThroughRequests).toEqual([false]);

    await controller.setInteractionLock(false);
    expect(clickThroughRequests).toEqual([false, true]);
  });

  it("forces a safe pass-through on start and on request", async () => {
    const { port, clickThroughRequests } = createPort(point(80, 80));
    const { view, pressedStates } = createView();
    const controller = new PointerHitBoxController(port, view);

    await controller.forceSafeClickThrough();
    expect(clickThroughRequests).toEqual([true]);
    // `isPressed` already starts false, so the view is not told twice.
    expect(pressedStates).toEqual([]);

    controller.setPointerPressed(true);
    controller.setPointerPressed(true);
    expect(pressedStates).toEqual([true]);

    // A lock raised before forceSafeClickThrough must not survive it, and the
    // press must be released so the pet cannot stay visually held down.
    await controller.setInteractionLock(true);
    expect(clickThroughRequests).toEqual([true, false]);
    await controller.forceSafeClickThrough();
    expect(clickThroughRequests).toEqual([true, false, true]);
    expect(pressedStates).toEqual([true, false]);
  });

  it("tracks the setHitBox override when sampling", async () => {
    const { port, clickThroughRequests } = createPort(point(80, 80));
    const { view } = createView();
    const controller = new PointerHitBoxController(port, view);

    await controller.samplePointer();
    expect(clickThroughRequests).toEqual([false]);

    // Shrink the box away from the cursor: the next sample must re-evaluate to
    // "outside" even though the cursor never moved.
    controller.setHitBox({ x: 100, y: 100, width: 20, height: 20 });
    await controller.samplePointer();
    expect(clickThroughRequests).toEqual([false, true]);
  });

  it("publishes each pointer sample to the observer and keeps a defensive copy", async () => {
    const { port, setRelative } = createPort(point(80, 80));
    const { view } = createView();
    const observed: NativePointerSnapshotV1[] = [];
    const controller = new PointerHitBoxController(port, view, {
      onPointerSample: (sample) => observed.push(sample),
    });

    const first = await controller.readPointerSample();
    expect(observed).toHaveLength(1);
    expect(observed[0]?.relativeLogical).toEqual(point(80, 80));

    // The stored sample must not alias the observer's reference.
    expect(controller.latestPointerSample?.relativeLogical).not.toBe(
      first.relativeLogical,
    );
    expect(controller.latestPointerSample?.relativeLogical).toEqual(point(80, 80));

    setRelative(10, 300);
    await controller.readPointerSample();
    expect(observed).toHaveLength(2);
    expect(controller.latestPointerSample?.relativeLogical).toEqual(
      point(10, 300),
    );
  });

  it("reports a failing pointer sample once and keeps polling usable", async () => {
    const errors: Array<[string, unknown]> = [];
    const { view } = createView();
    const failing: NativeWindowPort = {
      pointerSnapshot: async () => {
        throw new Error("pointer snapshot failed");
      },
      setWindowClickThrough: async () => undefined,
    };
    const controller = new PointerHitBoxController(failing, view, {
      reportError: (operation, error) => errors.push([operation, error]),
    });

    await controller.samplePointer();
    await controller.samplePointer();

    expect(errors).toHaveLength(2);
    expect(errors[0]?.[0]).toBe("pointer sampling");
  });
});

describe("createOnceErrorReporter", () => {
  it("reports each operation once and lets different operations through", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const report = createOnceErrorReporter();
      report("sampling", new Error("a"));
      report("sampling", new Error("b"));
      report("click-through", new Error("c"));

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toContain("sampling");
      expect(warn.mock.calls[1]?.[0]).toContain("click-through");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("click-through failure recovery", () => {
  it("retries a failed unchanged hit and a failed drag lock", async () => {
    let failures = 2;
    const calls: boolean[] = [];
    const controller = new PointerHitBoxController({
      pointerSnapshot: async () => makeSnapshot(point(80, 80)),
      setWindowClickThrough: async ({ ignore }) => {
        calls.push(ignore);
        if (failures-- > 0) throw new Error("fixture native failure");
      },
    }, { setPressed: () => undefined }, { reportError: () => undefined });
    await controller.samplePointer();
    await controller.setInteractionLock(true);
    await controller.setInteractionLock(true);
    await controller.setInteractionLock(true);
    expect(calls).toEqual([false, false, false]);
    await controller.forceSafeClickThrough();
    expect(calls.at(-1)).toBe(true);
  });

  it("serializes safe disposal after an in-flight native write", async () => {
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const calls: boolean[] = [];
    const controller = new PointerHitBoxController({
      pointerSnapshot: async () => makeSnapshot(point(80, 80)),
      setWindowClickThrough: async ({ ignore }) => {
        calls.push(ignore);
        if (!ignore) await blocked;
      },
    }, { setPressed: () => undefined });
    const lock = controller.setInteractionLock(true);
    await Promise.resolve();
    controller.dispose();
    finish();
    await lock;
    await controller.forceSafeClickThrough();
    expect(calls).toEqual([false, true]);
    await controller.samplePointer();
    expect(calls).toEqual([false, true]);
  });
});
