import frozenManifest from "../public/character/manifest.json";
import { describe, expect, it } from "vitest";

import { AnimationTimeline, type TimelineClock } from "../src/animation-timeline";
import {
  createDefaultRuntimeResources,
  parseCharacterManifest,
} from "../src/pet-manifest";
import {
  PET_BEHAVIOR_CONFIG,
  PetRuntime,
  sampleBlinkDelayMs,
  shouldScheduleDoubleBlink,
} from "../src/pet-runtime";
import {
  createSpriteSurfaceMarkup,
  preloadRuntimeFrames,
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

const resources = createDefaultRuntimeResources(
  parseCharacterManifest(frozenManifest),
);

function randomSequence(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe("LineDog manifest-driven animation timeline", () => {
  it("plays the frozen Blink frames in [120, 160, 220] ms order and emits its next-state signal", () => {
    const clock = new FakeClock();
    const timeline = new AnimationTimeline(clock);
    const frameEvents: string[] = [];
    const completions: string[] = [];

    timeline.play(resources.blink, {
      onFrame: ({ animationId, frameIndex, frame, timestampMs }) => {
        frameEvents.push(
          `${animationId}:${frameIndex}:${frame.durationMs}:${timestampMs}`,
        );
      },
      onComplete: ({ animationId, nextState }) => {
        completions.push(`${animationId}:${nextState}`);
      },
    });

    expect(frameEvents).toEqual(["blink:0:120:0"]);
    clock.advanceBy(120);
    clock.advanceBy(160);
    expect(frameEvents).toEqual([
      "blink:0:120:0",
      "blink:1:160:120",
      "blink:2:220:280",
    ]);

    clock.advanceBy(220);
    expect(completions).toEqual(["blink:IDLE"]);
  });

  it("loops Idle in manifest frame order without a completion signal", () => {
    const clock = new FakeClock();
    const timeline = new AnimationTimeline(clock);
    const frameIndexes: number[] = [];
    const completions: string[] = [];

    timeline.play(resources.idle, {
      onFrame: ({ frameIndex }) => frameIndexes.push(frameIndex),
      onComplete: ({ nextState }) => completions.push(nextState),
    });

    clock.advanceBy(420 + 320 + 420 + 320);

    expect(frameIndexes).toEqual([0, 1, 2, 3, 0]);
    expect(completions).toEqual([]);
  });
});

describe("LineDog Phase A runtime", () => {
  it("uses one raster sprite element and preloads every frozen default runtime frame before readiness", async () => {
    const markup = createSpriteSurfaceMarkup();
    const preloadedUrls: string[] = [];

    expect(markup.match(/<img\b/g)).toHaveLength(1);
    expect(markup).not.toContain("<canvas");
    expect(markup).toContain('data-runtime-state="loading"');

    await preloadRuntimeFrames(resources, async (url) => {
      preloadedUrls.push(url);
    });

    expect(preloadedUrls).toEqual([
      ...resources.idle.frames.map((frame) => frame.url),
      ...resources.blink.frames.map((frame) => frame.url),
      ...resources.walk.frames.map((frame) => frame.url),
      ...resources.lookMouse.frames.map((frame) => frame.url),
      ...resources.happy.frames.map((frame) => frame.url),
      ...resources.drag.frames.map((frame) => frame.url),
      ...resources.fall.frames.map((frame) => frame.url),
      ...resources.land.frames.map((frame) => frame.url),
      ...(
        resources as unknown as {
          turn: { frames: readonly { url: string }[] };
        }
      ).turn.frames.map((frame) => frame.url),
    ]);
  });

  it("keeps IDLE as the behavior state while Blink is a non-stacking animation layer", async () => {
    const clock = new FakeClock();
    const runtime = new PetRuntime(resources, {
      clock,
      random: randomSequence([0, 1, 1]),
    });

    expect(runtime.state).toMatchObject({
      readiness: "loading",
      behavior: "IDLE",
      animationLayer: "BASE",
    });

    await runtime.initialize(async () => undefined);
    expect(runtime.state).toMatchObject({
      readiness: "ready",
      behavior: "IDLE",
      animationLayer: "BASE",
      activeAnimationId: "idle",
    });

    clock.advanceBy(PET_BEHAVIOR_CONFIG.blink.intervalMinMs);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      animationLayer: "BLINK",
      activeAnimationId: "blink",
    });
    expect(runtime.triggerBlink()).toBe(false);

    clock.advanceBy(120 + 160 + 220);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      animationLayer: "BASE",
      activeAnimationId: "idle",
    });
  });

  it("uses the deterministic 0.08 decision to play exactly one immediate second Blink without adding a behavior state", async () => {
    const clock = new FakeClock();
    const blinkFrames: number[] = [];
    const runtime = new PetRuntime(resources, {
      clock,
      random: randomSequence([0, 1, 0, 1]),
      onFrame: ({ animationId, frameIndex }) => {
        if (animationId === "blink") {
          blinkFrames.push(frameIndex);
        }
      },
    });

    await runtime.initialize(async () => undefined);
    clock.advanceBy(PET_BEHAVIOR_CONFIG.blink.intervalMinMs + 120 + 160 + 220);

    expect(blinkFrames).toEqual([0, 1, 2, 0]);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      animationLayer: "BLINK",
      activeAnimationId: "blink",
    });

    clock.advanceBy(120 + 160 + 220);
    expect(blinkFrames).toEqual([0, 1, 2, 0, 1, 2]);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      animationLayer: "BASE",
      activeAnimationId: "idle",
    });
  });

  it("maps DRAG to frozen Drag rather than Idle and lets direct interaction interrupt a queued double Blink", async () => {
    const clock = new FakeClock();
    const runtime = new PetRuntime(resources, {
      clock,
      random: randomSequence([0, 1, 0]),
    });

    await runtime.initialize(async () => undefined);
    expect(runtime.beginDrag()).toBe(true);
    expect(runtime.state).toMatchObject({
      behavior: "DRAG",
      interaction: "DRAG",
      activeAnimationId: "drag",
    });

    const happyClock = new FakeClock();
    const happyRuntime = new PetRuntime(resources, {
      clock: happyClock,
      random: randomSequence([0, 1, 0]),
    });
    await happyRuntime.initialize(async () => undefined);
    happyClock.advanceBy(
      PET_BEHAVIOR_CONFIG.blink.intervalMinMs + 120 + 160 + 220,
    );
    expect(happyRuntime.triggerHappy()).toBe(true);
    expect(happyRuntime.state).toMatchObject({
      behavior: "HAPPY",
      animationLayer: "BASE",
      activeAnimationId: "happy",
    });
  });

  it("preempts Blink only when its manifest policy permits user interaction", async () => {
    const clock = new FakeClock();
    const blinkFrames: number[] = [];
    const runtime = new PetRuntime(resources, {
      clock,
      random: () => 0,
      onFrame: ({ animationId, frameIndex }) => {
        if (animationId === "blink") {
          blinkFrames.push(frameIndex);
        }
      },
    });

    await runtime.initialize(async () => undefined);
    clock.advanceBy(PET_BEHAVIOR_CONFIG.blink.intervalMinMs);

    expect(runtime.handleUserInteraction()).toBe(true);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      animationLayer: "BASE",
      activeAnimationId: "idle",
    });

    clock.advanceBy(120 + 160 + 220);
    expect(blinkFrames).toEqual([0]);

    const nonInterruptibleManifest = structuredClone(frozenManifest);
    nonInterruptibleManifest.animations.blink.interruptPolicy =
      "interruptible_at_frame_boundary";
    const nonInterruptibleClock = new FakeClock();
    const nonInterruptibleRuntime = new PetRuntime(
      createDefaultRuntimeResources(
        parseCharacterManifest(nonInterruptibleManifest),
      ),
      { clock: nonInterruptibleClock, random: () => 0 },
    );
    await nonInterruptibleRuntime.initialize(async () => undefined);
    nonInterruptibleClock.advanceBy(PET_BEHAVIOR_CONFIG.blink.intervalMinMs);

    expect(nonInterruptibleRuntime.handleUserInteraction()).toBe(false);
    expect(nonInterruptibleRuntime.state).toMatchObject({
      behavior: "IDLE",
      animationLayer: "BLINK",
      activeAnimationId: "blink",
    });
  });

  it("keeps all frozen behavior constants in TypeScript and samples the approved Blink range", () => {
    expect(PET_BEHAVIOR_CONFIG).toMatchObject({
      idle: { minDurationMs: 3_000, maxDurationMs: 8_000 },
      blink: { intervalMinMs: 2_500, intervalMaxMs: 6_000 },
      walk: {
        minDurationMs: 2_000,
        maxDurationMs: 6_000,
        minSpeedLogicalPxPerSecond: 45,
        maxSpeedLogicalPxPerSecond: 60,
      },
      pause: { minDurationMs: 1_000, maxDurationMs: 3_000 },
      look: { enterRadiusLogicalPx: 90, exitRadiusLogicalPx: 130, exitDelayMs: 500 },
      fall: { gravityLogicalPxPerSecondSquared: 1_800, maxSpeedLogicalPxPerSecond: 1_200 },
      land: { durationMs: 250 },
    });
    expect(sampleBlinkDelayMs(() => 0)).toBe(2_500);
    expect(sampleBlinkDelayMs(() => 1)).toBe(6_000);
    expect(shouldScheduleDoubleBlink(() => 0)).toBe(true);
    expect(shouldScheduleDoubleBlink(() => 0.99)).toBe(false);
  });
});
