import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { TimelineClock } from "../src/animation-timeline";
import { DIRECT_INTERACTION_STOP_MAX_MS } from "../src/pet-behavior-core";
import { HOME_AWAKE_DURATION_MS, HOME_INTERACTION_QUIET_MS } from "../src/home-cycle";
import {
  MotionCoordinator,
  type MotionCommand,
} from "../src/motion-coordinator";
import type {
  DefaultRuntimeResources,
  RuntimeAnimation,
  RuntimeFrame,
} from "../src/pet-manifest";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import {
  PetRuntime,
  type PetRuntimeState,
} from "../src/pet-runtime";
import type {
  LogicalPoint,
  LogicalWorkArea,
  MotionSnapshot,
  PetMotionPort,
  WindowTopLeftLogical,
} from "../src/native-motion";

const WORK_AREA: LogicalWorkArea = {
  x: 0,
  y: 0,
  width: 800,
  height: 600,
};

function windowPosition(x: number, y: number): WindowTopLeftLogical {
  return {
    space: "WINDOW_TOP_LEFT_LOGICAL",
    x,
    y,
  };
}

function motionSnapshot(
  x = 100,
  y = 100,
  workArea = WORK_AREA,
): MotionSnapshot {
  return {
    currentMonitorId: "monitor-1",
    windowScaleFactor: 1,
    homeWindow: { ready: true, currentMonitorId: "monitor-1", windowScaleFactor: 1,
      rect: { x: workArea.x + workArea.width - 280, y: workArea.y + workArea.height - 256, width: 256, height: 256 } },
    workArea,
    windowPosition: windowPosition(x, y),
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  clearedCount = 0;

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
    if (typeof handle === "number" && this.timers.delete(handle)) {
      this.clearedCount += 1;
    }
  }

  advanceBy(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError("ManualClock only accepts finite non-negative deltas.");
    }

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
  frameIndex: number,
  durationMs: number,
  groundContact: boolean,
): RuntimeFrame {
  const logicalAssetKey = `${animationId}/${frameIndex}.png`;
  return {
    logicalAssetKey,
    src: logicalAssetKey,
    url: `/character/${logicalAssetKey}`,
    durationMs,
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
  durationsMs: readonly number[],
  playback: "LOOP" | "ONCE",
  nextState: string,
  groundContact: boolean,
): RuntimeAnimation {
  return {
    id,
    animationId: id,
    revision: "test-runtime",
    status: "FROZEN",
    sourceView: "front",
    loop: playback === "LOOP",
    interruptPolicy: "interruptible_by_user_interaction",
    nextState,
    frameDurationMs: durationsMs[0] ?? 1,
    playback,
    reversePlaybackAllowed: false,
    frameDurationsMs: [...durationsMs],
    frames: durationsMs.map((durationMs, frameIndex) =>
      makeFrame(id, frameIndex, durationMs, groundContact),
    ),
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
  idle: makeAnimation("idle", [100], "LOOP", "IDLE", true),
  blink: makeAnimation("blink", [100], "ONCE", "IDLE", true),
  walk: makeAnimation("walk", [100], "LOOP", "WALK", true),
  lookMouse: makeAnimation("look_mouse", [100], "ONCE", "LOOK", true),
  happy: makeAnimation("happy", [100], "ONCE", "IDLE", true),
  drag: makeAnimation("drag", [220, 220], "LOOP", "DRAG", true),
  fall: makeAnimation("fall", [140, 140], "LOOP", "FALL", false),
  land: makeAnimation("land", [90, 80, 80], "ONCE", "IDLE", true),
  turn: makeAnimation("turn", [60, 80, 100, 80, 60], "ONCE", "WALK", true),
  jumpAir: makeAnimation("jump_air", [160, 170, 170, 150], "ONCE", "HOME_LAND", false),
  homeLand: makeAnimation("home_land", [120, 140, 160, 240], "ONCE", "HOME_IDLE", true),
  homeIdle: makeAnimation("home_idle", [320, 400, 520, 760], "ONCE", "SLEEP", true),
  sleep: makeAnimation("sleep", [1050, 950, 1050, 1150], "LOOP", "SLEEP", true),
};

function createImmediateMotionPort(snapshot = motionSnapshot()): {
  port: PetMotionPort;
  writes: WindowTopLeftLogical[];
  getResyncCount: () => number;
  getDisposeCount: () => number;
} {
  const writes: WindowTopLeftLogical[] = [];
  let resyncCount = 0;
  let disposeCount = 0;

  const port: PetMotionPort = {
    resync: async () => {
      resyncCount += 1;
      return snapshot;
    },
    writeWindowTopLeft: async (position) => {
      writes.push({ ...position });
    },
    dispose: () => {
      disposeCount += 1;
    },
  };

  return {
    port,
    writes,
    getResyncCount: () => resyncCount,
    getDisposeCount: () => disposeCount,
  };
}

describe("MotionCoordinator", () => {
  it("serializes one in-flight write and drops stale queued or lease requests", async () => {
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    const calls: MotionCommand[] = [];
    const coordinator = new MotionCoordinator((command) => {
      calls.push(command);
      return calls.length === 1 ? firstWrite.promise : secondWrite.promise;
    });

    const autonomousLease = coordinator.invalidateAndAcquire(
      "AUTONOMOUS",
      windowPosition(100, 100),
    );
    coordinator.request(autonomousLease, windowPosition(110, 100));

    const dragLease = coordinator.invalidateAndAcquire(
      "DRAG",
      windowPosition(200, 100),
    );
    coordinator.request(autonomousLease, windowPosition(120, 100));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      owner: "AUTONOMOUS",
      windowTopLeft: windowPosition(100, 100),
    });

    firstWrite.resolve();
    await flushPromises();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      owner: "DRAG",
      windowTopLeft: windowPosition(200, 100),
    });
    expect(calls.map((command) => command.windowTopLeft.x)).not.toContain(110);
    expect(calls.map((command) => command.windowTopLeft.x)).not.toContain(120);

    coordinator.request(dragLease, windowPosition(240, 100));
    secondWrite.resolve();
    await flushPromises();

    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({
      owner: "DRAG",
      windowTopLeft: windowPosition(240, 100),
    });
  });

  it("does not let a stale late failure take control after a newer lease", async () => {
    const firstWrite = deferred<void>();
    const secondWrite = deferred<void>();
    const calls: MotionCommand[] = [];
    const rejections: Array<{
      command: MotionCommand;
      isCurrentEpoch: boolean;
      isStaleEpoch: boolean;
    }> = [];
    const coordinator = new MotionCoordinator(
      (command) => {
        calls.push(command);
        return calls.length === 1 ? firstWrite.promise : secondWrite.promise;
      },
      (rejection) => {
        rejections.push({
          command: rejection.command,
          isCurrentEpoch: rejection.isCurrentEpoch,
          isStaleEpoch: rejection.isStaleEpoch,
        });
      },
    );

    coordinator.invalidateAndAcquire("AUTONOMOUS", windowPosition(100, 100));
    coordinator.invalidateAndAcquire("FALL", windowPosition(300, 420));

    firstWrite.reject(new Error("stale native write"));
    await flushPromises();

    expect(calls).toHaveLength(2);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      isCurrentEpoch: false,
      isStaleEpoch: true,
    });
    expect(rejections[0]?.command.owner).toBe("AUTONOMOUS");

    secondWrite.resolve();
    await flushPromises();

    expect(calls.at(-1)).toMatchObject({
      owner: "FALL",
      windowTopLeft: windowPosition(300, 420),
    });
  });

  it("stops dispatching after dispose and keeps dispose idempotent", async () => {
    const firstWrite = deferred<void>();
    const calls: MotionCommand[] = [];
    const coordinator = new MotionCoordinator((command) => {
      calls.push(command);
      return firstWrite.promise;
    });
    const lease = coordinator.invalidateAndAcquire(
      "AUTONOMOUS",
      windowPosition(100, 100),
    );
    coordinator.request(lease, windowPosition(140, 100));

    coordinator.dispose();
    coordinator.dispose();
    firstWrite.resolve();
    await flushPromises();

    coordinator.request(lease, windowPosition(180, 100));

    expect(calls).toHaveLength(1);
    expect(() =>
      coordinator.invalidateAndAcquire("RECOVERY", windowPosition(0, 0)),
    ).toThrowError("MotionCoordinator has been disposed.");
  });
});

describe("PetRuntime motion and lifecycle", () => {
  it("holds a stable idle frame until a real behavior transition occurs", async () => {
    const clock = new ManualClock();
    const resources: DefaultRuntimeResources = {
      ...TEST_RESOURCES,
      idle: makeAnimation("idle", [100, 100, 100, 100], "LOOP", "IDLE", true),
    };
    const frames: Array<{ animationId: string; frameIndex: number }> = [];
    const runtime = new PetRuntime(resources, {
      clock,
      motionPort: createImmediateMotionPort().port,
      random: () => 0,
      onFrame: (event) => {
        frames.push({ animationId: event.animationId, frameIndex: event.frameIndex });
      },
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    expect(frames).toEqual([{ animationId: "idle", frameIndex: 0 }]);

    clock.advanceBy(2_999);
    await flushPromises();
    expect(frames.filter((frame) => frame.animationId === "idle")).toEqual([
      { animationId: "idle", frameIndex: 0 },
    ]);
    expect(frames.every((frame) => frame.animationId === "idle" || frame.animationId === "blink")).toBe(true);

    runtime.dispose();
  });

  it("keeps drag authority over a stale WALK-preparation result and settles FALL to LAND then IDLE", async () => {
    const clock = new ManualClock();
    const walkResync = deferred<MotionSnapshot | null>();
    const releaseResync = deferred<MotionSnapshot | null>();
    let resyncCount = 0;
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: () => {
        resyncCount += 1;
        if (resyncCount === 1) {
          return Promise.resolve(motionSnapshot());
        }
        if (resyncCount === 2) {
          return walkResync.promise;
        }
        return releaseResync.promise;
      },
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const stateHistory: PetRuntimeState[] = [];
    const frameHistory: string[] = [];
    const randomValues = [1, 0, 0.9, 0, 0, 0.9];
    let randomIndex = 0;
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => randomValues[randomIndex++] ?? 0.9,
      onStateChange: (state) => stateHistory.push({ ...state }),
      onFrame: (event) => frameHistory.push(event.animationId),
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    expect(runtime.state.behavior).toBe("IDLE");

    clock.advanceBy(3_000);
    await flushPromises();
    expect(resyncCount).toBe(2);
    expect(runtime.state.behavior).toBe("IDLE");

    expect(runtime.beginDrag()).toBe(true);
    expect(runtime.state).toMatchObject({
      behavior: "DRAG",
      interaction: "DRAG",
      isDragging: true,
      motionOwner: "DRAG",
    });
    const firstStateAfterDrag = stateHistory.length;

    walkResync.resolve(motionSnapshot(120, 100));
    await flushPromises();
    expect(runtime.state.behavior).toBe("DRAG");
    expect(runtime.state.interaction).toBe("DRAG");
    expect(runtime.state.logicalPosition).toMatchObject({ x: 100, y: 100 });
    expect(
      stateHistory
        .slice(firstStateAfterDrag)
        .some((state) => state.behavior === "WALK"),
    ).toBe(false);

    expect(
      runtime.movePointerDrag({ x: 200, y: 100 }, "monitor-1", WORK_AREA),
    ).toBe(true);
    const endDragPromise = runtime.endDrag();
    expect(resyncCount).toBe(3);
    releaseResync.resolve(motionSnapshot(200, 100));
    await endDragPromise;
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "FALL",
      interaction: "NONE",
      isDragging: false,
      motionOwner: "FALL",
    });

    clock.advanceBy(500);
    await flushPromises();
    expect(runtime.state.behavior).toBe("FALL");
    expect(runtime.state.verticalVelocityLogicalPxPerSecond).toBeGreaterThan(0);

    for (let step = 0; step < 100 && runtime.state.behavior === "FALL"; step += 1) {
      clock.advanceBy(20);
      await flushPromises();
    }
    expect(runtime.state.behavior).toBe("LAND");

    for (let step = 0; step < 100 && runtime.state.behavior !== "IDLE"; step += 1) {
      clock.advanceBy(20);
      await flushPromises();
    }
    expect(runtime.state.behavior).toBe("IDLE");
    expect(stateHistory.map((state) => state.behavior)).toEqual(
      expect.arrayContaining(["DRAG", "FALL", "LAND", "IDLE"]),
    );
    expect(frameHistory).toEqual(
      expect.arrayContaining(["drag", "fall", "land", "idle"]),
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.at(-1)).toMatchObject(windowPosition(200, 460));
  });

  it("interrupts an active WALK after motion output and keeps old WALK callbacks from regaining authority", async () => {
    const clock = new ManualClock();
    const releaseSnapshot = motionSnapshot(240, 100);
    let resyncCount = 0;
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: () => {
        resyncCount += 1;
        return Promise.resolve(
          resyncCount === 2 ? motionSnapshot() : releaseSnapshot,
        );
      },
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const stateHistory: PetRuntimeState[] = [];
    const frameHistory: string[] = [];
    const randomValues = [1, 0, 0.9, 0, 0, 0.9];
    let randomIndex = 0;
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => randomValues[randomIndex++] ?? 0.9,
      onStateChange: (state) => stateHistory.push({ ...state }),
      onFrame: (event) => frameHistory.push(event.animationId),
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    clock.advanceBy(3_000);
    await flushPromises();

    expect(resyncCount).toBe(2);
    expect(runtime.state.behavior).toBe("WALK");
    const walkStartPosition = runtime.state.logicalPosition;
    expect(walkStartPosition).toMatchObject({ x: 100, y: 460 });

    const writesBeforeWalkMotion = writes.length;
    clock.advanceBy(100);
    await flushPromises();
    expect(runtime.state.behavior).toBe("WALK");
    expect(runtime.state.logicalPosition?.x).toBeGreaterThan(
      walkStartPosition?.x ?? Number.POSITIVE_INFINITY,
    );
    expect(
      writes
        .slice(writesBeforeWalkMotion)
        .some((position) => position.x > (walkStartPosition?.x ?? 100)),
    ).toBe(true);

    expect(runtime.beginDrag()).toBe(true);
    expect(runtime.state).toMatchObject({
      behavior: "DRAG",
      interaction: "DRAG",
      isDragging: true,
      motionOwner: "DRAG",
    });
    expect(
      runtime.movePointerDrag({ x: 240, y: 100 }, "monitor-1", WORK_AREA),
    ).toBe(true);
    await flushPromises();

    const stateChangesAfterDrag = stateHistory.length;
    const writesAfterDrag = writes.length;
    const framesAfterDrag = frameHistory.length;
    clock.advanceBy(5_000);
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "DRAG",
      interaction: "DRAG",
      isDragging: true,
      logicalPosition: { x: 240, y: 100 },
      motionOwner: "DRAG",
    });
    expect(stateHistory).toHaveLength(stateChangesAfterDrag);
    expect(writes).toHaveLength(writesAfterDrag);
    expect(frameHistory.slice(framesAfterDrag)).not.toContain("walk");

    const endDragPromise = runtime.endDrag();
    await endDragPromise;
    await flushPromises();
    expect(runtime.state).toMatchObject({
      behavior: "FALL",
      interaction: "NONE",
      isDragging: false,
      logicalPosition: { x: 240, y: 100 },
      motionOwner: "FALL",
    });

    clock.advanceBy(500);
    await flushPromises();
    expect(runtime.state.behavior).toBe("FALL");
    for (let step = 0; step < 100 && runtime.state.behavior === "FALL"; step += 1) {
      clock.advanceBy(20);
      await flushPromises();
    }
    expect(runtime.state.behavior).toBe("LAND");
    for (let step = 0; step < 100 && runtime.state.behavior !== "IDLE"; step += 1) {
      clock.advanceBy(20);
      await flushPromises();
    }
    expect(runtime.state.behavior).toBe("IDLE");

    const behaviorHistory = stateHistory.map((state) => state.behavior);
    const dragIndex = behaviorHistory.indexOf("DRAG");
    const fallIndex = behaviorHistory.findIndex(
      (behavior, index) => index > dragIndex && behavior === "FALL",
    );
    const landIndex = behaviorHistory.findIndex(
      (behavior, index) => index > fallIndex && behavior === "LAND",
    );
    const idleIndex = behaviorHistory.findIndex(
      (behavior, index) => index > landIndex && behavior === "IDLE",
    );
    expect(dragIndex).toBeGreaterThanOrEqual(0);
    expect(fallIndex).toBeGreaterThan(dragIndex);
    expect(landIndex).toBeGreaterThan(fallIndex);
    expect(idleIndex).toBeGreaterThan(landIndex);
    expect(frameHistory).toEqual(
      expect.arrayContaining(["walk", "drag", "fall", "land", "idle"]),
    );
    expect(writes.at(-1)).toMatchObject(windowPosition(240, 460));
  });

  it("does not resurrect initialization after dispose during preload", async () => {
    const clock = new ManualClock();
    const imageGate = deferred<void>();
    const motion = createImmediateMotionPort();
    const stateChanges: PetRuntimeState[] = [];
    const frames: string[] = [];
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: motion.port,
      onStateChange: (state) => stateChanges.push({ ...state }),
      onFrame: (event) => frames.push(event.animationId),
    });

    const initializePromise = runtime.initialize(async () => imageGate.promise);
    runtime.dispose();
    imageGate.resolve();

    await expect(initializePromise).resolves.toBeUndefined();
    await flushPromises();

    expect(motion.getResyncCount()).toBe(0);
    expect(motion.writes).toHaveLength(0);
    expect(stateChanges).toHaveLength(0);
    expect(frames).toHaveLength(0);
    expect(clock.scheduledCount).toBe(0);
    expect(motion.getDisposeCount()).toBe(1);
  });

  it("does not resurrect after dispose while the initialization resync is pending", async () => {
    const clock = new ManualClock();
    const resyncGate = deferred<MotionSnapshot | null>();
    let resyncCount = 0;
    let disposeCount = 0;
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: () => {
        resyncCount += 1;
        return resyncGate.promise;
      },
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
      dispose: () => {
        disposeCount += 1;
      },
    };
    const stateChanges: PetRuntimeState[] = [];
    const frames: string[] = [];
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      onStateChange: (state) => stateChanges.push({ ...state }),
      onFrame: (event) => frames.push(event.animationId),
    });

    const initializePromise = runtime.initialize(async () => undefined);
    for (let attempt = 0; attempt < 5 && resyncCount === 0; attempt += 1) {
      await flushPromises();
    }
    expect(resyncCount).toBe(1);

    const stateChangesBeforeDispose = stateChanges.length;
    const framesBeforeDispose = frames.length;
    const scheduledBeforeDispose = clock.scheduledCount;
    runtime.dispose();
    runtime.dispose();

    resyncGate.resolve(motionSnapshot());
    await expect(initializePromise).resolves.toBeUndefined();
    await flushPromises();

    expect(stateChanges).toHaveLength(stateChangesBeforeDispose);
    expect(frames).toHaveLength(framesBeforeDispose);
    expect(clock.scheduledCount).toBe(scheduledBeforeDispose);
    expect(writes).toHaveLength(0);
    expect(disposeCount).toBe(1);
  });

  it("does not resurrect a drag-end pending resync after dispose, whether it resolves or rejects late", async () => {
    for (const lateOutcome of ["resolve", "reject"] as const) {
      const clock = new ManualClock();
      const releaseGate = deferred<MotionSnapshot | null>();
      let resyncCount = 0;
      let disposeCount = 0;
      const writes: WindowTopLeftLogical[] = [];
      const port: PetMotionPort = {
        resync: () => {
          resyncCount += 1;
          if (resyncCount === 1) {
            return Promise.resolve(motionSnapshot());
          }
          return releaseGate.promise;
        },
        writeWindowTopLeft: async (position) => {
          writes.push({ ...position });
        },
        dispose: () => {
          disposeCount += 1;
        },
      };
      const stateChanges: PetRuntimeState[] = [];
      const frames: string[] = [];
      const runtime = new PetRuntime(TEST_RESOURCES, {
        clock,
        motionPort: port,
        onStateChange: (state) => stateChanges.push({ ...state }),
        onFrame: (event) => frames.push(event.animationId),
      });

      await runtime.initialize(async () => undefined);
      await flushPromises();
      expect(runtime.beginDrag()).toBe(true);
      await flushPromises();

      const endDragPromise = runtime.endDrag();
      expect(resyncCount).toBe(2);
      await flushPromises();

      const stateChangesBeforeDispose = stateChanges.length;
      const framesBeforeDispose = frames.length;
      const scheduledBeforeDispose = clock.scheduledCount;
      const writesBeforeDispose = writes.length;
      runtime.dispose();

      if (lateOutcome === "resolve") {
        releaseGate.resolve(motionSnapshot(240, 100));
        await expect(endDragPromise).resolves.toBeUndefined();
      } else {
        releaseGate.reject(new Error("late drag-end resync failure"));
        await expect(endDragPromise).rejects.toThrow(
          "late drag-end resync failure",
        );
      }
      clock.advanceBy(10_000);
      await flushPromises();

      expect(stateChanges).toHaveLength(stateChangesBeforeDispose);
      expect(frames).toHaveLength(framesBeforeDispose);
      expect(clock.scheduledCount).toBe(scheduledBeforeDispose);
      expect(writes).toHaveLength(writesBeforeDispose);
      expect(disposeCount).toBe(1);
    }
  });

  it("rejects all public activity after dispose without new frames, timers, or motion writes", async () => {
    const clock = new ManualClock();
    const motion = createImmediateMotionPort();
    const stateChanges: PetRuntimeState[] = [];
    const frames: string[] = [];
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: motion.port,
      onStateChange: (state) => stateChanges.push({ ...state }),
      onFrame: (event) => frames.push(event.animationId),
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    runtime.dispose();

    const stateAfterDispose = runtime.state;
    const stateChangesAfterDispose = stateChanges.length;
    const framesAfterDispose = frames.length;
    const scheduledAfterDispose = clock.scheduledCount;
    const writesAfterDispose = motion.writes.length;
    const resyncAfterDispose = motion.getResyncCount();

    expect(runtime.triggerBlink()).toBe(false);
    expect(runtime.handleUserInteraction()).toBe(false);
    expect(runtime.beginPointerGesture()).toBe(false);
    expect(runtime.promotePointerGestureToDrag()).toBe(false);
    expect(runtime.movePointerDrag({ x: 200, y: 100 }, "monitor-1", WORK_AREA)).toBe(
      false,
    );
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(runtime.triggerHappy()).toBe(false);
    await runtime.endDrag();
    clock.advanceBy(10_000);
    await flushPromises();

    expect(runtime.state).toEqual(stateAfterDispose);
    expect(stateChanges).toHaveLength(stateChangesAfterDispose);
    expect(frames).toHaveLength(framesAfterDispose);
    expect(clock.scheduledCount).toBe(scheduledAfterDispose);
    expect(motion.writes).toHaveLength(writesAfterDispose);
    expect(motion.getResyncCount()).toBe(resyncAfterDispose);
    expect(motion.getDisposeCount()).toBe(1);
  });
});

/**
 * Frozen baseline contention order: DRAG > HAPPY > LOOK > WALK/IDLE.
 * Runtime enforces this imperatively in `triggerHappy()`/`startLook()`, so
 * these tests assert the observable order rather than the priority table.
 */
describe("往返异步写入确认", () => {
  it.each(["resolve", "reject", "stale"] as const)("返回近端的 %s 不提前结算", async outcome => {
    const clock = new ManualClock();
    let position = windowPosition(312, 460);
    let reachedFar = false;
    let blocked = false;
    const gate = deferred<void>();
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock, random: () => 1, homeRandom: () => 0,
      motionPort: {
        resync: async () => motionSnapshot(position.x, position.y),
        writeWindowTopLeft: async next => {
          if (next.x === 132) reachedFar = true;
          if (reachedFar && next.x === 312 && !blocked) {
            blocked = true;
            await gate.promise;
          }
          position = { ...next };
        },
      },
    });
    await runtime.initialize(async () => undefined);
    for (let step = 0; step < 20000 && !blocked; step++) {
      clock.advanceBy(50); await flushPromises();
    }
    expect(blocked).toBe(true);
    expect(runtime.state.homeRoundTripsCompleted).toBe(0);
    expect(runtime.state.homeWalkTargetX).toBe(312);
    expect(position.x).toBeLessThan(312);
    clock.advanceBy(10000); await flushPromises();
    expect(runtime.state.homeRoundTripsCompleted).toBe(0);
    if (outcome === "stale") expect(runtime.beginDrag()).toBe(true);
    if (outcome === "reject") gate.reject(new Error("拒绝端点写入"));
    else gate.resolve();
    for (let i = 0; i < 6; i++) await flushPromises();
    expect(runtime.state.homeRoundTripsCompleted).toBe(outcome === "resolve" ? 1 : 0);
    expect(runtime.state.homeCyclePhase).toBeUndefined();
    if (outcome === "stale") expect(runtime.state.motionOwner).toBe("DRAG");
    if (outcome === "reject") expect(runtime.state.motionOwner).toBe("RECOVERY");
    runtime.dispose();
  });
});

describe("PetRuntime product-state contention order", () => {
  async function createReadyRuntime(random: () => number = Math.random) {
    const clock = new ManualClock();
    const motion = createImmediateMotionPort();
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: motion.port,
      random,
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    return { runtime, clock, motion };
  }

  it("keeps the idle chain alive after a failed native motion write", async () => {
    const clock = new ManualClock();
    let rejectWrites = false;
    const port: PetMotionPort = {
      resync: async () => motionSnapshot(),
      writeWindowTopLeft: async () => {
        if (rejectWrites) {
          throw new Error("native write failed");
        }
      },
      dispose: () => undefined,
    };
    // 0.9 is above IDLE_OR_PAUSE_WEIGHT, so autonomous sampling picks WALK.
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => 0.9,
    });
    await runtime.initialize(async () => undefined);
    await flushPromises();

    // Fail every native write starting now, so the autonomous walk cannot move.
    rejectWrites = true;
    clock.advanceBy(60_000);
    await flushPromises();

    expect(runtime.state.behavior).toBe("IDLE");
    expect(runtime.state.motionOwner).toBe("RECOVERY");

    // Regression guard: recovery used to clear every timer and never
    // reschedule, so the pet stayed frozen at IDLE until the next user
    // interaction. A live timer must be able to drive it again.
    rejectWrites = false;
    clock.advanceBy(60_000);
    await flushPromises();
    expect(runtime.state.behavior).toBe("WALK");
  });

  it("does not re-broadcast state when a repeated pointer sample changes nothing", async () => {
    const clock = new ManualClock();
    const motion = createImmediateMotionPort();
    let broadcasts = 0;
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: motion.port,
      random: () => 0.9,
      onStateChange: () => {
        broadcasts += 1;
      },
    });
    await runtime.initialize(async () => undefined);
    await flushPromises();

    const settled = broadcasts;
    // Inside the look enter radius, so this sample really changes the state.
    runtime.handlePointerSample({ x: 80, y: 80 });
    const afterFirst = broadcasts;
    expect(afterFirst).toBeGreaterThan(settled);

    // Pointer polling runs at 30 Hz with an unchanged cursor. Each suppressed
    // broadcast is one less redundant DOM write in main.ts.
    runtime.handlePointerSample({ x: 80, y: 80 });
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(broadcasts).toBe(afterFirst);
  });

  it("holds the first drag frame without looping or changing facing during pointer motion", async () => {
    const clock = new ManualClock();
    const port: PetMotionPort = {
      resync: async () => motionSnapshot(),
      writeWindowTopLeft: async () => undefined,
    };
    const frameHistory: Array<{ animationId: string; frameIndex: number; url: string }> = [];
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => 0.9,
      onFrame: (event) => frameHistory.push({
        animationId: event.animationId, frameIndex: event.frameIndex, url: event.frame.url,
      }),
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    frameHistory.length = 0;

    expect(runtime.beginDrag()).toBe(true);
    expect(runtime.state.behavior).toBe("DRAG");
    const pickupFacing = runtime.state.facing;
    const expectedDrag = [{ animationId: "drag", frameIndex: 0, url: TEST_RESOURCES.drag.frames[0]!.url }];
    expect(frameHistory.filter(event => event.animationId === "drag")).toEqual(expectedDrag);

    for (const x of [200, 50, 250, 100]) {
      expect(runtime.movePointerDrag({ x, y: 100 }, "monitor-1", motionSnapshot().workArea)).toBe(true);
      runtime.handlePointerSample({ x, y: 80 });
      clock.advanceBy(2_000);
      await flushPromises();
      expect(runtime.state.facing).toBe(pickupFacing);
      expect(runtime.state.visualTransition).toBe("NONE");
      expect(runtime.state.behavior).toBe("DRAG");
      expect(frameHistory.filter(event => event.animationId === "drag")).toEqual(expectedDrag);
    }
    await runtime.endDrag();
    expect(runtime.state.behavior).toBe("FALL");
    runtime.dispose();
  });

  it("keeps a drag above HAPPY and LOOK", async () => {
    const { runtime } = await createReadyRuntime();
    expect(runtime.state.behavior).toBe("IDLE");

    expect(runtime.beginDrag()).toBe(true);
    expect(runtime.state.behavior).toBe("DRAG");

    expect(runtime.triggerHappy()).toBe(false);
    expect(runtime.state.behavior).toBe("DRAG");
    expect(runtime.state.interaction).toBe("DRAG");

    // A cursor right on the pet must not pull a dragging pet into LOOK.
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(runtime.state.behavior).toBe("DRAG");
  });

  it("does not restart an active HAPPY or extend its timer", async () => {
    const { runtime, clock } = await createReadyRuntime(() => 0);
    expect(runtime.state.behavior).toBe("IDLE");

    expect(runtime.triggerHappy()).toBe(true);
    expect(runtime.state.behavior).toBe("HAPPY");

    clock.advanceBy(60);
    expect(runtime.triggerHappy()).toBe(false);
    expect(runtime.state.behavior).toBe("HAPPY");
    clock.advanceBy(40);
    expect(runtime.state.behavior).toBe("IDLE");
    clock.advanceBy(60);
    expect(runtime.state.behavior).toBe("IDLE");
    runtime.dispose();
  });

  it("plays a landing after the final airborne HAPPY frame", async () => {
    const clock = new ManualClock();
    const events: string[] = [];
    const resources = { ...TEST_RESOURCES,
      happy: makeAnimation("happy", [100], "ONCE", "IDLE", false) };
    const runtime = new PetRuntime(resources, { clock, random: () => 0,
      onFrame: event => events.push(event.animationId) });
    await runtime.initialize(async () => undefined);
    runtime.triggerHappy();
    clock.advanceBy(100);
    expect(runtime.state.behavior).toBe("HAPPY");
    expect(runtime.state.activeAnimationId).toBe("land");
    expect(events.at(-1)).toBe("land");
    clock.advanceBy(90);
    clock.advanceBy(80);
    clock.advanceBy(80);
    expect(runtime.state.behavior).toBe("IDLE");
    runtime.dispose();
  });

  it("preserves HAPPY through the armed click release path without replaying it", async () => {
    const { runtime, clock } = await createReadyRuntime(() => 0);
    runtime.triggerHappy();
    clock.advanceBy(60);
    expect(runtime.beginPointerGesture()).toBe(true);
    expect(await runtime.endPointerGesture({ triggerHappy: true })).toBe(false);
    clock.advanceBy(40);
    expect(runtime.state.behavior).toBe("IDLE");
    clock.advanceBy(60);
    expect(runtime.state.behavior).toBe("IDLE");
    runtime.dispose();
  });

  it("enters LOOK from the resting state when the cursor closes in", async () => {
    const { runtime } = await createReadyRuntime();
    expect(runtime.state.behavior).toBe("IDLE");

    // Inside the 90px enter radius.
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(runtime.state.behavior).toBe("LOOK");
  });

  it("keeps HAPPY above LOOK", async () => {
    const { runtime } = await createReadyRuntime();

    expect(runtime.triggerHappy()).toBe(true);
    expect(runtime.state.behavior).toBe("HAPPY");

    // A cursor landing on the pet must not downgrade HAPPY into LOOK.
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(runtime.state.behavior).toBe("HAPPY");
  });

  it("walks on its own once the idle interval elapses", async () => {
    // 0.9 >= IDLE_OR_PAUSE_WEIGHT (0.65), so the scheduler always picks WALK.
    const { runtime, clock, motion } = await createReadyRuntime(() => 0.9);
    expect(runtime.state.behavior).toBe("IDLE");

    const writesBefore = motion.writes.length;

    // The frozen idle interval is 3-8 s; advance past its longest value.
    clock.advanceBy(8_000);
    await flushPromises();

    expect(runtime.state.behavior).toBe("WALK");
    expect(motion.writes.length).toBeGreaterThan(writesBefore);
  });

  it("keeps the autonomous loop alive over a long idle stretch", async () => {
    const { runtime, clock, motion } = await createReadyRuntime();
    const walkDurationsMs: number[] = [];
    let sawIdleToWalk = false;
    let previous = runtime.state.behavior;
    let segmentStartMs = 0;
    const STEP_MS = 100;
    const TOTAL_MS = 600_000;

    for (let elapsedMs = 0; elapsedMs < TOTAL_MS; elapsedMs += STEP_MS) {
      clock.advanceBy(STEP_MS);
      await flushPromises();
      const current = runtime.state.behavior;
      if (current !== previous) {
        if (previous === "WALK") {
          walkDurationsMs.push(elapsedMs - segmentStartMs);
        }
        if (previous === "IDLE" && current === "WALK") {
          sawIdleToWalk = true;
        }
        previous = current;
        segmentStartMs = elapsedMs;
      }
    }

    // The frozen core loop: an idling pet must eventually set off on its own.
    expect(sawIdleToWalk).toBe(true);
    expect(walkDurationsMs.length).toBeGreaterThanOrEqual(3);

    // Frozen baseline: WALK lasts 2-6 s. Allow one sampling step of slack.
    expect(Math.max(...walkDurationsMs)).toBeLessThanOrEqual(6_000 + STEP_MS);

    // Autonomous walking must actually move the window, not just flip a label.
    expect(motion.writes.length).toBeGreaterThan(0);
  });
});

/**
 * Frozen baseline: "Walk 安全停止 <= 200 ms". `stopForDirectInteraction()`
 * cancels the walk synchronously, so the budget is asserted behaviorally:
 * within 200 ms of a direct interaction the pet must have stopped advancing.
 */
describe("PetRuntime direct-interaction stop budget", () => {
  it("stops a walking pet inside the frozen 200 ms budget", async () => {
    const clock = new ManualClock();
    let resyncCount = 0;
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: () => {
        resyncCount += 1;
        return Promise.resolve(motionSnapshot());
      },
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const randomValues = [1, 0, 0.9, 0, 0, 0.9];
    let randomIndex = 0;
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => randomValues[randomIndex++] ?? 0.9,
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();

    clock.advanceBy(3_000);
    await flushPromises();
    expect(runtime.state.behavior).toBe("WALK");

    // Establish that the walk really is producing forward motion first.
    const writesBeforeMotion = writes.length;
    clock.advanceBy(100);
    await flushPromises();
    expect(runtime.state.behavior).toBe("WALK");
    const walkedX = runtime.state.logicalPosition?.x ?? 0;
    expect(
      writes
        .slice(writesBeforeMotion)
        .some((position) => position.x >= walkedX && position.x > 100),
    ).toBe(true);

    const writesAtInteraction = writes.length;
    const xAtInteraction = runtime.state.logicalPosition?.x ?? 0;

    expect(runtime.triggerHappy()).toBe(true);
    await flushPromises();
    expect(runtime.state.behavior).toBe("HAPPY");

    clock.advanceBy(DIRECT_INTERACTION_STOP_MAX_MS);
    await flushPromises();

    expect(runtime.state.behavior).not.toBe("WALK");
    // No write after the interaction may advance the pet any further.
    const advancingWrites = writes
      .slice(writesAtInteraction)
      .filter((position) => position.x > xAtInteraction);
    expect(advancingWrites).toHaveLength(0);
  });
});

describe("PetRuntime interrupted Home gestures", () => {
  async function advance(clock: ManualClock, durationMs: number) {
    for (let remaining = durationMs; remaining > 0; remaining -= 20) {
      clock.advanceBy(Math.min(20, remaining));
      await flushPromises();
    }
  }

  it.each(["awake", "sleep", "paused sleep"] as const)(
    "cancels an armed gesture from %s without losing the Home cycle",
    async stage => {
      const clock = new ManualClock();
      let position = windowPosition(521, 300);
      const frames: string[] = [];
      const runtime = new PetRuntime(TEST_RESOURCES, {
        clock, random: () => 1, homeRandom: () => 0,
        onFrame: event => frames.push(event.animationId),
        motionPort: {
          resync: async () => motionSnapshot(position.x, position.y),
          writeWindowTopLeft: async next => { position = { ...next }; },
        },
      });
      await runtime.initialize(async () => undefined);
      expect(runtime.beginDrag()).toBe(true);
      await runtime.endDrag();
      await advance(clock, 2000);
      expect(runtime.state.behavior).toBe("REST");
      const originalAwakeStart = runtime.state.homeAwakeStartedAtMs;
      const restPosition = { ...position };
      if (stage !== "awake") {
        await advance(clock, HOME_AWAKE_DURATION_MS + 3000);
        expect(runtime.state.activeAnimationId).toBe("sleep");
        if (stage === "paused sleep") runtime.setAutonomyPaused(true);
      }

      const originalQuiet = runtime.state.homeQuietUntilMs;
      const originalDeadline = runtime.state.homeRestDeadlineMs;
      expect(runtime.beginPointerGesture()).toBe(true);
      await advance(clock, 1000);
      const framesBeforeCancel = frames.length;
      // pointercancel, lostpointercapture, and the controller's cancel() all
      // release an armed gesture through this non-Happy Runtime path.
      await expect(runtime.endPointerGesture({ triggerHappy: false })).resolves.toBe(false);
      expect(runtime.state).toMatchObject({ behavior: "REST", interaction: "NONE", isDragging: false });
      expect(position).toEqual(restPosition);
      expect(runtime.state.homeAwakeStartedAtMs).toBe(originalAwakeStart);
      expect(runtime.state.homeQuietUntilMs).toBe(originalQuiet);
      expect(runtime.state.homeRestDeadlineMs).toBe(originalDeadline);
      expect(frames.slice(framesBeforeCancel)).not.toContain("happy");

      await advance(clock, stage === "awake" ? HOME_AWAKE_DURATION_MS + 3000 : 1000);
      expect(runtime.state.activeAnimationId).toBe("sleep");
      if (stage === "paused sleep") {
        expect(runtime.state.homeRestDeadlineMs).toBeUndefined();
        runtime.setAutonomyPaused(false);
      }
      expect(runtime.state.homeRestDeadlineMs).toBeGreaterThan(clock.now());
      runtime.dispose();
    },
  );

  it("completes three natural Home cycles with production frames and exact pointer hysteresis boundaries", async () => {
    const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(
      readFileSync(new URL("../public/character/manifest.json", import.meta.url), "utf8"),
    )));
    const clock = new ManualClock();
    let position = windowPosition(312, 460);
    const frames: string[] = [];
    const runtime = new PetRuntime(resources, {
      clock, random: () => 1, homeRandom: () => 0,
      onFrame: event => { if (event.frameIndex === 0) frames.push(event.animationId); },
      motionPort: {
        resync: async () => motionSnapshot(position.x, position.y),
        writeWindowTopLeft: async next => { position = { ...next }; },
      },
    });
    const advanceUntil = async (condition: () => boolean) => {
      for (let step = 0; step < 12000 && !condition(); step++) {
        clock.advanceBy(50);
        await flushPromises();
      }
      expect(condition()).toBe(true);
    };
    await runtime.initialize(async () => undefined);
    const awakeStarts: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      await advanceUntil(() => runtime.diagnosticState.home_stage === "AWAKE");
      const awakeStart = runtime.state.homeAwakeStartedAtMs!;
      awakeStarts.push(awakeStart);
      expect(runtime.state.homeRoundTripsCompleted).toBe(3);
      expect(runtime.state.homeRestDeadlineMs).toBeUndefined();
      if (cycle === 0) {
        const countLooks = () => frames.filter(id => id === "look_mouse").length;
        const before = countLooks();
        runtime.handlePointerSample({ x: 170, y: 80 }); // Exactly 90 px: enter.
        await advance(clock, 1100);
        runtime.handlePointerSample({ x: 209.999, y: 80 });
        runtime.handlePointerSample({ x: 170, y: 80 });
        expect(countLooks()).toBe(before + 1);
        runtime.handlePointerSample({ x: 210, y: 80 }); // Exactly 130 px: exit.
        expect(runtime.state.pointerNearby).toBe(false);
        runtime.handlePointerSample({ x: 170, y: 80 });
        expect(countLooks()).toBe(before + 2);
      }
      await advanceUntil(() => runtime.diagnosticState.home_stage === "SLEEP");
      expect(clock.now() - awakeStart).toBeGreaterThanOrEqual(HOME_AWAKE_DURATION_MS);
      expect(clock.now() - awakeStart).toBeLessThan(HOME_AWAKE_DURATION_MS + 4000);
      const remainingSleep = runtime.state.homeRestDeadlineMs! - clock.now();
      expect(remainingSleep).toBeGreaterThanOrEqual(30000);
      expect(remainingSleep).toBeLessThanOrEqual(90000);
      // Clear the pointer before departure so the next ground route can start.
      runtime.handlePointerSample({ x: 210, y: 80 });
      await advanceUntil(() => runtime.state.behavior === "LEAVE_HOME");
      await advanceUntil(() => runtime.state.behavior === "IDLE");
      expect(runtime.state.homeAwakeStartedAtMs).toBeUndefined();
      expect(runtime.state.homeRestDeadlineMs).toBeUndefined();
      expect(runtime.state.homeRoundTripsCompleted).toBe(0);
      expect(position.y).toBe(460);
    }
    expect(awakeStarts[1]).toBeGreaterThan(awakeStarts[0]!);
    expect(awakeStarts[2]).toBeGreaterThan(awakeStarts[1]!);
    expect(frames.filter(id => id === "sleep")).toHaveLength(3);
    runtime.dispose();
  });
});
