import frozenManifest from "../public/character/manifest.json";
import { describe, expect, it } from "vitest";

import { type TimelineClock } from "../src/animation-timeline";
import type { LogicalPoint, MotionSnapshot, PetMotionPort } from "../src/native-motion";
import {
  createDefaultRuntimeResources,
  parseCharacterManifest,
} from "../src/pet-manifest";
import {
  DIRECT_INTERACTION_STOP_MAX_MS,
  PET_BEHAVIOR_CONFIG,
  PetRuntime,
} from "../src/pet-runtime";
import { resolveSpriteFacing } from "../src/sprite-renderer";

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
    workArea: { x: 0, y: 0, width: 600, height: 400 },
    windowPosition: { x: 120, y: 240 },
  };
  public readonly requests: LogicalPoint[] = [];
  public stopCalls = 0;
  public resyncCalls = 0;

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

function createRuntime(
  clock: FakeClock,
  motion = new FakeMotionPort(),
  onFrame: (animationId: string, frameIndex: number) => void = () => undefined,
): PetRuntime {
  return new PetRuntime(resources, {
    clock,
    motionPort: motion,
    random: randomSequence([1, 0, 0.65, 0, 0, 1, 1, 1]),
    onFrame: ({ animationId, frameIndex }) => onFrame(animationId, frameIndex),
  });
}

async function enterWalk(clock: FakeClock, runtime: PetRuntime): Promise<void> {
  await runtime.initialize(async () => undefined);
  clock.advanceBy(PET_BEHAVIOR_CONFIG.idle.minDurationMs);
  await flushAsyncWork();
}

describe("LineDog Phase C2 Look", () => {
  it("enters only at 90px, preserves entry facing, and exits only after 130px for 500ms", async () => {
    const clock = new FakeClock();
    const runtime = createRuntime(clock);
    await runtime.initialize(async () => undefined);

    runtime.handlePointerSample({ x: 171, y: 80 });
    expect(runtime.state.behavior).toBe("IDLE");

    runtime.handlePointerSample({ x: 40, y: 80 });
    expect(runtime.state).toMatchObject({
      behavior: "LOOK",
      activeAnimationId: "look_mouse",
      facing: "Left",
    });

    runtime.handlePointerSample({ x: 150, y: 80 });
    expect(runtime.state.facing).toBe("Left");

    runtime.handlePointerSample({ x: 210, y: 80 });
    clock.advanceBy(PET_BEHAVIOR_CONFIG.look.exitDelayMs - 1);
    expect(runtime.state.behavior).toBe("LOOK");

    runtime.handlePointerSample({ x: 180, y: 80 });
    clock.advanceBy(PET_BEHAVIOR_CONFIG.look.exitDelayMs + 1);
    expect(runtime.state.behavior).toBe("LOOK");

    runtime.handlePointerSample({ x: 210, y: 80 });
    clock.advanceBy(PET_BEHAVIOR_CONFIG.look.exitDelayMs);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      activeAnimationId: "idle",
    });
  });

  it("safe-interrupts Walk into one-shot Look, holds F03, and never replays it", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const lookFrames: number[] = [];
    const runtime = createRuntime(clock, motion, (animationId, frameIndex) => {
      if (animationId === "look_mouse") {
        lookFrames.push(frameIndex);
      }
    });

    await enterWalk(clock, runtime);
    const writesBeforeLook = motion.requests.length;
    runtime.handlePointerSample({ x: 170, y: 80 });

    expect(DIRECT_INTERACTION_STOP_MAX_MS).toBeLessThanOrEqual(200);
    expect(runtime.state).toMatchObject({ behavior: "LOOK", facing: "Right" });
    expect(motion.stopCalls).toBeGreaterThan(0);

    clock.advanceBy(120 + 140 + 220 + 1_000);
    expect(lookFrames).toEqual([0, 1, 2]);
    expect(runtime.state).toMatchObject({
      behavior: "LOOK",
      activeAnimationId: "look_mouse",
      facing: "Right",
    });
    expect(motion.requests).toHaveLength(writesBeforeLook);
  });
});

describe("LineDog Phase C2 Happy", () => {
  it("plays Happy exactly once, suppresses rapid triggers, and routes to Look when the pointer remains near", async () => {
    const clock = new FakeClock();
    const happyFrames: number[] = [];
    const runtime = createRuntime(clock, undefined, (animationId, frameIndex) => {
      if (animationId === "happy") {
        happyFrames.push(frameIndex);
      }
    });
    await runtime.initialize(async () => undefined);
    runtime.handlePointerSample({ x: 80, y: 80 });

    expect(runtime.triggerHappy()).toBe(true);
    expect(runtime.triggerHappy()).toBe(false);
    expect(runtime.state).toMatchObject({
      behavior: "HAPPY",
      activeAnimationId: "happy",
    });

    runtime.handlePointerSample({ x: 220, y: 80 });
    expect(runtime.state.behavior).toBe("HAPPY");

    runtime.handlePointerSample({ x: 80, y: 80 });
    clock.advanceBy(120 + 140 + 180 + 140 + 220);

    expect(happyFrames).toEqual([0, 1, 2, 3, 4]);
    expect(runtime.state).toMatchObject({
      behavior: "LOOK",
      activeAnimationId: "look_mouse",
      facing: "Right",
    });
  });

  it("returns Happy to Idle when pointer is no longer near and lets a pointer gesture preempt it", async () => {
    const clock = new FakeClock();
    const runtime = createRuntime(clock);
    await runtime.initialize(async () => undefined);

    expect(runtime.triggerHappy()).toBe(true);
    runtime.handlePointerSample({ x: 240, y: 80 });
    clock.advanceBy(120 + 140 + 180 + 140 + 220);
    expect(runtime.state).toMatchObject({ behavior: "IDLE", activeAnimationId: "idle" });

    expect(runtime.triggerHappy()).toBe(true);
    expect(runtime.beginPointerGesture()).toBe(true);
    expect(runtime.promotePointerGestureToDrag()).toBe(true);
    runtime.handlePointerSample({ x: 80, y: 80 });

    expect(runtime.state).toMatchObject({
      behavior: "DRAG",
      interaction: "DRAG",
      isDragging: true,
    });
    expect(runtime.triggerHappy()).toBe(false);
  });

  it("stops autonomous movement for both ARMED and DRAG pointer phases", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const runtime = createRuntime(clock, motion);
    await runtime.initialize(async () => undefined);
    const requestsBeforeInteraction = motion.requests.length;

    expect(runtime.beginPointerGesture()).toBe(true);
    clock.advanceBy(PET_BEHAVIOR_CONFIG.idle.maxDurationMs + 1_000);
    expect(runtime.state.interaction).toBe("ARMED");
    expect(motion.requests).toHaveLength(requestsBeforeInteraction);

    expect(runtime.promotePointerGestureToDrag()).toBe(true);
    clock.advanceBy(PET_BEHAVIOR_CONFIG.idle.maxDurationMs + 1_000);
    expect(runtime.state).toMatchObject({ behavior: "DRAG", interaction: "DRAG" });
    expect(motion.requests).toHaveLength(requestsBeforeInteraction);
  });
});

describe("LineDog Phase C2 renderer facing", () => {
  it("mirrors Walk and Look only", () => {
    expect(resolveSpriteFacing("WALK", "Left")).toBe("Left");
    expect(resolveSpriteFacing("LOOK", "Left")).toBe("Left");
    expect(resolveSpriteFacing("IDLE", "Left")).toBe("Right");
    expect(resolveSpriteFacing("HAPPY", "Left")).toBe("Right");
    expect(resolveSpriteFacing("FALL", "Left")).toBe("Right");
    expect(resolveSpriteFacing("LAND", "Left")).toBe("Right");
  });
});
