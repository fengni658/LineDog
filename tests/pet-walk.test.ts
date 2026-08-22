import frozenManifest from "../public/character/manifest.json";
import { describe, expect, it } from "vitest";

import { type TimelineClock } from "../src/animation-timeline";
import {
  NativeWindowMotionAdapter,
  WINDOW_POSITION_COMMAND_INTERVAL_MS,
  type LogicalPoint,
  type MotionSnapshot,
  type NativeWindowMotionApi,
  type PetMotionPort,
} from "../src/native-motion";
import {
  createDefaultRuntimeResources,
  parseCharacterManifest,
} from "../src/pet-manifest";
import {
  DIRECT_INTERACTION_STOP_MAX_MS,
  PET_BEHAVIOR_CONFIG,
  PetRuntime,
  chooseAutonomousAction,
  chooseFacing,
  sampleIdleDurationMs,
  samplePauseDurationMs,
  sampleWalkDurationMs,
  sampleWalkSpeedLogicalPxPerSecond,
} from "../src/pet-runtime";
import {
  applySpriteFacing,
  createSpriteSurfaceMarkup,
} from "../src/sprite-renderer";

class FakeClock implements TimelineClock {
  private currentTimeMs = 0;
  private nextTimerId = 0;
  private readonly timers = new Map<
    number,
    Readonly<{ dueAtMs: number; callback: () => void }>
  >();

  now(): number {
    return this.currentTimeMs;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    this.nextTimerId += 1;
    this.timers.set(this.nextTimerId, {
      dueAtMs: this.currentTimeMs + delayMs,
      callback,
    });
    return this.nextTimerId;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.timers.delete(handle);
    }
  }

  advanceBy(durationMs: number): void {
    const targetTimeMs = this.currentTimeMs + durationMs;

    while (true) {
      const nextTimer = [...this.timers.entries()]
        .sort(([, left], [, right]) => left.dueAtMs - right.dueAtMs)
        .find(([, timer]) => timer.dueAtMs <= targetTimeMs);

      if (!nextTimer) {
        break;
      }

      const [timerId, timer] = nextTimer;
      this.timers.delete(timerId);
      this.currentTimeMs = timer.dueAtMs;
      timer.callback();
    }

    this.currentTimeMs = targetTimeMs;
  }
}

class FakeMotionPort implements PetMotionPort {
  public snapshot: MotionSnapshot = {
    currentMonitorId: "current-monitor",
    workArea: { x: 0, y: 0, width: 400, height: 300 },
    windowPosition: { x: 120, y: 140 },
  };
  public readonly requests: LogicalPoint[] = [];
  public resyncCalls = 0;
  public stopCalls = 0;

  async resync(): Promise<MotionSnapshot | null> {
    this.resyncCalls += 1;
    return this.snapshot;
  }

  requestPosition(position: LogicalPoint): void {
    this.requests.push({ ...position });
  }

  stop(): void {
    this.stopCalls += 1;
  }
}

const resources = createDefaultRuntimeResources(
  parseCharacterManifest(frozenManifest),
);

function randomSequence(values: readonly number[]): () => number {
  let index = 0;

  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createWalkRuntime(clock: FakeClock, motion: FakeMotionPort): PetRuntime {
  return new PetRuntime(resources, {
    clock,
    motionPort: motion,
    random: randomSequence([
      1,
      0,
      0.65,
      0,
      1,
      1,
      1,
      1,
    ]),
  });
}

async function enterWalk(clock: FakeClock, runtime: PetRuntime): Promise<void> {
  await runtime.initialize(async () => undefined);
  clock.advanceBy(PET_BEHAVIOR_CONFIG.idle.minDurationMs);
  await flushAsyncWork();
}

function createNativeMotionApi(
  setPosition: (position: LogicalPoint) => Promise<void>,
): NativeWindowMotionApi {
  return {
    currentMonitor: async () => ({
      name: "Current monitor",
      scaleFactor: 2,
      workArea: {
        position: { x: 200, y: 100 },
        size: { width: 1200, height: 800 },
      },
    }),
    outerPosition: async () => ({ x: 400, y: 220 }),
    scaleFactor: async () => 2,
    setPosition,
  };
}

describe("LineDog Phase B autonomous selection", () => {
  it("uses the frozen 65/35 boundary, approved ranges, and a deterministic facing", () => {
    expect(chooseAutonomousAction(() => 0.649_999)).toBe("PAUSE");
    expect(chooseAutonomousAction(() => 0.65)).toBe("WALK");
    expect(sampleIdleDurationMs(() => 0)).toBe(3_000);
    expect(sampleIdleDurationMs(() => 1)).toBe(8_000);
    expect(samplePauseDurationMs(() => 0)).toBe(1_000);
    expect(samplePauseDurationMs(() => 1)).toBe(3_000);
    expect(sampleWalkDurationMs(() => 0)).toBe(2_000);
    expect(sampleWalkDurationMs(() => 1)).toBe(6_000);
    expect(sampleWalkSpeedLogicalPxPerSecond(() => 0)).toBe(45);
    expect(sampleWalkSpeedLogicalPxPerSecond(() => 1)).toBe(60);
    expect(chooseFacing(() => 0)).toBe("Left");
    expect(chooseFacing(() => 1)).toBe("Right");
  });

  it("enters WALK only after an Idle interval and suppresses Blink while walking", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const runtime = createWalkRuntime(clock, motion);

    await enterWalk(clock, runtime);

    expect(runtime.state).toMatchObject({
      readiness: "ready",
      behavior: "WALK",
      animationLayer: "BASE",
      activeAnimationId: "walk",
      facing: "Right",
      isDragging: false,
    });
    expect(runtime.triggerBlink()).toBe(false);
    expect(motion.requests[0]).toEqual({ x: 120, y: 140 });
  });

  it("clamps a horizontal Walk at the current work-area edge and returns to Idle", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    motion.snapshot = {
      ...motion.snapshot,
      workArea: { x: 0, y: 0, width: 200, height: 300 },
      windowPosition: { x: 35, y: 140 },
    };
    const runtime = createWalkRuntime(clock, motion);

    await enterWalk(clock, runtime);
    clock.advanceBy(120);

    expect(motion.requests.at(-1)).toEqual({ x: 40, y: 140 });
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      activeAnimationId: "idle",
      logicalPosition: { x: 40, y: 140 },
    });
  });

  it("completes a timed Walk into Idle before reaching a horizontal boundary", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    motion.snapshot = {
      ...motion.snapshot,
      workArea: { x: 0, y: 0, width: 600, height: 300 },
    };
    const runtime = createWalkRuntime(clock, motion);

    await enterWalk(clock, runtime);
    clock.advanceBy(PET_BEHAVIOR_CONFIG.walk.minDurationMs + 100);

    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      activeAnimationId: "idle",
    });
    expect(runtime.state.logicalPosition).toMatchObject({ y: 140 });
    expect(runtime.state.logicalPosition?.x).toBeCloseTo(240, 6);
  });

  it("preempts Walk immediately for direct interaction and does not issue later Walk commands within 200ms", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const runtime = createWalkRuntime(clock, motion);

    await enterWalk(clock, runtime);
    const requestsBeforeInteraction = motion.requests.length;

    expect(runtime.handleUserInteraction()).toBe(true);
    expect(DIRECT_INTERACTION_STOP_MAX_MS).toBeLessThanOrEqual(200);
    expect(runtime.state).toMatchObject({ behavior: "IDLE", activeAnimationId: "idle" });
    expect(motion.stopCalls).toBeGreaterThan(0);

    clock.advanceBy(DIRECT_INTERACTION_STOP_MAX_MS);
    expect(motion.requests).toHaveLength(requestsBeforeInteraction);
  });

  it("resyncs the real position after native drag before entering the Phase D fall path", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const runtime = createWalkRuntime(clock, motion);

    await enterWalk(clock, runtime);
    const requestsBeforeDrag = motion.requests.length;

    runtime.beginDrag();
    expect(runtime.state).toMatchObject({ behavior: "DRAG", isDragging: true });

    motion.snapshot = {
      ...motion.snapshot,
      windowPosition: { x: 180, y: 76 },
    };
    await runtime.endDrag();

    expect(motion.resyncCalls).toBe(2);
    expect(runtime.state).toMatchObject({
      behavior: "FALL",
      isDragging: false,
      logicalPosition: { x: 180, y: 76 },
    });
    expect(motion.requests.length).toBeGreaterThanOrEqual(requestsBeforeDrag);
  });
});

describe("LineDog Phase B native motion adapter", () => {
  it("converts current-monitor work-area and outer-window physical facts to logical facts", async () => {
    const adapter = new NativeWindowMotionAdapter(
      createNativeMotionApi(async () => undefined),
    );

    await expect(adapter.resync()).resolves.toEqual({
      currentMonitorId: "Current monitor",
      workArea: { x: 100, y: 50, width: 600, height: 400 },
      windowPosition: { x: 200, y: 110 },
    });
  });

  it("coalesces position writes at about 30Hz and never overlaps an in-flight write", async () => {
    const clock = new FakeClock();
    const writes: LogicalPoint[] = [];
    let resolveFirstWrite: (() => void) | undefined;
    const adapter = new NativeWindowMotionAdapter(
      createNativeMotionApi((position) => {
        writes.push({ ...position });
        return new Promise<void>((resolve) => {
          resolveFirstWrite = resolve;
        });
      }),
      { clock },
    );

    adapter.requestPosition({ x: 101, y: 140 });
    clock.advanceBy(0);
    await flushAsyncWork();
    expect(writes).toEqual([{ x: 101, y: 140 }]);

    adapter.requestPosition({ x: 102, y: 140 });
    adapter.requestPosition({ x: 103, y: 140 });
    clock.advanceBy(WINDOW_POSITION_COMMAND_INTERVAL_MS + 2);
    expect(writes).toEqual([{ x: 101, y: 140 }]);

    resolveFirstWrite?.();
    await flushAsyncWork();
    clock.advanceBy(0);
    await flushAsyncWork();

    expect(writes).toEqual([
      { x: 101, y: 140 },
      { x: 103, y: 140 },
    ]);
  });
});

describe("LineDog Phase B walk renderer", () => {
  it("mirrors only the rendered side-right Walk canvas without changing the source asset", () => {
    const stage = { dataset: { facing: "Right" } };

    expect(createSpriteSurfaceMarkup()).toContain('data-facing="Right"');
    applySpriteFacing(stage, "Left");
    expect(stage.dataset.facing).toBe("Left");
    applySpriteFacing(stage, "Right");
    expect(stage.dataset.facing).toBe("Right");
  });
});
