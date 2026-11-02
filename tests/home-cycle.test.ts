import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import type { TimelineClock, TimelineFrameEvent } from "../src/animation-timeline";
import type {
  LogicalPoint,
  LogicalWorkArea,
  MotionSnapshot,
  PetMotionPort,
  WindowTopLeftLogical,
} from "../src/native-motion";
import type {
  DefaultRuntimeResources,
  RuntimeAnimation,
  RuntimeFrame,
} from "../src/pet-manifest";
import { PetRuntime, type PetRuntimeState } from "../src/pet-runtime";
import {
  computeHomeWalkRoute,
  sampleHomeRoundTrips,
  HOME_BOTTOM_MARGIN_LOGICAL,
  HOME_REST_FOOT_ANCHOR_CANVAS_X,
  HOME_REST_FOOT_ANCHOR_CANVAS_Y,
  HOME_LANDING_SURFACE_CANVAS_Y,
  HOME_AWAKE_DURATION_MS,
  HOME_INTERACTION_QUIET_MS,
  HOME_CYCLE_SPEED_LOGICAL_PX_PER_SECOND,
  HOME_CYCLE_TICK_MS,
  HOME_FADE_DURATION_MS,
  HOME_JUMP_DURATION_MS,
  HOME_LANDING_SURFACE_LOGICAL_LEFT_X,
  HOME_LANDING_SURFACE_LOGICAL_RIGHT_X,
  HOME_LANDING_SURFACE_LOGICAL_Y,
  HOME_REST_MAX_MS,
  HOME_REST_MIN_MS,
  HOME_WAKE_HOLD_MS,
  computeHomeEntryPoint,
  computeHomeJumpPoint,
  computeHomeJumpBounds,
  computeHomeLandingSurface,
  computeHomeRestPoint,
  computeHomeSurfaceRect,
  crossesHomeLandingSurface,
  resolveHomeMainVisibility,
  sampleHomeRestDurationMsForRevision,
} from "../src/home-cycle";

const WORK_AREA: LogicalWorkArea = {
  x: 0,
  y: 0,
  width: 1_000,
  height: 600,
};

function windowPosition(x: number, y: number): WindowTopLeftLogical {
  return {
    space: "WINDOW_TOP_LEFT_LOGICAL",
    x,
    y,
  };
}

function motionSnapshot(x = 100, y = 100): MotionSnapshot {
  return {
    currentMonitorId: "monitor-1",
    windowScaleFactor: 1,
    homeWindow: { ready: true, currentMonitorId: "monitor-1", windowScaleFactor: 1,
      rect: { x: 720, y: 344, width: 256, height: 256 } },
    workArea: WORK_AREA,
    windowPosition: windowPosition(x, y),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class ManualClock implements TimelineClock {
  private currentTimeMs = 0;
  private nextTimerId = 0;
  private readonly timers = new Map<
    number,
    { readonly dueAtMs: number; readonly callback: () => void }
  >();

  scheduledCount = 0;

  now(): number {
    return this.currentTimeMs;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const timerId = ++this.nextTimerId;
    this.timers.set(timerId, {
      dueAtMs: this.currentTimeMs + Math.max(0, delayMs),
      callback,
    });
    this.scheduledCount += 1;
    return timerId;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.timers.delete(handle);
    }
  }

  pendingCallbacks(): Array<() => void> {
    return [...this.timers.values()].map(timer => timer.callback);
  }

  advanceBy(deltaMs: number): void {
    this.currentTimeMs += deltaMs;
    while (true) {
      let nextTimerId: number | undefined;
      let nextDueAtMs = Number.POSITIVE_INFINITY;

      for (const [timerId, timer] of this.timers) {
        if (
          timer.dueAtMs <= this.currentTimeMs &&
          (timer.dueAtMs < nextDueAtMs ||
            (timer.dueAtMs === nextDueAtMs &&
              (nextTimerId === undefined || timerId < nextTimerId)))
        ) {
          nextTimerId = timerId;
          nextDueAtMs = timer.dueAtMs;
        }
      }

      if (nextTimerId === undefined) {
        return;
      }

      const timer = this.timers.get(nextTimerId);
      this.timers.delete(nextTimerId);
      timer?.callback();
    }
  }
}

function makeFrame(
  animationId: string,
  groundContact: boolean,
): RuntimeFrame {
  const logicalAssetKey = `${animationId}/0.png`;
  return {
    logicalAssetKey,
    src: logicalAssetKey,
    url: `/character/${logicalAssetKey}`,
    durationMs: 100,
    groundContact,
    visualAnchor: { x: 256, y: 448 },
    motionAnchor: groundContact
      ? { kind: "FOOT_CENTER", x: 256, y: 448 }
      : { kind: "AIRBORNE_REFERENCE", x: 256, y: 448 },
    contactGeometry: groundContact
      ? { kind: "FOOT_SEGMENT", leftX: 224, rightX: 288, y: 448 }
      : { kind: "AIRBORNE" },
  };
}

function makeAnimation(
  id: string,
  playback: "LOOP" | "ONCE" = "LOOP",
  groundContact = true,
): RuntimeAnimation {
  return {
    id,
    animationId: id,
    revision: "home-cycle-test",
    status: "FROZEN",
    sourceView: "front",
    loop: playback === "LOOP",
    interruptPolicy: "interruptible_by_user_interaction",
    nextState: "IDLE",
    frameDurationMs: 100,
    playback,
    reversePlaybackAllowed: false,
    frameDurationsMs: [100],
    frames: [makeFrame(id, groundContact)],
  };
}

const TEST_RESOURCES: DefaultRuntimeResources = {
  canvas: {
    width: 512,
    height: 512,
    centerX: 256,
    footBaseline: 448,
    safeMargin: 48,
  },
  runtimeWindow: {
    width: 160,
    height: 160,
  },
  idle: makeAnimation("idle"),
  blink: makeAnimation("blink", "ONCE"),
  walk: makeAnimation("walk"),
  lookMouse: makeAnimation("look_mouse", "ONCE"),
  happy: makeAnimation("happy", "ONCE"),
  drag: makeAnimation("drag"),
  fall: makeAnimation("fall", "LOOP", false),
  land: makeAnimation("land", "ONCE"),
  turn: makeAnimation("turn", "ONCE"),
  jumpAir: makeAnimation("jump_air", "ONCE", false),
  homeLand: makeAnimation("home_land", "ONCE"),
  homeIdle: makeAnimation("home_idle", "ONCE"),
  sleep: {
    ...makeAnimation("sleep"),
    hitBox: { x: 20, y: 60, width: 120, height: 80 },
    frameDurationsMs: [100, 100, 100, 100],
    frames: [0, 1, 2, 3].map(index => ({
      ...makeFrame("sleep", true),
      logicalAssetKey: `sleep/${index}.png`,
      src: `sleep/${index}.png`,
      url: `/character/sleep/${index}.png`,
    })),
  },
};

async function walkUntilHome(runtime: PetRuntime, clock: ManualClock): Promise<void> {
  for (let step = 0; step < 20000 && !runtime.state.homeCyclePhase; step += 1) {
    clock.advanceBy(50);
    await flushPromises();
  }
  expect(runtime.state.homeRoundTripsCompleted).toBe(runtime.state.homeRoundTripsTarget);
  expect(runtime.state.homeCyclePhase).toBe("GO_HOME");
}

describe("真实往返路线", () => {
  it.each([1, 1.25, 1.5, 2].flatMap(scale => [1, -1].map(sign => ({ scale, sign }))))(
    "整数物理回读保留半程：scale=$scale sign=$sign", async ({ scale, sign }) => {
      const clock = new ManualClock();
      const offset = sign === 1 ? 0 : -1000;
      const workArea = { ...WORK_AREA, x: offset, y: offset };
      // 与 Rust f64::round 一致，负半值不能使用 JS Math.round。
      const quantize = (value: number) =>
        Math.sign(value) * Math.floor(Math.abs(value * scale) + 0.5) / scale;
      expect(quantize(sign * 10.5 / scale)).toBe(sign * 11 / scale);
      let position = windowPosition(512 + offset, 460 + offset);
      const runtime = new PetRuntime(TEST_RESOURCES, {
        clock, random: () => 0.9, homeRandom: () => 0,
        motionPort: {
          resync: async () => ({ ...motionSnapshot(), workArea, windowScaleFactor: scale, windowPosition: position,
            homeWindow: { ready: true, currentMonitorId: "monitor-1", windowScaleFactor: scale,
              rect: { x: 720 + offset, y: 344 + offset, width: 256, height: 256 } } }),
          writeWindowTopLeft: async next => {
            position = windowPosition(quantize(next.x), quantize(next.y));
          },
        },
      });
      await runtime.initialize(async () => undefined);
      for (let step = 0; step < 10000 && runtime.state.homeRoundTripsCompleted !== 1; step++) {
        clock.advanceBy(50); await flushPromises();
      }
      expect(runtime.state.homeRoundTripsCompleted).toBe(1);
      for (let step = 0; step < 1000 && runtime.state.behavior !== "WALK"; step++) {
        clock.advanceBy(50); await flushPromises();
      }
      // 采样速度取整为 59 logical px/s；移动 4.5 个物理像素覆盖误差边界。
      clock.advanceBy(4500 / (scale * 59)); await flushPromises();
      expect(runtime.state.homeWalkTargetX).toBe(332 + offset);
      expect(Math.abs(runtime.state.logicalPosition!.x - position.x)).toBeCloseTo(0.5 / scale, 8);
      expect(runtime.triggerHappy()).toBe(true);
      clock.advanceBy(100); await flushPromises();
      for (let step = 0; step < 1000 && runtime.state.behavior !== "WALK"; step++) {
        clock.advanceBy(50); await flushPromises();
      }
      expect(runtime.state.behavior).toBe("WALK");
      expect(runtime.state.homeWalkTargetX).toBe(332 + offset);
      expect(runtime.state.homeRoundTripsCompleted).toBe(1);
      for (let step = 0; step < 10000 && runtime.state.homeRoundTripsCompleted !== 2; step++) {
        clock.advanceBy(50); await flushPromises();
      }
      expect(runtime.state.homeRoundTripsCompleted).toBe(2);
      runtime.dispose();
    },
  );

  it.each(["x外移", "y外移", "超出半像素", "monitor", "DPI"])(
    "%s 回读重置半程，换屏或 DPI 未稳定时等待 Home 事实", async change => {
      const clock = new ManualClock();
      let position = windowPosition(512, 460);
      let scale = 2;
      let monitor = "monitor-1";
      const runtime = new PetRuntime(TEST_RESOURCES, {
        clock, random: () => 1, homeRandom: () => 0,
        motionPort: {
          resync: async () => ({ ...motionSnapshot(), windowPosition: position, windowScaleFactor: scale, currentMonitorId: monitor,
            homeWindow: { ...motionSnapshot().homeWindow!, windowScaleFactor: 2 } }),
          writeWindowTopLeft: async next => { position = { ...next }; },
        },
      });
      await runtime.initialize(async () => undefined);
      for (let step = 0; step < 10000 && runtime.state.homeRoundTripsCompleted !== 1; step++) {
        clock.advanceBy(50); await flushPromises();
      }
      for (let step = 0; step < 1000 && runtime.state.behavior !== "WALK"; step++) {
        clock.advanceBy(50); await flushPromises();
      }
      clock.advanceBy(50); await flushPromises();
      expect(runtime.state.homeWalkTargetX).toBe(332);
      expect(runtime.triggerHappy()).toBe(true);
      clock.advanceBy(100); await flushPromises();
      if (change === "x外移") position = windowPosition(position.x - 50, position.y);
      if (change === "y外移") position = windowPosition(position.x, position.y - 50);
      if (change === "超出半像素") position = windowPosition(position.x - 0.25001, position.y);
      if (change === "monitor") monitor = "monitor-2";
      if (change === "DPI") scale = 1.25;
      for (let step = 0; step < 1000 && runtime.state.behavior !== "WALK"; step++) {
        clock.advanceBy(50); await flushPromises();
      }
      expect(runtime.state.behavior).toBe("WALK");
      expect(runtime.state.homeWalkTargetX).toBe(["monitor", "DPI"].includes(change) ? undefined : 512);
      expect(runtime.state.homeRoundTripsCompleted).toBe(["monitor", "DPI"].includes(change) ? undefined : 1);
      runtime.dispose();
    },
  );

  it.each([0, 1])("完成随机目标后才靠近，且普通随机流独立：%s", async (sample) => {
    const clock = new ManualClock();
    let position = windowPosition(512, 460);
    let homeSamples = 0;
    const targets: number[] = [];
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock, random: () => 1,
      homeRandom: () => { homeSamples += 1; return sample; },
      motionPort: {
        resync: async () => ({ ...motionSnapshot(), windowPosition: position }),
        writeWindowTopLeft: async next => { position = { ...next }; },
      },
      onStateChange: state => {
        if (state.homeWalkTargetX !== undefined && targets.at(-1) !== state.homeWalkTargetX) targets.push(state.homeWalkTargetX);
        if (!state.homeCyclePhase) expect(state.homePending).toBeUndefined();
      },
    });
    await runtime.initialize(async () => undefined);
    for (let step = 0; step < 20000 && runtime.state.homeRoundTripsCompleted !== 1; step += 1) {
      clock.advanceBy(50); await flushPromises();
    }
    expect(runtime.state.homeRoundTripsCompleted).toBe(1);
    expect(position.x).toBe(512);
    expect(targets.slice(0, 4)).toEqual([512, 332, 512, 332]);
    expect(runtime.triggerHappy()).toBe(true);
    clock.advanceBy(100); await flushPromises();
    expect(runtime.state.homeRoundTripsCompleted).toBe(1);
    expect(runtime.state.homeWalkTargetX).toBe(332);
    const target = sample === 0 ? 3 : 4;
    for (let step = 0; step < 20000 && runtime.state.homeRoundTripsCompleted !== target; step += 1) {
      clock.advanceBy(50); await flushPromises();
    }
    expect(position.x).toBe(512);
    expect(runtime.state.homeCyclePhase).toBeUndefined();
    expect(runtime.state.homeWalkTargetX).toBe(536);
    expect(homeSamples).toBe(1);
    await walkUntilHome(runtime, clock);
    expect(position.x).toBe(536);
    expect(runtime.state.motionOwner).toBe("AUTONOMOUS");
    runtime.dispose();
  });

  it("外部位移废弃半程保留圈数，只有工作区变化时等待实际 Home 回读", async () => {
    const clock = new ManualClock();
    let position = windowPosition(512, 460);
    let workArea = WORK_AREA;
    let samples = 0;
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock, random: () => 1, homeRandom: () => { samples++; return 0; },
      motionPort: {
        resync: async () => ({ ...motionSnapshot(), workArea, windowPosition: position }),
        writeWindowTopLeft: async next => { position = { ...next }; },
      },
    });
    await runtime.initialize(async () => undefined);
    for (let step = 0; step < 20000 && runtime.state.homeRoundTripsCompleted !== 1; step++) {
      clock.advanceBy(50); await flushPromises();
    }
    expect(runtime.state.homeRoundTripsCompleted).toBe(1);
    expect(runtime.beginDrag()).toBe(true);
    await flushPromises();
    expect(runtime.state.homeRoundTripsCompleted).toBe(1);
    expect(runtime.state.homeWalkTargetX).toBe(512);
    position = windowPosition(200, 460);
    await runtime.endDrag(); await flushPromises();
    for (let step = 0; step < 100 && runtime.state.behavior !== "IDLE"; step++) {
      clock.advanceBy(50); await flushPromises();
    }
    expect(runtime.state.homeRoundTripsCompleted).toBe(1);
    workArea = { ...WORK_AREA, x: -100, width: 900 };
    expect(await runtime.updateGroundWorkArea(workArea)).toBe(true);
    expect(runtime.state.homeRoundTripsCompleted).toBeUndefined();
    expect(runtime.state.homeWalkTargetX).toBeUndefined();
    expect(samples).toBe(1);
    expect(runtime.state.homeCyclePhase).toBeUndefined();
    runtime.dispose();
  });

  it("普通停顿不计圈，窄工作区保留普通活动", async () => {
    const clock = new ManualClock();
    let position = windowPosition(0, 460);
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock, random: () => 0, homeRandom: () => 0,
      motionPort: {
        resync: async () => ({ ...motionSnapshot(), workArea: { ...WORK_AREA, width: 500 }, windowPosition: position,
          homeWindow: { ...motionSnapshot().homeWindow!, rect: { x: 220, y: 344, width: 256, height: 256 } } }),
        writeWindowTopLeft: async next => { position = { ...next }; },
      },
    });
    await runtime.initialize(async () => undefined);
    for (let i = 0; i < 100; i++) { clock.advanceBy(1000); await flushPromises(); }
    expect(runtime.state.homeRoundTripsCompleted).toBe(0);
    expect(runtime.state.homeWalkTargetX).toBeUndefined();
    expect(runtime.state.homeCyclePhase).toBeUndefined();
    expect(runtime.state.behavior).toBe("IDLE");
    runtime.dispose();
  });
});

describe("窝内清醒周期回归", () => {
  async function setup(resources = TEST_RESOURCES, random = () => 1) {
    const clock = new ManualClock();
    let position = windowPosition(721, 300);
    const writes: WindowTopLeftLogical[] = [];
    const frames: TimelineFrameEvent[] = [];
    const runtime = new PetRuntime(resources, { clock, random, homeRandom: () => 0,
      onFrame: event => frames.push(event),
      motionPort: { resync: async () => motionSnapshot(position.x, position.y),
        writeWindowTopLeft: async next => { position = { ...next }; writes.push(position); } } });
    await runtime.initialize(async () => undefined);
    await flushPromises();
    runtime.beginDrag();
    await runtime.endDrag();
    for (let i = 0; i < 300 && runtime.state.homeAwakeStartedAtMs === undefined; i++) {
      clock.advanceBy(20); await flushPromises();
    }
    expect(runtime.state.homeAwakeStartedAtMs).toBeDefined();
    return { runtime, clock, writes, frames };
  }
  async function advance(clock: ManualClock, duration: number) {
    for (let left = duration; left > 0; left -= 20) {
      clock.advanceBy(Math.min(20, left)); await flushPromises();
    }
  }
  function rejectCurrentRestWrite(runtime: PetRuntime) {
    // Isolate the rejection callback boundary; no actual Windows failure is asserted.
    (runtime as unknown as { handleMotionRejection(value: unknown): void }).handleMotionRejection({
      isCurrentEpoch: true, isStaleEpoch: false, error: new Error("fixture write failure"),
      command: { epoch: 1, owner: "AUTONOMOUS", windowTopLeft: windowPosition(721, 392) },
    });
  }

  it("1.2.1 stationary nearby pointer triggers one Home look, hysteresis exit permits another", async () => {
    const { runtime, clock, frames } = await setup();
    const start = runtime.state.homeAwakeStartedAtMs;
    for (let i = 0; i < 300; i++) {
      runtime.handlePointerSample({ x: 80, y: 80 });
      await advance(clock, 20);
    }
    const countLooks = () => frames.filter(frame => frame.animationId === "look_mouse" && frame.frameIndex === 0).length;
    expect(countLooks()).toBe(1);
    runtime.handlePointerSample({ x: 185, y: 80 }); // Inside the existing hysteresis band.
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(countLooks()).toBe(1);
    runtime.handlePointerSample({ x: 400, y: 80 });
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(countLooks()).toBe(2);
    expect(runtime.state.homeAwakeStartedAtMs).toBe(start);
    runtime.dispose();
  });

  it("1.2.1 resting write recovery preserves awake deadline and does not invent interaction quiet time", async () => {
    const { runtime, clock } = await setup();
    const start = runtime.state.homeAwakeStartedAtMs;
    const quiet = runtime.state.homeQuietUntilMs;
    rejectCurrentRestWrite(runtime);
    await flushPromises();
    expect(runtime.state.homeAwakeStartedAtMs).toBe(start);
    expect(runtime.state.homeQuietUntilMs).toBe(quiet);
    expect(runtime.state.motionOwner).toBe("RECOVERY");
    await advance(clock, HOME_AWAKE_DURATION_MS + 3000);
    expect(runtime.state.activeAnimationId).toBe("sleep");
    runtime.dispose();
  });

  it("1.2.1 sleeping write recovery preserves sleep frame and original deadline", async () => {
    const { runtime, clock, frames, writes } = await setup();
    await advance(clock, HOME_AWAKE_DURATION_MS + 3000);
    expect(runtime.state.activeAnimationId).toBe("sleep");
    const deadline = runtime.state.homeRestDeadlineMs;
    const frameCount = frames.length;
    const writeCount = writes.length;
    rejectCurrentRestWrite(runtime);
    await flushPromises();
    expect(runtime.state.activeAnimationId).toBe("sleep");
    expect(runtime.state.homeRestDeadlineMs).toBe(deadline);
    expect(writes.length).toBe(writeCount + 1);
    rejectCurrentRestWrite(runtime); // Recovery owner cannot recursively retry.
    await advance(clock, 12000);
    expect(runtime.state.activeAnimationId).toBe("sleep");
    expect(runtime.state.homeRestDeadlineMs).toBe(deadline);
    expect(frames.length).toBe(frameCount);
    expect(writes.length).toBe(writeCount + 1);
    runtime.dispose();
  });

  it("1.2.1 paused sleep recovery stays asleep and resumes the saved remaining duration", async () => {
    const { runtime, clock, writes } = await setup();
    await advance(clock, HOME_AWAKE_DURATION_MS + 3000);
    const remaining = runtime.state.homeRestDeadlineMs! - clock.now();
    runtime.setAutonomyPaused(true);
    const beforeWrites = writes.length;
    rejectCurrentRestWrite(runtime);
    await advance(clock, 95000);
    expect(runtime.state.activeAnimationId).toBe("sleep");
    expect(runtime.state.homeRestDeadlineMs).toBeUndefined();
    expect(writes.length).toBe(beforeWrites + 1);
    runtime.setAutonomyPaused(false);
    expect(runtime.state.homeRestDeadlineMs).toBe(clock.now() + remaining);
    runtime.dispose();
  });

  it("1.2.1 wake hold recovery preserves its original departure timer", async () => {
    const { runtime, clock } = await setup();
    await advance(clock, HOME_AWAKE_DURATION_MS + 3000);
    await advance(clock, runtime.state.homeRestDeadlineMs! - clock.now());
    expect(runtime.state.activeAnimationId).toBe("home_idle");
    rejectCurrentRestWrite(runtime);
    await flushPromises();
    expect(runtime.state.activeAnimationId).toBe("home_idle");
    await advance(clock, HOME_WAKE_HOLD_MS + 20);
    expect(runtime.state.behavior).toBe("LEAVE_HOME");
    expect(runtime.state.activeAnimationId).toBe("jump_air");
    runtime.dispose();
  });

  it("1.2.1 settling recovery completes the same animation once, and real drag still interrupts sleep", async () => {
    const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(
      readFileSync(new URL("../public/character/manifest.json", import.meta.url), "utf8"))));
    const { runtime, clock, frames } = await setup(resources);
    await advance(clock, HOME_AWAKE_DURATION_MS + 100);
    expect(runtime.state.activeAnimationId).toBe("home_idle");
    rejectCurrentRestWrite(runtime);
    await flushPromises();
    expect(runtime.state.activeAnimationId).toBe("home_idle");
    await advance(clock, 2100);
    expect(runtime.state.activeAnimationId).toBe("sleep");
    expect(frames.filter(frame => frame.animationId === "home_idle" && frame.frameIndex === 0)).toHaveLength(1);
    expect(runtime.beginDrag()).toBe(true);
    await advance(clock, 5000);
    expect(runtime.state.behavior).toBe("DRAG");
    expect(runtime.state.activeAnimationId).toBe("drag");
    runtime.dispose();
  });

  it.each(["tick", "phase"].flatMap(timer =>
    ["dispose", "drag"].map(cancel => ({ timer, cancel })),
  ))("晚到旧 $timer 回调不丢失清醒新定时器，$cancel 仍可取消", async ({ timer, cancel }) => {
    const clock = new ManualClock();
    let position = windowPosition(512, 460);
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock, random: () => 1, homeRandom: () => 0,
      motionPort: {
        resync: async () => motionSnapshot(position.x, position.y),
        writeWindowTopLeft: async next => { position = { ...next }; },
      },
    });
    await runtime.initialize(async () => undefined);
    await walkUntilHome(runtime, clock);
    if (timer === "phase") {
      for (let i = 0; i < 300 && runtime.state.homeAwakeStartedAtMs === undefined; i++) {
        clock.advanceBy(20); await flushPromises();
      }
      expect(runtime.state.homeCyclePhase).toBe("REST");
      expect(runtime.state.homeAwakeStartedAtMs).toBeDefined();
    } else {
      expect(runtime.state.homeCyclePhase).toBe("GO_HOME");
    }
    const oldCallbacks = clock.pendingCallbacks();
    expect(oldCallbacks.length).toBeGreaterThan(0);
    expect(runtime.beginDrag()).toBe(true);
    runtime.movePointerDrag({ x: 721, y: 300 }, "monitor-1", WORK_AREA);
    await flushPromises();
    await runtime.endDrag();
    for (let i = 0; i < 300 && runtime.state.behavior !== "REST"; i++) {
      clock.advanceBy(20); await flushPromises();
    }
    expect(runtime.state).toMatchObject({ behavior: "REST", interaction: "NONE" });
    expect(runtime.state.homeAwakeStartedAtMs).toBeDefined();
    const newCallbacks = clock.pendingCallbacks();
    expect(newCallbacks.length).toBeGreaterThan(0);
    expect(newCallbacks.every(callback => !oldCallbacks.includes(callback))).toBe(true);
    const state = runtime.state;
    const scheduled = clock.scheduledCount;
    oldCallbacks.forEach(callback => callback());
    await flushPromises();
    expect(runtime.state).toEqual(state);
    expect(clock.scheduledCount).toBe(scheduled);
    expect(clock.pendingCallbacks()).toEqual(newCallbacks);
    if (cancel === "dispose") runtime.dispose();
    else expect(runtime.beginDrag()).toBe(true);
    await flushPromises();
    // 不只检查状态：丢失句柄的旧实现会留下一个无法取消的清醒计时回调。
    expect(clock.pendingCallbacks()).toEqual([]);
    const afterCancel = runtime.state;
    const scheduledAfterCancel = clock.scheduledCount;
    clock.advanceBy(HOME_AWAKE_DURATION_MS + HOME_REST_MAX_MS);
    await flushPromises();
    expect(clock.pendingCallbacks()).toEqual([]);
    expect(clock.scheduledCount).toBe(scheduledAfterCancel);
    expect(runtime.state).toEqual(afterCancel);
    runtime.dispose();
  });
  it("120秒清醒不因自主动作重计，静止近处指针不阻止睡眠，睡后才开始30–90秒", async () => {
    const { runtime, clock } = await setup();
    const start = runtime.state.homeAwakeStartedAtMs!;
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(runtime.state.activeAnimationId).toBe("look_mouse");
    await advance(clock, 119000);
    expect(runtime.state.homeAwakeStartedAtMs).toBe(start);
    expect(runtime.state.homeRestDeadlineMs).toBeUndefined();
    expect(runtime.state.behavior).toBe("REST");
    await advance(clock, 4000);
    expect(runtime.state.activeAnimationId).toBe("sleep");
    expect(runtime.state.homeRestDeadlineMs).toBeGreaterThanOrEqual(start + HOME_AWAKE_DURATION_MS + HOME_REST_MIN_MS);
    expect(runtime.state.homeRestDeadlineMs! - clock.now()).toBeLessThanOrEqual(HOME_REST_MAX_MS);
    runtime.dispose();
  });
  it("到点点击优先，反馈结束后安静10秒，点击唤醒留窝重新等120秒", async () => {
    const { runtime, clock } = await setup();
    const start = runtime.state.homeAwakeStartedAtMs;
    await advance(clock, 119960);
    const callbacks = clock.pendingCallbacks();
    expect(runtime.triggerHappy()).toBe(true);
    callbacks.forEach(callback => callback());
    expect(runtime.state.behavior).toBe("REST");
    expect(runtime.state.activeAnimationId).toBe("home_idle");
    await advance(clock, 2000);
    expect(runtime.state.homeAwakeStartedAtMs).toBe(start);
    const quiet = runtime.state.homeQuietUntilMs!;
    expect(quiet).toBeGreaterThanOrEqual(clock.now() + HOME_INTERACTION_QUIET_MS - 20);
    expect(quiet).toBeLessThanOrEqual(clock.now() + HOME_INTERACTION_QUIET_MS);
    await advance(clock, 9900);
    expect(runtime.state.activeAnimationId).not.toBe("sleep");
    await advance(clock, 4000);
    expect(runtime.state.activeAnimationId).toBe("sleep");
    const wake = clock.now();
    expect(runtime.triggerHappy()).toBe(true);
    await advance(clock, 2000);
    expect(runtime.state.homeAwakeStartedAtMs).toBe(wake);
    expect(runtime.state.homeRestDeadlineMs).toBeUndefined();
    expect(runtime.state.behavior).toBe("REST");
    await advance(clock, 117000);
    expect(runtime.state.activeAnimationId).not.toBe("sleep");
    runtime.dispose();
  });
  it("原处提起拖时禁睡，落回保留时间和安静窗口；真正移出后重新落稳重计", async () => {
    const { runtime, clock } = await setup();
    const start = runtime.state.homeAwakeStartedAtMs;
    await advance(clock, 119000);
    runtime.beginDrag();
    runtime.movePointerDrag({ x: 721, y: 250 }, "monitor-1", WORK_AREA);
    await flushPromises();
    await advance(clock, 10000);
    expect(runtime.state.behavior).toBe("DRAG");
    expect(runtime.state.homeAwakeStartedAtMs).toBe(start);
    await runtime.endDrag();
    await advance(clock, 1500);
    expect(runtime.state.homeAwakeStartedAtMs).toBe(start);
    expect(runtime.state.homeRestDeadlineMs).toBeUndefined();
    runtime.beginDrag();
    runtime.movePointerDrag({ x: 600, y: 250 }, "monitor-1", WORK_AREA);
    expect(runtime.state.homeAwakeStartedAtMs).toBeUndefined();
    runtime.movePointerDrag({ x: 721, y: 250 }, "monitor-1", WORK_AREA);
    await flushPromises();
    await runtime.endDrag();
    await advance(clock, 1500);
    expect(runtime.state.homeAwakeStartedAtMs).toBeGreaterThan(start!);
    expect(runtime.state.homeRestDeadlineMs).toBeUndefined();
    runtime.dispose();
  });
  it("松手回读未完成时仍禁睡，销毁后旧回读不恢复定位", async () => {
    const clock = new ManualClock();
    let position = windowPosition(721, 300);
    let resolveRead: ((snapshot: MotionSnapshot) => void) | undefined;
    let delayed = false;
    const writes: WindowTopLeftLogical[] = [];
    const runtime = new PetRuntime(TEST_RESOURCES, { clock, random: () => 0,
      motionPort: { resync: () => delayed ? new Promise(resolve => { resolveRead = resolve; }) : Promise.resolve(motionSnapshot(position.x, position.y)),
        writeWindowTopLeft: async next => { position = { ...next }; writes.push(position); } } });
    await runtime.initialize(async () => undefined);
    runtime.beginDrag(); await runtime.endDrag();
    await advance(clock, 1500);
    expect(runtime.state.homeAwakeStartedAtMs).toBeDefined();
    runtime.beginDrag();
    delayed = true;
    const ending = runtime.endDrag();
    await advance(clock, 150000);
    expect(runtime.state.behavior).toBe("DRAG");
    runtime.dispose();
    const count = writes.length;
    resolveRead!(motionSnapshot(position.x, position.y));
    await ending; await flushPromises();
    expect(writes).toHaveLength(count);
  });
  it("真实站立和睡眠姿态视觉锚448对齐新支撑线且restPoint稳定", async () => {
    const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(readFileSync(
      new URL("../public/character/manifest.json", import.meta.url), "utf8"))));
    const { runtime, clock, writes, frames } = await setup(resources);
    const rest = { x: 721, y: 392 };
    const begin = writes.length;
    const assertPose = (animation: RuntimeAnimation) => {
      expect(runtime.state.logicalPosition).toMatchObject(rest);
      const event = frames.filter(frame => frame.animationId === animation.id).at(-1)!;
      expect(event).toBeDefined();
      expect(animation.frames).toContain(event.frame);
      expect(event.frame.visualAnchor.y).toBe(448);
      expect(rest.y + event.frame.visualAnchor.y * 160 / 512).toBe(344 + 376 / 2);
      expect(rest.y + event.frame.visualAnchor.y * 160 / 512).not.toBe(344 + 343 / 2);
    };
    expect(runtime.state.activeAnimationId).toBe("idle");
    assertPose(resources.idle);
    await advance(clock, HOME_AWAKE_DURATION_MS + 4000);
    expect(runtime.state.activeAnimationId).toBe("sleep");
    assertPose(resources.sleep);
    await advance(clock, 20000);
    assertPose(resources.sleep);
    expect(writes).toHaveLength(begin);
    expect(computeHomeRestPoint(WORK_AREA)).toEqual(windowPosition(rest.x, rest.y));
    runtime.dispose();
  });
  it("真实manifest窝内原地活动固定restPoint，不发walk且保留原始视觉锚", async () => {
    const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(readFileSync(
      new URL("../public/character/manifest.json", import.meta.url), "utf8"))));
    const home = JSON.parse(readFileSync(new URL("../public/character/home/home-manifest.json", import.meta.url), "utf8"));
    const { runtime, clock, writes, frames } = await setup(resources);
    const begin = writes.length;
    const frameBegin = frames.length;
    await advance(clock, 20000);
    expect(writes).toHaveLength(begin);
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(runtime.state.activeAnimationId).toBe("look_mouse");
    expect(runtime.triggerHappy()).toBe(true);
    await advance(clock, 3000);
    const emitted = frames.slice(frameBegin);
    expect(emitted.some(event => event.animationId === "walk")).toBe(false);
    expect(emitted.some(event => event.animationId === "happy")).toBe(false);
    for (const id of ["idle", "blink", "look_mouse", "home_idle"]) {
      expect(emitted.some(event => event.animationId === id)).toBe(true);
    }
    const animations = [resources.idle, resources.blink, resources.lookMouse, resources.homeIdle, resources.land];
    for (const event of emitted) {
      const original = animations.flatMap(animation => animation.frames)
        .find(frame => frame.logicalAssetKey === event.frame.logicalAssetKey)!;
      expect(event.frame).toBe(original);
      expect(event.frame.visualAnchor).toEqual(original.visualAnchor);
    }
    expect(runtime.state.logicalPosition).toMatchObject({ x: 721, y: 392 });
    const positions = [computeHomeRestPoint(WORK_AREA)!, ...writes.slice(begin)];
    for (const point of positions) {
      expect(point).toMatchObject({ x: 721, y: 392 });
      expect(point.y + 140).toBe(344 + home.landingSurface.y / 2);
      for (const animation of animations) {
        for (const frame of animation.frames) {
          if (frame.contactGeometry.kind !== "FOOT_SEGMENT") continue;
          for (const sign of [-1, 1]) for (const edge of [frame.contactGeometry.leftX, frame.contactGeometry.rightX]) {
            const foot = point.x + 80 + sign * (edge - frame.visualAnchor.x) * 160 / 512;
            expect(foot).toBeGreaterThanOrEqual(720 + home.landingSurface.leftX / 2);
            expect(foot).toBeLessThanOrEqual(720 + home.landingSurface.rightX / 2);
          }
        }
      }
    }
    runtime.dispose();
  });
});

describe("Home cycle helpers", () => {
  it("候选支撑线锁定376且Home JSON与TS一致，素材身份保持不变", () => {
    const home = JSON.parse(readFileSync(new URL("../public/character/home/home-manifest.json", import.meta.url), "utf8"));
    expect(HOME_REST_FOOT_ANCHOR_CANVAS_Y).toBe(376);
    expect(HOME_LANDING_SURFACE_CANVAS_Y).toBe(376);
    expect(HOME_REST_FOOT_ANCHOR_CANVAS_X).toBe(162);
    expect(home.restFootAnchor).toEqual({ x: HOME_REST_FOOT_ANCHOR_CANVAS_X, y: HOME_REST_FOOT_ANCHOR_CANVAS_Y });
    expect(home.landingSurface).toEqual({ leftX: 104, rightX: 220, y: HOME_LANDING_SURFACE_CANVAS_Y });
    expect(home.manifestRevision).toBe("ld071-home-contact-candidate-r2");
    expect(home.contentRevision).toBe("ld040-home-v1-content-r1");
    expect(home.assetStatus).toBe("FROZEN");
  });
  it("进出窝包络包含整条弧线及完整窗口体积", () => {
    const entry = computeHomeEntryPoint(WORK_AREA)!;
    const rest = computeHomeRestPoint(WORK_AREA)!;
    for (const [start, target] of [[entry, rest], [rest, entry]]) {
      const bounds = computeHomeJumpBounds(start, target);
      expect(bounds).toEqual({ left: 560, right: 881, top: 352, bottom: 620 });
      for (let i = 0; i <= 100; i++) {
        const point = computeHomeJumpPoint(start, target, i / 100);
        expect(point.x).toBeGreaterThanOrEqual(bounds.left);
        expect(point.y).toBeGreaterThanOrEqual(bounds.top);
        expect(point.x + 160).toBeLessThanOrEqual(bounds.right);
        expect(point.y + 160).toBeLessThanOrEqual(bounds.bottom);
      }
    }
  });
  it("keeps the activity and rest samples at their frozen inclusive bounds", () => {
    expect([0, 0.499, 0.5, 1].map(value => sampleHomeRoundTrips(() => value))).toEqual([3, 3, 4, 4]);
    expect([2, 3, 4, 5, 6].map(sampleHomeRestDurationMsForRevision)).toEqual([30000, 45000, 60000, 75000, 90000]);
    expect(computeHomeWalkRoute(WORK_AREA)).toEqual({ nearX: 512, farX: 332 });
    expect(computeHomeWalkRoute({ ...WORK_AREA, x: -1000 })).toEqual({ nearX: -488, farX: -668 });
    expect(computeHomeWalkRoute({ ...WORK_AREA, width: 500 })).toBeUndefined();
    expect(computeHomeWalkRoute({ ...WORK_AREA, width: 512 })).toEqual({ nearX: 24, farX: 0 });
    expect(sampleHomeRestDurationMsForRevision(2)).toBe(HOME_REST_MIN_MS);
    expect(sampleHomeRestDurationMsForRevision(6)).toBe(HOME_REST_MAX_MS);
    expect(HOME_CYCLE_SPEED_LOGICAL_PX_PER_SECOND).toBe(52);
    expect(HOME_CYCLE_TICK_MS).toBeCloseTo(1000 / 30);
    expect(HOME_FADE_DURATION_MS).toBe(180);
    expect(HOME_WAKE_HOLD_MS).toBe(700);
    // 进出窝跳跃时长。行为测试用常量推进，因此必须在此锁住具体数值，
    // 否则把 900 改回任意值测试仍会通过。
    expect(HOME_JUMP_DURATION_MS).toBe(900);
    expect(HOME_LANDING_SURFACE_LOGICAL_LEFT_X).toBe(52);
    expect(HOME_LANDING_SURFACE_LOGICAL_RIGHT_X).toBe(110);
    expect(HOME_LANDING_SURFACE_LOGICAL_Y).toBe(188);
    expect(HOME_BOTTOM_MARGIN_LOGICAL).toBe(0);
  });

  it("用缓动让进出窝跳跃起步与落垫更柔和（水平不再是线性位移）", () => {
    const start = { x: 560, y: 460 };
    const rest = { x: 721, y: 392 };
    const span = rest.x - start.x;

    // smoothstep(0.25) = 0.15625，明显慢于线性 0.25：起跳阶段先向上再推进。
    expect(computeHomeJumpPoint(start, rest, 0.25).x).toBeCloseTo(
      start.x + span * 0.15625,
      6,
    );
    expect(computeHomeJumpPoint(start, rest, 0.25).x).toBeLessThan(
      start.x + span * 0.25,
    );

    // smoothstep(0.5) = 0.5：中点仍是几何中点，缓动不改变落点。
    expect(computeHomeJumpPoint(start, rest, 0.5).x).toBeCloseTo(640.5, 6);

    // smoothstep(0.75) = 0.84375 > 0.75：末段对称收敛，落垫前不再横向猛冲。
    expect(computeHomeJumpPoint(start, rest, 0.75).x).toBeGreaterThan(
      start.x + span * 0.75,
    );

    // 端点必须精确落在起跳点与 restPoint，缓动不得引入端点漂移。
    expect(computeHomeJumpPoint(start, rest, 0)).toEqual(start);
    expect(computeHomeJumpPoint(start, rest, 1)).toEqual(rest);
  });

  it("keeps Main visible throughout every Home lifecycle phase", () => {
    for (const type of [
      "MAIN_FADE_OUT",
      "MAIN_HIDE",
      "MAIN_SHOW_NO_ACTIVATE",
      "MAIN_FADE_IN",
    ] as const) {
      expect(resolveHomeMainVisibility({ type, revision: 1 })).toEqual({
        opacity: 1,
        visible: true,
      });
    }
  });

  it("keeps Home above the taskbar and aligns Main to its landing surface", () => {
    const surface = computeHomeSurfaceRect(WORK_AREA);
    expect(surface).toEqual({
      x: 720,
      y: 344,
      width: 256,
      height: 256,
    });
    expect((surface?.y ?? 0) + HOME_LANDING_SURFACE_LOGICAL_Y).toBe(532);
    expect((surface?.y ?? 0) + (surface?.height ?? 0)).toBe(600);
    expect(computeHomeEntryPoint(WORK_AREA)).toEqual(
      windowPosition(560, 460),
    );
    expect(computeHomeRestPoint(WORK_AREA)).toEqual(
      windowPosition(721, 392),
    );
    expect(computeHomeLandingSurface(WORK_AREA)).toEqual({
      leftX: 772,
      rightX: 830,
      y: 532,
    });
    // 脚线530→540跨过新532，但已在旧515.5下方；旧343必须失败。
    expect(
      crossesHomeLandingSurface(
        { x: 721, y: 390 },
        { x: 721, y: 400 },
        WORK_AREA,
      ),
    ).toBe(true);
    expect(
      crossesHomeLandingSurface(
        { x: 691.99, y: 390 },
        { x: 691.99, y: 400 },
        WORK_AREA,
      ),
    ).toBe(false);
    expect(
      crossesHomeLandingSurface(
        { x: 750.01, y: 390 },
        { x: 750.01, y: 400 },
        WORK_AREA,
      ),
    ).toBe(false);
    expect(
      crossesHomeLandingSurface(
        { x: 721, y: 400 },
        { x: 721, y: 410 },
        WORK_AREA,
      ),
    ).toBe(false);
    expect(crossesHomeLandingSurface(
      { x: 721, y: 360 }, { x: 721, y: 390 }, WORK_AREA,
    )).toBe(false);
    const midpoint = computeHomeJumpPoint({ x: 560, y: 460 }, { x: 721, y: 392 }, 0.5);
    expect(midpoint.x).toBe(640.5);
    expect(midpoint.y).toBeLessThan((460 + 392) / 2);
    expect(computeHomeSurfaceRect({ ...WORK_AREA, width: Number.NaN })).toBeUndefined();
  });
});

describe("PetRuntime Home lifecycle", () => {
  it("lands a dragged dog on the Home cushion without tunneling through it", async () => {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: async () => motionSnapshot(721, 300),
      writeWindowTopLeft: async (position) => writes.push({ ...position }),
    };
    const stateHistory: PetRuntimeState[] = [];
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => 1,
      homeRandom: () => 0,
      onStateChange: (state) => stateHistory.push({ ...state }),
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    expect(runtime.beginDrag()).toBe(true);
    await runtime.endDrag();
    await flushPromises();
    expect(runtime.state.behavior).toBe("FALL");
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: true, revision: 1 });
    expect(runtime.state.homeRoundTripsCompleted).toBe(0);

    for (let step = 0; step < 100 && runtime.state.behavior === "FALL"; step += 1) {
      clock.advanceBy(20);
      await flushPromises();
    }
    expect(runtime.state).toMatchObject({
      behavior: "LAND",
      activeAnimationId: "home_land",
      logicalPosition: { x: 721, y: 392 },
      homeCyclePhase: "GO_HOME",
    });

    clock.advanceBy(100);
    await flushPromises();
    expect(runtime.state).toMatchObject({
      behavior: "REST",
      activeAnimationId: "idle",
      logicalPosition: { x: 721, y: 392 },
      homeCyclePhase: "REST",
    });
    expect(stateHistory.map((state) => state.behavior)).toEqual(
      expect.arrayContaining(["DRAG", "FALL", "LAND", "REST"]),
    );
    expect(writes.at(-1)).toMatchObject(windowPosition(721, 392));
  });

  it("interrupts mid-sleep with one stable drag frame and no late home or mirror changes", async () => {
    const clock = new ManualClock();
    let position = windowPosition(721, 300);
    const frames: Array<{ animationId: string; frameIndex: number }> = [];
    const resources = {
      ...TEST_RESOURCES,
      drag: { ...TEST_RESOURCES.drag, frames: [makeFrame("drag", false), { ...makeFrame("drag", false), url: "/drag/second.png" }] },
    };
    const runtime = new PetRuntime(resources, {
      clock, random: () => 0,
      motionPort: {
        resync: async () => motionSnapshot(position.x, position.y),
        writeWindowTopLeft: async next => { position = { ...next }; },
      },
      onFrame: event => frames.push({ animationId: event.animationId, frameIndex: event.frameIndex }),
    });
    await runtime.initialize(async () => undefined);
    await flushPromises();
    expect(runtime.beginDrag()).toBe(true);
    await runtime.endDrag();
    const oldCallbacks: Array<() => void> = [];
    for (let step = 0; step < 3000 && runtime.state.activeAnimationId !== "sleep"; step++) {
      if (runtime.state.activeAnimationId === "home_idle") {
        oldCallbacks.push(...clock.pendingCallbacks());
      }
      clock.advanceBy(50);
      await flushPromises();
    }
    expect(oldCallbacks.length).toBeGreaterThan(0);
    oldCallbacks.push(...clock.pendingCallbacks());
    expect(runtime.state.behavior).toBe("REST");
    expect(runtime.state.activeAnimationId).toBe("sleep");
    clock.advanceBy(50);
    expect(runtime.beginPointerGesture()).toBe(true);
    frames.length = 0;
    expect(runtime.promotePointerGestureToDrag()).toBe(true);
    expect(frames).toEqual([{ animationId: "drag", frameIndex: 0 }]);
    const facing = runtime.state.facing;
    frames.length = 0;
    for (const callback of oldCallbacks) callback();
    await flushPromises();
    expect(frames).toEqual([]);
    expect(runtime.state).toMatchObject({ behavior: "DRAG", activeAnimationId: "drag" });
    for (let step = 0; step < 20; step++) {
      runtime.movePointerDrag({ x: step % 2 ? 100 : 200, y: 200 }, "monitor-1", WORK_AREA);
      clock.advanceBy(5_000);
      await flushPromises();
      expect(runtime.state).toMatchObject({ behavior: "DRAG", activeAnimationId: "drag", facing, visualTransition: "NONE" });
      expect(runtime.state.homeCyclePhase).toBeUndefined();
    }
    expect(frames).toEqual([]);
    await runtime.endDrag();
    expect(runtime.state.behavior).toBe("FALL");
    runtime.dispose();
  });

  it("多帧睡眠静止 20 秒且指针更新不重启，到期按原流程离窝", async () => {
    const clock = new ManualClock();
    const frames: TimelineFrameEvent[] = [];
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: async () => motionSnapshot(writes.at(-1)?.x ?? 100, writes.at(-1)?.y ?? 460),
      writeWindowTopLeft: async (position) => writes.push({ ...position }),
    };
    const stateHistory: PetRuntimeState[] = [];
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => 1,
      homeRandom: () => 0,
      onStateChange: (state) => stateHistory.push({ ...state }),
      onFrame: event => frames.push(event),
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    await walkUntilHome(runtime, clock);
    await flushPromises();
    expect(runtime.state).toMatchObject({
      behavior: "GO_HOME",
      homeCyclePhase: "GO_HOME",
      activeAnimationId: "walk",
      logicalPosition: { x: 536, y: 460 },
    });

    clock.advanceBy(100);
    await flushPromises();
    expect(runtime.state.logicalPosition?.x).toBeGreaterThan(536);
    expect(runtime.state.logicalPosition?.x).toBeLessThan(560);
    expect(runtime.state.logicalPosition?.y).toBe(460);

    while (runtime.state.activeAnimationId !== "jump_air") {
      clock.advanceBy(100);
      await flushPromises();
    }
    expect(runtime.state.logicalPosition).toMatchObject({ x: 560, y: 460 });

    clock.advanceBy(HOME_JUMP_DURATION_MS / 2);
    await flushPromises();
    const jumpMidpoint = runtime.state.logicalPosition;
    expect(jumpMidpoint?.x).toBeGreaterThan(560);
    expect(jumpMidpoint?.x).toBeLessThan(721);
    const linearY = 460 + (392 - 460) * (((jumpMidpoint?.x ?? 560) - 560) / 161);
    expect(jumpMidpoint?.y).toBeLessThan(linearY);

    clock.advanceBy(HOME_JUMP_DURATION_MS / 2);
    await flushPromises();
    const contactAt = clock.now();
    expect(runtime.state).toMatchObject({
      activeAnimationId: "home_land",
      logicalPosition: { x: 721, y: 392 },
      homeRestDeadlineMs: undefined,
    });

    clock.advanceBy(100);
    await flushPromises();
    expect(runtime.state).toMatchObject({
      behavior: "REST",
      homeCyclePhase: "REST",
      activeAnimationId: "idle",
      homeAwakeStartedAtMs: contactAt + 100,
    });
    clock.advanceBy(HOME_AWAKE_DURATION_MS);
    await flushPromises();
    expect(runtime.state.activeAnimationId).toBe("home_idle");
    clock.advanceBy(100);
    await flushPromises();
    expect(runtime.state.activeAnimationId).toBe("sleep");
    const sleepAt = clock.now();
    const sleepEvent = {
      animationId: "sleep",
      frameIndex: 0,
      frame: TEST_RESOURCES.sleep.frames[0],
      animationHitBox: TEST_RESOURCES.sleep.hitBox,
      timestampMs: clock.now(),
    };
    expect(frames.filter(event => event.animationId === "sleep")).toEqual([sleepEvent]);
    const framesAtSleep = frames.length;
    const timersAtSleep = clock.scheduledCount;
    for (let step = 0; step < 200; step++) {
      runtime.handlePointerSample(step % 2
        ? { x: 0, y: 0 }
        : { x: 801, y: 475.5 });
      clock.advanceBy(100);
      await flushPromises();
      expect(runtime.state).toMatchObject({
        behavior: "REST",
        activeAnimationId: "sleep",
        homeCyclePhase: "REST",
        homeRestDeadlineMs: sleepAt + HOME_REST_MIN_MS,
      });
    }
    expect(frames).toHaveLength(framesAtSleep);
    expect(frames.filter(event => event.animationId === "sleep")).toEqual([sleepEvent]);
    expect(clock.scheduledCount).toBe(timersAtSleep);

    clock.advanceBy(sleepAt + HOME_REST_MIN_MS - clock.now());
    await flushPromises();
    expect(runtime.state).toMatchObject({
      behavior: "REST",
      homeCyclePhase: "REST",
      activeAnimationId: "home_idle",
      logicalPosition: { x: 721, y: 392 },
    });
    clock.advanceBy(HOME_WAKE_HOLD_MS - 1);
    await flushPromises();
    expect(runtime.state.behavior).toBe("REST");
    expect(runtime.state.activeAnimationId).toBe("home_idle");
    clock.advanceBy(1);
    await flushPromises();
    expect(runtime.state).toMatchObject({
      behavior: "LEAVE_HOME",
      homeCyclePhase: "FADE_IN",
      logicalPosition: { x: 721, y: 392 },
    });
    expect(runtime.state.activeAnimationId).toBe("jump_air");
    expect(runtime.state.facing).toBe("Left");
    clock.advanceBy(HOME_JUMP_DURATION_MS / 2);
    await flushPromises();
    const leaveMidpoint = runtime.state.logicalPosition;
    expect(leaveMidpoint?.x).toBeGreaterThan(560);
    expect(leaveMidpoint?.x).toBeLessThan(721);
    expect(leaveMidpoint).toEqual(computeHomeJumpPoint(
      { x: 721, y: 392 }, { x: 560, y: 460 }, 0.5,
    ));

    clock.advanceBy(HOME_JUMP_DURATION_MS / 2 - 1);
    await flushPromises();
    expect(runtime.state.behavior).toBe("LEAVE_HOME");
    expect(runtime.state.logicalPosition).toEqual(computeHomeJumpPoint(
      { x: 721, y: 392 }, { x: 560, y: 460 },
      (HOME_JUMP_DURATION_MS - 1) / HOME_JUMP_DURATION_MS,
    ));
    expect(runtime.state.logicalPosition!.y).toBeCloseTo(460, 0);
    clock.advanceBy(HOME_CYCLE_TICK_MS);
    await flushPromises();
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      homeCyclePhase: undefined,
      homeRoundTripsCompleted: 0,
      homeRoundTripsTarget: 3,
      logicalPosition: { x: 560, y: 460 },
    });
    expect(stateHistory.map((state) => state.behavior)).toEqual(
      expect.arrayContaining(["GO_HOME", "REST", "LEAVE_HOME", "IDLE"]),
    );
    expect(writes.at(-1)).toMatchObject(windowPosition(560, 460));
    for (let step = 0; step < 1000 && runtime.state.behavior !== "WALK"; step++) {
      clock.advanceBy(50); await flushPromises();
    }
    expect(runtime.state.behavior).toBe("WALK");
    expect(runtime.state.logicalPosition?.y).toBe(460);
    expect(runtime.state.homeCyclePhase).toBeUndefined();
    expect(runtime.state.homeRoundTripsCompleted).toBe(0);
    expect(runtime.state.facing).toBe("Left");
    runtime.dispose();
  });

  it("invalidates the old GO_HOME route tick when public drag interaction interrupts the route", async () => {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: async () => motionSnapshot(writes.at(-1)?.x ?? 100, writes.at(-1)?.y ?? 460),
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const stateHistory: PetRuntimeState[] = [];
    const lifecycle: string[] = [];
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => 1,
      homeRandom: () => 0,
      onStateChange: (state) => stateHistory.push({ ...state }),
      onHomeLifecycle: (event) => lifecycle.push(event.type),
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    await walkUntilHome(runtime, clock);
    await flushPromises();
    expect(runtime.state.homeCyclePhase).toBe("GO_HOME");
    clock.advanceBy(500);
    await flushPromises();
    expect(runtime.state.homeCyclePhase).toBe("GO_HOME");

    expect(runtime.beginDrag()).toBe(true);
    await flushPromises();
    expect(runtime.state).toMatchObject({
      behavior: "DRAG",
      interaction: "DRAG",
      isDragging: true,
    });
    const statesAfterDrag = stateHistory.length;
    const writesAfterDrag = writes.length;
    const lifecycleAfterDrag = lifecycle.length;

    clock.advanceBy(120_000);
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "DRAG",
      interaction: "DRAG",
      isDragging: true,
    });
    expect(stateHistory).toHaveLength(statesAfterDrag);
    expect(writes).toHaveLength(writesAfterDrag);
    expect(lifecycle).toHaveLength(lifecycleAfterDrag);
    expect(lifecycle).not.toContain("MAIN_HIDE");
    expect(lifecycle).not.toContain("MAIN_SHOW_NO_ACTIVATE");
  });

  it("invalidates jump ticks and timeline completion when public drag cancels Home", async () => {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: async () => motionSnapshot(writes.at(-1)?.x ?? 100, writes.at(-1)?.y ?? 460),
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const stateHistory: PetRuntimeState[] = [];
    const lifecycle: Array<{ type: string; durationMs?: number }> = [];
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => 1,
      homeRandom: () => 0,
      onStateChange: (state) => stateHistory.push({ ...state }),
      onHomeLifecycle: (event) =>
        lifecycle.push({ type: event.type, durationMs: event.durationMs }),
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    await walkUntilHome(runtime, clock);
    await flushPromises();

    while (runtime.state.activeAnimationId !== "jump_air") {
      clock.advanceBy(100);
      await flushPromises();
    }
    clock.advanceBy(200);
    await flushPromises();
    expect(runtime.state.activeAnimationId).toBe("jump_air");
    expect(runtime.state.logicalPosition?.x).toBeGreaterThan(560);
    expect(lifecycle).toEqual([]);

    const statesBeforeDrag = stateHistory.length;
    const writesBeforeDrag = writes.length;
    const lifecycleBeforeDrag = lifecycle.length;
    expect(runtime.beginDrag()).toBe(true);
    await flushPromises();
    expect(runtime.state).toMatchObject({
      behavior: "DRAG",
      interaction: "DRAG",
      isDragging: true,
      homeCyclePhase: undefined,
    });
    expect(stateHistory.length).toBeGreaterThan(statesBeforeDrag);
    expect(writes.length).toBeGreaterThanOrEqual(writesBeforeDrag);
    expect(lifecycle.length).toBe(lifecycleBeforeDrag);

    const statesAfterDrag = stateHistory.length;
    const writesAfterDrag = writes.length;
    const lifecycleAfterDrag = lifecycle.length;
    clock.advanceBy(HOME_REST_MAX_MS + 1_000);
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "DRAG",
      interaction: "DRAG",
      isDragging: true,
      homeCyclePhase: undefined,
    });
    expect(stateHistory).toHaveLength(statesAfterDrag);
    expect(
      stateHistory
        .slice(statesBeforeDrag)
        .some((state) => state.behavior === "REST" || state.behavior === "LEAVE_HOME"),
    ).toBe(false);
    expect(writes).toHaveLength(writesAfterDrag);
    expect(lifecycle).toHaveLength(lifecycleAfterDrag);
    expect(lifecycle.map((event) => event.type)).not.toContain("MAIN_HIDE");
    expect(lifecycle.map((event) => event.type)).not.toContain("MAIN_SHOW_NO_ACTIVATE");
    expect(lifecycle.map((event) => event.type)).not.toContain("MAIN_FADE_IN");
  });
});
