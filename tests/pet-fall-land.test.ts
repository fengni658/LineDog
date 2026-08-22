import frozenManifest from "../public/character/manifest.json";
import { describe, expect, it } from "vitest";

import { type TimelineClock } from "../src/animation-timeline";
import type {
  CurrentWorkAreaSnapshot,
  LogicalPoint,
  MotionSnapshot,
  PetMotionPort,
} from "../src/native-motion";
import {
  createDefaultRuntimeResources,
  parseCharacterManifest,
} from "../src/pet-manifest";
import {
  FALL_MOTION_TICK_MS,
  FALL_WORK_AREA_REFRESH_INTERVAL_MS,
  MAX_FALL_PHYSICS_DELTA_MS,
  PET_BEHAVIOR_CONFIG,
  RUNTIME_FOOT_BASELINE_LOGICAL_PX,
  PetRuntime,
  clampFallPhysicsDeltaMs,
  getGroundWindowTopY,
  integrateFallPhysicsStep,
} from "../src/pet-runtime";

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
    currentMonitorId: "first-monitor",
    workArea: { x: 10, y: 20, width: 500, height: 400 },
    windowPosition: { x: 120, y: 120 },
  };
  public workAreaFact: CurrentWorkAreaSnapshot | null = {
    currentMonitorId: "first-monitor",
    workArea: { x: 10, y: 20, width: 500, height: 400 },
  };
  public readonly requests: LogicalPoint[] = [];
  public currentWorkAreaCalls = 0;
  public resyncCalls = 0;
  public stopCalls = 0;

  async resync(): Promise<MotionSnapshot | null> {
    this.resyncCalls += 1;
    return this.snapshot;
  }

  async readCurrentWorkArea(): Promise<CurrentWorkAreaSnapshot | null> {
    this.currentWorkAreaCalls += 1;
    return this.workAreaFact;
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

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createRuntime(
  clock: FakeClock,
  motion: FakeMotionPort,
  onFrame: (animationId: string, frameIndex: number) => void = () => undefined,
): PetRuntime {
  return new PetRuntime(resources, {
    clock,
    motionPort: motion,
    random: () => 0,
    onFrame: ({ animationId, frameIndex }) => onFrame(animationId, frameIndex),
  });
}

async function releaseDragIntoPhaseD(
  runtime: PetRuntime,
  motion: FakeMotionPort,
  snapshot: MotionSnapshot,
): Promise<void> {
  await runtime.initialize(async () => undefined);
  expect(runtime.beginPointerGesture()).toBe(true);
  expect(runtime.promotePointerGestureToDrag()).toBe(true);
  motion.snapshot = snapshot;
  motion.workAreaFact = {
    currentMonitorId: snapshot.currentMonitorId,
    workArea: snapshot.workArea,
  };
  await expect(
    runtime.endPointerGesture({ triggerHappy: false }),
  ).resolves.toBe(false);
}

describe("LineDog Phase D fall physics", () => {
  it("uses elapsed seconds, clamps a stalled delta, and caps fall velocity", () => {
    expect(RUNTIME_FOOT_BASELINE_LOGICAL_PX).toBe(140);
    expect(MAX_FALL_PHYSICS_DELTA_MS).toBeGreaterThan(0);
    expect(clampFallPhysicsDeltaMs(10_000)).toBe(MAX_FALL_PHYSICS_DELTA_MS);

    expect(
      integrateFallPhysicsStep(100, 0, MAX_FALL_PHYSICS_DELTA_MS),
    ).toEqual({
      positionY: 109,
      verticalVelocityLogicalPxPerSecond: 180,
      elapsedMs: MAX_FALL_PHYSICS_DELTA_MS,
    });
    expect(
      integrateFallPhysicsStep(100, 1_190, MAX_FALL_PHYSICS_DELTA_MS),
    ).toMatchObject({
      verticalVelocityLogicalPxPerSecond:
        PET_BEHAVIOR_CONFIG.fall.maxSpeedLogicalPxPerSecond,
    });
  });

  it("uses the visible foot baseline for exact ground, clamps released X, and routes DRAG release to FALL", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const runtime = createRuntime(clock, motion);
    const workArea = { x: 10, y: 20, width: 500, height: 400 };
    const released = {
      currentMonitorId: "first-monitor",
      workArea,
      windowPosition: { x: -20, y: 120 },
    };

    expect(getGroundWindowTopY(workArea)).toBe(280);
    await releaseDragIntoPhaseD(runtime, motion, released);

    expect(runtime.state).toMatchObject({
      behavior: "FALL",
      activeAnimationId: "fall",
      interaction: "NONE",
      isDragging: false,
      currentMonitorId: "first-monitor",
      logicalPosition: { x: 10, y: 120 },
      verticalVelocityLogicalPxPerSecond: 0,
      groundTopY: 280,
    });
    expect(runtime.triggerHappy()).toBe(false);
    expect(motion.requests.at(-1)).toEqual({ x: 10, y: 120 });
  });

  it("lands at the exact foot-baseline ground without bounce, then plays Land for exactly 250ms", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const frames: number[] = [];
    const runtime = createRuntime(clock, motion, (animationId, frameIndex) => {
      if (animationId === "land") {
        frames.push(frameIndex);
      }
    });
    const workArea = { x: 10, y: 20, width: 500, height: 400 };

    await releaseDragIntoPhaseD(runtime, motion, {
      currentMonitorId: "first-monitor",
      workArea,
      windowPosition: { x: 120, y: 270 },
    });
    clock.advanceBy(150);

    expect(runtime.state).toMatchObject({
      behavior: "LAND",
      activeAnimationId: "land",
      logicalPosition: { x: 120, y: 280 },
      verticalVelocityLogicalPxPerSecond: 0,
      groundTopY: 280,
    });
    expect(motion.requests.at(-1)).toEqual({ x: 120, y: 280 });
    expect(frames).toEqual([0]);

    clock.advanceBy(90);
    clock.advanceBy(80);
    expect(frames).toEqual([0, 1, 2]);
    clock.advanceBy(80);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      activeAnimationId: "idle",
      logicalPosition: { x: 120, y: 280 },
    });
  });

  it("enters LAND immediately when a released window is already at or below ground", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const runtime = createRuntime(clock, motion);

    await releaseDragIntoPhaseD(runtime, motion, {
      currentMonitorId: "first-monitor",
      workArea: { x: 10, y: 20, width: 500, height: 400 },
      windowPosition: { x: 120, y: 320 },
    });

    expect(runtime.state).toMatchObject({
      behavior: "LAND",
      logicalPosition: { x: 120, y: 280 },
      verticalVelocityLogicalPxPerSecond: 0,
    });
  });

  it("blocks Blink, Look, and autonomous behavior while falling or landing", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const runtime = createRuntime(clock, motion);

    await releaseDragIntoPhaseD(runtime, motion, {
      currentMonitorId: "first-monitor",
      workArea: { x: 0, y: 0, width: 500, height: 10_000 },
      windowPosition: { x: 120, y: 0 },
    });
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(runtime.triggerBlink()).toBe(false);
    expect(runtime.state.behavior).toBe("FALL");

    clock.advanceBy(1_000);
    expect(runtime.state.behavior).toBe("FALL");
    expect(runtime.state.activeAnimationId).toBe("fall");
  });

  it("keeps FALL/LAND on a sub-threshold gesture but allows a true drag to preempt either state", async () => {
    const fallClock = new FakeClock();
    const fallMotion = new FakeMotionPort();
    const fallRuntime = createRuntime(fallClock, fallMotion);
    await releaseDragIntoPhaseD(fallRuntime, fallMotion, {
      currentMonitorId: "first-monitor",
      workArea: { x: 10, y: 20, width: 500, height: 400 },
      windowPosition: { x: 120, y: 120 },
    });

    expect(fallRuntime.beginPointerGesture()).toBe(true);
    expect(fallRuntime.state).toMatchObject({
      behavior: "FALL",
      interaction: "ARMED",
    });
    await expect(
      fallRuntime.endPointerGesture({ triggerHappy: true }),
    ).resolves.toBe(false);
    expect(fallRuntime.state).toMatchObject({
      behavior: "FALL",
      interaction: "NONE",
    });

    expect(fallRuntime.beginPointerGesture()).toBe(true);
    expect(fallRuntime.promotePointerGestureToDrag()).toBe(true);
    expect(fallRuntime.state).toMatchObject({ behavior: "DRAG", interaction: "DRAG" });

    const landClock = new FakeClock();
    const landMotion = new FakeMotionPort();
    const landRuntime = createRuntime(landClock, landMotion);
    await releaseDragIntoPhaseD(landRuntime, landMotion, {
      currentMonitorId: "first-monitor",
      workArea: { x: 10, y: 20, width: 500, height: 400 },
      windowPosition: { x: 120, y: 320 },
    });
    expect(landRuntime.state.behavior).toBe("LAND");

    expect(landRuntime.beginPointerGesture()).toBe(true);
    await expect(
      landRuntime.endPointerGesture({ triggerHappy: true }),
    ).resolves.toBe(false);
    expect(landRuntime.state).toMatchObject({ behavior: "LAND", interaction: "NONE" });
    expect(landRuntime.beginPointerGesture()).toBe(true);
    expect(landRuntime.promotePointerGestureToDrag()).toBe(true);
    expect(landRuntime.state).toMatchObject({ behavior: "DRAG", interaction: "DRAG" });
  });

  it("finishes LAND safely after an armed sub-threshold release and then resumes Idle scheduling", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const runtime = createRuntime(clock, motion);
    await releaseDragIntoPhaseD(runtime, motion, {
      currentMonitorId: "first-monitor",
      workArea: { x: 10, y: 20, width: 500, height: 400 },
      windowPosition: { x: 120, y: 320 },
    });

    expect(runtime.state.behavior).toBe("LAND");
    expect(runtime.beginPointerGesture()).toBe(true);
    await expect(
      runtime.endPointerGesture({ triggerHappy: true }),
    ).resolves.toBe(false);

    clock.advanceBy(250);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      interaction: "NONE",
      activeAnimationId: "idle",
    });

    clock.advanceBy(2_500);
    expect(runtime.state.animationLayer).toBe("BLINK");
  });

  it("refreshes current WorkArea facts during FALL instead of hard-coding the primary monitor", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const runtime = createRuntime(clock, motion);
    await releaseDragIntoPhaseD(runtime, motion, {
      currentMonitorId: "first-monitor",
      workArea: { x: 0, y: 0, width: 500, height: 10_000 },
      windowPosition: { x: 120, y: 0 },
    });

    motion.workAreaFact = {
      currentMonitorId: "second-monitor",
      workArea: { x: 100, y: 0, width: 500, height: 150 },
    };
    clock.advanceBy(FALL_WORK_AREA_REFRESH_INTERVAL_MS + FALL_MOTION_TICK_MS);
    await flushAsyncWork();

    expect(motion.currentWorkAreaCalls).toBeGreaterThan(0);
    expect(runtime.state).toMatchObject({
      behavior: "LAND",
      currentMonitorId: "second-monitor",
      logicalPosition: { x: 120, y: 10 },
      groundTopY: 10,
    });
  });
});
