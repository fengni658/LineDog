import frozenManifest from "../public/character/manifest.json";
import { describe, expect, it } from "vitest";

import {
  type TimelineClock,
  type TimelineFrameEvent,
} from "../src/animation-timeline";
import type {
  LogicalPoint,
  MotionSnapshot,
  PetMotionPort,
} from "../src/native-motion";
import {
  createDefaultRuntimeResources,
  parseCharacterManifest,
} from "../src/pet-manifest";
import {
  PET_BEHAVIOR_CONFIG,
  PetRuntime,
} from "../src/pet-runtime";
import { resolveSpriteFacing } from "../src/sprite-renderer";

const TURN_TOTAL_DURATION_MS = 60 + 80 + 100 + 80 + 60;
const TURN_F03_BOUNDARY_MS = 60 + 80;

type TurnPresentation = Readonly<{
  visualTransition?: "NONE" | "TURN";
  turnTargetFacing?: "Left" | "Right";
  turnFrameMirrored?: boolean;
}>;

const resolvePresentationFacing = resolveSpriteFacing as unknown as (
  behavior: string,
  facing: "Left" | "Right",
  visualTransition?: "NONE" | "TURN",
  turnFrameMirrored?: boolean,
) => "Left" | "Right";

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
  public stopCalls = 0;

  async resync(): Promise<MotionSnapshot | null> {
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
  motion: FakeMotionPort,
  randomValues: readonly number[],
  onFrame: (event: TimelineFrameEvent) => void = () => undefined,
  onStateChange: () => void = () => undefined,
): PetRuntime {
  return new PetRuntime(resources, {
    clock,
    motionPort: motion,
    random: randomSequence(randomValues),
    onFrame,
    onStateChange,
  });
}

async function advanceToFirstAutonomousWalk(
  clock: FakeClock,
  runtime: PetRuntime,
): Promise<void> {
  await runtime.initialize(async () => undefined);
  clock.advanceBy(PET_BEHAVIOR_CONFIG.idle.minDurationMs);
  await flushAsyncWork();
}

function presentationOf(value: unknown): TurnPresentation {
  return value as TurnPresentation;
}

describe("LineDog TURN r1 autonomous transition", () => {
  it("defers an opposite-facing WALK through all TURN frames without translating, and switches logical Facing at F03 only", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const frames: TimelineFrameEvent[] = [];
    const transitionFacings: string[] = [];
    const runtime = createRuntime(
      clock,
      motion,
      [1, 0, 0.65, 0, 0, 0],
      (event) => frames.push(event),
      () => {
        const presentation = presentationOf(runtime.state);
        if (presentation.visualTransition === "TURN") {
          transitionFacings.push(runtime.state.facing);
        }
      },
    );

    await advanceToFirstAutonomousWalk(clock, runtime);

    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      activeAnimationId: "turn",
      facing: "Right",
      visualTransition: "TURN",
      turnTargetFacing: "Left",
      turnFrameMirrored: false,
    });
    expect(motion.requests).toEqual([]);
    expect(
      resolvePresentationFacing(
        runtime.state.behavior,
        runtime.state.facing,
        presentationOf(runtime.state).visualTransition,
        presentationOf(runtime.state).turnFrameMirrored,
      ),
    ).toBe("Right");

    clock.advanceBy(TURN_F03_BOUNDARY_MS);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      facing: "Left",
      visualTransition: "TURN",
    });
    expect(
      resolvePresentationFacing(
        runtime.state.behavior,
        runtime.state.facing,
        presentationOf(runtime.state).visualTransition,
        presentationOf(runtime.state).turnFrameMirrored,
      ),
    ).toBe("Right");
    expect(transitionFacings).toEqual(["Right", "Left"]);
    expect(motion.requests).toEqual([]);

    clock.advanceBy(TURN_TOTAL_DURATION_MS - TURN_F03_BOUNDARY_MS);
    expect(frames.filter((event) => event.animationId === "turn").map((event) => event.frameIndex)).toEqual([
      0,
      1,
      2,
      3,
      4,
    ]);
    expect(runtime.state).toMatchObject({
      behavior: "WALK",
      activeAnimationId: "walk",
      facing: "Left",
      visualTransition: "NONE",
    });
    expect(motion.requests).toEqual([{ x: 120, y: 140 }]);
  });

  it("skips TURN for a same-facing WALK", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const frames: TimelineFrameEvent[] = [];
    const runtime = createRuntime(clock, motion, [1, 0, 0.65, 0, 0, 1], (event) => {
      frames.push(event);
    });

    await advanceToFirstAutonomousWalk(clock, runtime);

    expect(runtime.state).toMatchObject({
      behavior: "WALK",
      activeAnimationId: "walk",
      facing: "Right",
      visualTransition: "NONE",
    });
    expect(frames.filter((event) => event.animationId === "turn")).toEqual([]);
    expect(motion.requests).toEqual([{ x: 120, y: 140 }]);
  });

  it("mirrors Left-to-Right TURN as one forward ordered sequence instead of reversing its frames", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const frames: TimelineFrameEvent[] = [];
    const runtime = createRuntime(
      clock,
      motion,
      [1, 0, 0.65, 0, 0, 0, 1, 0, 0.65, 0, 0, 1],
      (event) => frames.push(event),
    );

    await advanceToFirstAutonomousWalk(clock, runtime);
    clock.advanceBy(TURN_TOTAL_DURATION_MS);
    expect(runtime.state).toMatchObject({ behavior: "WALK", facing: "Left" });

    expect(runtime.handleUserInteraction()).toBe(true);
    const secondTurnFrameStart = frames.length;
    clock.advanceBy(PET_BEHAVIOR_CONFIG.idle.minDurationMs);
    await flushAsyncWork();

    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      activeAnimationId: "turn",
      facing: "Left",
      visualTransition: "TURN",
      turnTargetFacing: "Right",
      turnFrameMirrored: true,
    });
    expect(
      resolvePresentationFacing(
        runtime.state.behavior,
        runtime.state.facing,
        presentationOf(runtime.state).visualTransition,
        presentationOf(runtime.state).turnFrameMirrored,
      ),
    ).toBe("Left");

    clock.advanceBy(TURN_F03_BOUNDARY_MS);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      facing: "Right",
      visualTransition: "TURN",
    });
    expect(
      resolvePresentationFacing(
        runtime.state.behavior,
        runtime.state.facing,
        presentationOf(runtime.state).visualTransition,
        presentationOf(runtime.state).turnFrameMirrored,
      ),
    ).toBe("Left");

    clock.advanceBy(TURN_TOTAL_DURATION_MS - TURN_F03_BOUNDARY_MS);
    expect(
      frames
        .slice(secondTurnFrameStart)
        .filter((event) => event.animationId === "turn")
        .map((event) => event.frame.url),
    ).toEqual([
      "/character/turn/frame_01.png",
      "/character/turn/frame_02.png",
      "/character/turn/frame_03.png",
      "/character/turn/frame_04.png",
      "/character/turn/frame_05.png",
    ]);
    expect(runtime.state).toMatchObject({ behavior: "WALK", facing: "Right" });
  });

  it("clears TURN and its pending WALK immediately for a true Drag", async () => {
    const clock = new FakeClock();
    const motion = new FakeMotionPort();
    const runtime = createRuntime(clock, motion, [1, 0, 0.65, 0, 0, 0]);

    await advanceToFirstAutonomousWalk(clock, runtime);
    expect(runtime.beginDrag()).toBe(true);
    expect(runtime.state).toMatchObject({
      behavior: "DRAG",
      interaction: "DRAG",
      visualTransition: "NONE",
    });

    clock.advanceBy(TURN_TOTAL_DURATION_MS + 50);
    expect(runtime.state).toMatchObject({ behavior: "DRAG", interaction: "DRAG" });
    expect(motion.requests).toEqual([]);
  });

  it("lets Happy and Look preempt TURN without allowing its stale WALK to begin", async () => {
    const happyClock = new FakeClock();
    const happyMotion = new FakeMotionPort();
    const happyRuntime = createRuntime(
      happyClock,
      happyMotion,
      [1, 0, 0.65, 0, 0, 0],
    );
    await advanceToFirstAutonomousWalk(happyClock, happyRuntime);

    expect(happyRuntime.triggerHappy()).toBe(true);
    happyClock.advanceBy(TURN_TOTAL_DURATION_MS);
    expect(happyRuntime.state).toMatchObject({ behavior: "HAPPY", visualTransition: "NONE" });
    expect(happyMotion.requests).toEqual([]);

    const lookClock = new FakeClock();
    const lookMotion = new FakeMotionPort();
    const lookRuntime = createRuntime(
      lookClock,
      lookMotion,
      [1, 0, 0.65, 0, 0, 0],
    );
    await advanceToFirstAutonomousWalk(lookClock, lookRuntime);

    lookRuntime.handlePointerSample({ x: 80, y: 80 });
    expect(lookRuntime.state).toMatchObject({ behavior: "LOOK", visualTransition: "NONE" });
    lookClock.advanceBy(TURN_TOTAL_DURATION_MS);
    expect(lookRuntime.state.behavior).not.toBe("WALK");
    expect(lookMotion.requests).toEqual([]);
  });
});
