import { describe, expect, it, vi } from "vitest";

import {
  HIT_BOX,
  HIT_BOX_EXIT_HYSTERESIS,
  HAPPY_FEEDBACK_DURATION_MS,
  NativeSpikeController,
  POLL_INTERVAL_MS,
  invokeWindowClickThrough,
  physicalToRelativeLogical,
  resolveHitState,
  type GlobalPointerSample,
  type NativeSpikeView,
  type NativeWindowPort,
  type PhysicalPoint,
} from "../src/native-spike";

function createWindowPort(sample: {
  cursor: PhysicalPoint;
  outer: PhysicalPoint;
  scaleFactor: number;
}): NativeWindowPort & {
  ignoreCalls: boolean[];
} {
  const ignoreCalls: boolean[] = [];

  return {
    cursorPosition: vi.fn(async () => sample.cursor),
    outerPosition: vi.fn(async () => sample.outer),
    scaleFactor: vi.fn(async () => sample.scaleFactor),
    setIgnoreCursorEvents: vi.fn(async (ignore: boolean) => {
      ignoreCalls.push(ignore);
    }),
    get ignoreCalls() {
      return ignoreCalls;
    },
  };
}

function createView(): NativeSpikeView & {
  pressedStates: boolean[];
  happyStates: boolean[];
} {
  const pressedStates: boolean[] = [];
  const happyStates: boolean[] = [];

  return {
    setPressed: (pressed) => pressedStates.push(pressed),
    setHappy: (happy) => happyStates.push(happy),
    get pressedStates() {
      return pressedStates;
    },
    get happyStates() {
      return happyStates;
    },
  };
}

describe("Native Spike geometry", () => {
  it("converts physical cursor and outer-window coordinates to one relative logical point", () => {
    expect(HIT_BOX).toEqual({ x: 32, y: 28, width: 96, height: 110 });
    expect(HIT_BOX_EXIT_HYSTERESIS).toBe(8);
    expect(POLL_INTERVAL_MS).toBeCloseTo(1000 / 30);

    expect(
      physicalToRelativeLogical(
        { x: 464, y: 356 },
        { x: 400, y: 300 },
        2,
      ),
    ).toEqual({ x: 32, y: 28 });
  });

  it("uses the core HitBox on entry and an 8px expanded frame only after entry", () => {
    expect(resolveHitState({ x: 32, y: 28 }, false)).toBe(true);
    expect(resolveHitState({ x: 31, y: 27 }, false)).toBe(false);
    expect(resolveHitState({ x: 31, y: 27 }, true)).toBe(true);
    expect(resolveHitState({ x: 23, y: 19 }, true)).toBe(false);
  });
});

describe("Native Spike controller", () => {
  it("changes cursor pass-through only when the hit state changes", async () => {
    const sample = {
      cursor: { x: 228, y: 200 },
      outer: { x: 100, y: 100 },
      scaleFactor: 2,
    };
    const port = createWindowPort(sample);
    const view = createView();
    const controller = new NativeSpikeController(port, view);

    await controller.samplePointer();
    await controller.samplePointer();

    expect(port.ignoreCalls).toEqual([false]);

    sample.cursor = { x: 0, y: 0 };
    await controller.samplePointer();

    expect(port.ignoreCalls).toEqual([false, true]);
  });

  it("routes initial and deduplicated hit-state click-through through the Rust command", async () => {
    const sample = {
      cursor: { x: 228, y: 200 },
      outer: { x: 100, y: 100 },
      scaleFactor: 2,
    };
    const invokeCommand = vi.fn(
      async (_command: string, _args: { ignore: boolean }): Promise<void> => undefined,
    );
    const port = createWindowPort(sample);
    port.setIgnoreCursorEvents = (ignore) =>
      invokeWindowClickThrough(invokeCommand, ignore);
    const controller = new NativeSpikeController(port, createView());

    await controller.forceSafeClickThrough();
    await controller.forceSafeClickThrough();
    await controller.samplePointer();
    await controller.samplePointer();
    sample.cursor = { x: 0, y: 0 };
    await controller.samplePointer();

    expect(invokeCommand).toHaveBeenCalledTimes(3);
    expect(invokeCommand).toHaveBeenNthCalledWith(
      1,
      "set_window_click_through",
      { ignore: true },
    );
    expect(invokeCommand).toHaveBeenNthCalledWith(
      2,
      "set_window_click_through",
      { ignore: false },
    );
    expect(invokeCommand).toHaveBeenNthCalledWith(
      3,
      "set_window_click_through",
      { ignore: true },
    );
  });

  it("emits one global physical/logical sample outside the HitBox without starting native dragging", async () => {
    const port = createWindowPort({
      cursor: { x: 600, y: 80 },
      outer: { x: 100, y: 100 },
      scaleFactor: 2,
    });
    const view = createView();
    const samples: GlobalPointerSample[] = [];
    const controller = new NativeSpikeController(port, view, {
      onPointerSample: (sample) => samples.push(sample),
    });

    await controller.samplePointer();

    expect(samples).toEqual([
      {
        cursorPhysical: { x: 600, y: 80 },
        windowOuterPhysical: { x: 100, y: 100 },
        scaleFactor: 2,
        relativeLogical: { x: 250, y: -10 },
      },
    ]);
    expect(controller.latestPointerSample).toEqual(samples[0]);
    expect("startDragging" in port).toBe(false);
  });

  it("locks click-through off for a pointer-captured gesture and restores it from the latest sample", async () => {
    const sample = {
      cursor: { x: 228, y: 200 },
      outer: { x: 100, y: 100 },
      scaleFactor: 2,
    };
    const port = createWindowPort(sample);
    const controller = new NativeSpikeController(port, createView());

    await controller.samplePointer();
    await controller.setInteractionLock(true);
    sample.cursor = { x: 0, y: 0 };
    await controller.setInteractionLock(false);

    expect(port.ignoreCalls).toEqual([false, true]);
  });

  it("resets a single happy-feedback timer instead of stacking rapid clicks", () => {
    vi.useFakeTimers();

    const port = createWindowPort({
      cursor: { x: 228, y: 200 },
      outer: { x: 100, y: 100 },
      scaleFactor: 2,
    });
    const view = createView();
    const controller = new NativeSpikeController(port, view);

    controller.triggerHappyFeedback();
    vi.advanceTimersByTime(HAPPY_FEEDBACK_DURATION_MS - 2);
    controller.triggerHappyFeedback();
    vi.advanceTimersByTime(1);

    expect(view.happyStates).toEqual([true, true]);

    vi.advanceTimersByTime(HAPPY_FEEDBACK_DURATION_MS - 2);
    expect(view.happyStates).toEqual([true, true]);

    vi.advanceTimersByTime(1);
    expect(view.happyStates).toEqual([true, true, false]);

    vi.useRealTimers();
  });

  it("restores safe click-through without repeating the same native write", async () => {
    const port = createWindowPort({
      cursor: { x: 228, y: 200 },
      outer: { x: 100, y: 100 },
      scaleFactor: 2,
    });
    const controller = new NativeSpikeController(port, createView());

    await controller.samplePointer();
    await controller.forceSafeClickThrough();
    await controller.forceSafeClickThrough();

    expect(port.ignoreCalls).toEqual([false, true]);
  });
});
