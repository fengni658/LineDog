import { describe, expect, it } from "vitest";
import type { TimelineClock } from "../src/animation-timeline";
import {
  FOCUSED_INPUT_STALE_AFTER_MS,
  FocusedInputGeometryAdapter,
  INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
  adaptFocusedInputGeometry,
  type FocusedInputFact,
  type FocusedInputDiagnostic,
  type FocusedInputGeometryRequest,
  type FocusedInputGeometryResponse,
  type LogicalRect,
} from "../src/input-avoidance";
import {
  NATIVE_PLATFORM_PROTOCOL_VERSION,
  type NativeDesktopSnapshotV1,
} from "../src/native-platform";
import { HOME_CYCLE_TICK_MS, HOME_JUMP_DURATION_MS, HOME_WAKE_HOLD_MS, computeHomeJumpPoint } from "../src/home-cycle";
import type {
  DefaultRuntimeResources,
  RuntimeAnimation,
  RuntimeFrame,
} from "../src/pet-manifest";
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

function desktopSnapshot(
  monitorId = "monitor-1",
  workArea = WORK_AREA,
  position = windowPosition(100, 100),
): NativeDesktopSnapshotV1 {
  return {
    protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION,
    snapshotRevision: 1,
    capturedAtMonotonicMs: 0,
    currentMonitorId: monitorId,
    workArea,
    windowPosition: position,
    monitorScaleFactor: 2,
    homeWindow: null,
    windowScaleFactor: 2,
  };
}

function motionSnapshot(
  monitorId = "monitor-1",
  workArea = WORK_AREA,
  position = windowPosition(100, 100),
): MotionSnapshot {
  return {
    currentMonitorId: monitorId,
    windowScaleFactor: 1,
    homeWindow: { ready: true, currentMonitorId: monitorId, windowScaleFactor: 1,
      rect: { x: workArea.x + workArea.width - 280, y: workArea.y + workArea.height - 256, width: 256, height: 256 } },
    workArea,
    windowPosition: position,
  };
}

function dynamicResponse(
  request: FocusedInputGeometryRequest,
): FocusedInputGeometryResponse {
  return {
    ...request,
    kind: "dynamic-line",
    rectPhysical: {
      left: 100,
      top: 200,
      right: 400,
      bottom: 260,
    },
    approximate: false,
    textFocus: true,
    activeCaret: true,
    singleVisualBand: true,
    caretEvidenceKind: "dynamic-line",
    busy: false,
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
  for (let count = 0; count < 8; count += 1) {
    await Promise.resolve();
  }
}

class ManualClock implements TimelineClock {
  private currentTimeMs = 0;
  private nextTimerId = 0;
  private readonly timers = new Map<
    number,
    { readonly dueAtMs: number; readonly callback: () => void }
  >();

  scheduledCount = 0;

  get pendingTimerCount(): number {
    return this.timers.size;
  }

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
  playback: "LOOP" | "ONCE",
  nextState: string,
  groundContact: boolean,
): RuntimeAnimation {
  return {
    id,
    animationId: id,
    revision: "input-avoidance-test",
    status: "FROZEN",
    sourceView: "front",
    loop: playback === "LOOP",
    interruptPolicy: "interruptible_by_user_interaction",
    nextState,
    frameDurationMs: 100,
    playback,
    reversePlaybackAllowed: false,
    frameDurationsMs: [100],
    frames: [makeFrame(id, 0, 100, groundContact)],
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
  idle: makeAnimation("idle", "LOOP", "IDLE", true),
  blink: makeAnimation("blink", "ONCE", "IDLE", true),
  walk: makeAnimation("walk", "LOOP", "WALK", true),
  lookMouse: makeAnimation("look_mouse", "ONCE", "LOOK", true),
  happy: makeAnimation("happy", "ONCE", "IDLE", true),
  drag: makeAnimation("drag", "LOOP", "DRAG", true),
  fall: makeAnimation("fall", "LOOP", "FALL", false),
  land: makeAnimation("land", "ONCE", "IDLE", true),
  turn: makeAnimation("turn", "ONCE", "WALK", true),
  jumpAir: makeAnimation("jump_air", "ONCE", "HOME_LAND", false),
  homeLand: makeAnimation("home_land", "ONCE", "HOME_IDLE", true),
  homeIdle: makeAnimation("home_idle", "ONCE", "SLEEP", true),
  sleep: makeAnimation("sleep", "LOOP", "SLEEP", true),
};

function activeFact(
  revision: number,
  forbiddenRegion: LogicalRect,
  options: {
    readonly monitorId?: string;
    readonly monitorRevision?: number;
    readonly workArea?: LogicalWorkArea;
    readonly focusSessionId?: string;
  } = {},
): FocusedInputFact {
  return {
    kind: "dynamic-line",
    forbiddenRegion,
    approximate: false,
    revision,
    monitorId: options.monitorId ?? "monitor-1",
    workArea: options.workArea ?? WORK_AREA,
    monitorRevision: options.monitorRevision ?? 1,
    focusSessionId: options.focusSessionId ?? `focus-${revision}`,
  };
}

async function initializeRuntime(
  port: PetMotionPort,
  clock: ManualClock,
  onStateChange?: (state: Readonly<PetRuntimeState>) => void,
): Promise<PetRuntime> {
  const runtime = new PetRuntime(TEST_RESOURCES, {
    clock,
    motionPort: port,
    random: () => 1,
    onStateChange,
  });
  await runtime.initialize(async () => undefined);
  await flushPromises();
  return runtime;
}

describe("Focused input geometry adaptation", () => {
  it("uses the same window DPI as the desktop workarea on a mixed-DPI snapshot", () => {
    const adapted = adaptFocusedInputGeometry(dynamicResponse({
      requestStartedAtMonotonic: 0, requestRevision: 1, monitorRevision: 1, disposeGeneration: 0,
    }), { ...desktopSnapshot(), monitorScaleFactor: 1, windowScaleFactor: 2 });
    expect(adapted).toMatchObject({ forbiddenRegion: {
      left: 50 - INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
      top: 100 - INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
      right: 200 + INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
      bottom: 130 + INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
    } });
  });
  it("converts one physical geometry response into clipped logical avoidance geometry", () => {
    const adapted = adaptFocusedInputGeometry(
      dynamicResponse({
        requestStartedAtMonotonic: 0,
        requestRevision: 1,
        monitorRevision: 1,
        disposeGeneration: 0,
      }),
      desktopSnapshot(),
    );

    expect(adapted).toMatchObject({
      kind: "dynamic-line",
      approximate: false,
      monitorId: "monitor-1",
      workArea: WORK_AREA,
      forbiddenRegion: {
        left: 50 - INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
        top: 100 - INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
        right: 200 + INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
        bottom: 130 + INPUT_AVOIDANCE_SAFE_MARGIN_LOGICAL_PX,
      },
    });
  });
});

describe("FocusedInputGeometryAdapter request validity", () => {
  const exactNone = (request: FocusedInputGeometryRequest): FocusedInputGeometryResponse => ({
    ...request, kind: "none", rectPhysical: null, approximate: false, textFocus: false,
    activeCaret: false, singleVisualBand: false, caretEvidenceKind: "none", busy: false,
  });

  it.each([
    { approximate: true }, { textFocus: true }, { activeCaret: true }, { singleVisualBand: true },
    { caretEvidenceKind: "provider-active" }, { caretEvidenceKind: null },
    { errorCode: "uia-failure" }, { busy: true },
    { rectPhysical: { left: 0, top: 0, right: 10, bottom: 10 } },
  ])("does not trust contradictory no-focus fields: %j", patch => {
    const request = { requestStartedAtMonotonic: 0, requestRevision: 1, monitorRevision: 1, disposeGeneration: 0 };
    expect(adaptFocusedInputGeometry({ ...exactNone(request), ...patch }, desktopSnapshot()))
      .toMatchObject({ kind: "none", approximate: true });
  });

  it.each([
    ["requestStartedAtMonotonic", "timestamp"], ["requestRevision", "request-revision"],
    ["monitorRevision", "monitor-revision"], ["disposeGeneration", "dispose-generation"],
    ["multiple", "multiple"],
  ] as const)("classifies %s mismatches without logging numeric identities or repeating unchanged reasons", async (field, reason) => {
    const clock = new ManualClock(); const facts: FocusedInputFact[] = [];
    const diagnostics: FocusedInputDiagnostic[] = [];
    const adapter = new FocusedInputGeometryAdapter({ clock, readDesktopSnapshot: async () => desktopSnapshot(),
      readFocusedInputSnapshot: async request => ({ ...exactNone(request),
        ...(field === "multiple" ? { requestRevision: request.requestRevision + 1, monitorRevision: request.monitorRevision + 1 }
          : { [field]: request[field] + 1 }) }),
      onFact: value => facts.push(value), onDiagnostic: value => diagnostics.push(value),
    });
    adapter.start(); clock.advanceBy(0); await flushPromises();
    clock.advanceBy(250); await flushPromises();
    expect(facts.every(fact => fact.approximate)).toBe(true);
    expect(diagnostics).toEqual([{ input_status: "rejected", input_kind: "unknown", input_code: "request-mismatch", approximate: true, identity_mismatch: reason }]);
    adapter.dispose();
  });

  it.each([749.9, 750, 750.1])("uses integer transport identity but the original fractional start for age %s", async age => {
    const clock = new ManualClock(); clock.advanceBy(2000.1999999999534);
    const start = clock.now(); const gate = deferred<FocusedInputGeometryResponse>();
    let request!: FocusedInputGeometryRequest;
    const facts: FocusedInputFact[] = []; const diagnostics: FocusedInputDiagnostic[] = [];
    const adapter = new FocusedInputGeometryAdapter({ clock, readDesktopSnapshot: async () => desktopSnapshot(),
      readFocusedInputSnapshot: async value => { request = value; return gate.promise; },
      onFact: value => facts.push(value), onDiagnostic: value => diagnostics.push(value) });
    adapter.start(); clock.advanceBy(0); await flushPromises();
    expect(request.requestStartedAtMonotonic).toBe(Math.floor(start));
    clock.advanceBy(age); gate.resolve(exactNone(request)); await flushPromises();
    expect(facts.at(-1)?.approximate).toBe(age > 750);
    expect(diagnostics.at(-1)?.input_code).toBe(age > 750 ? "stale-response" : "ok");
    adapter.dispose();
  });

  it("does not accept a response that expires during the second desktop read", async () => {
    const clock = new ManualClock(); let reads = 0;
    const snapshotGate = deferred<NativeDesktopSnapshotV1 | null>();
    const facts: FocusedInputFact[] = [];
    const adapter = new FocusedInputGeometryAdapter({ clock,
      readDesktopSnapshot: async () => ++reads === 1 ? desktopSnapshot() : snapshotGate.promise,
      readFocusedInputSnapshot: async request => exactNone(request), onFact: value => facts.push(value) });
    adapter.start(); clock.advanceBy(0); await flushPromises();
    clock.advanceBy(751); snapshotGate.resolve(desktopSnapshot()); await flushPromises();
    expect(facts).toHaveLength(1); expect(facts[0].approximate).toBe(true);
    adapter.dispose();
  });

  it("preserves native failure reasons, accepts trusted none, and reports geometry recovery", async () => {
    const clock = new ManualClock();
    const facts: FocusedInputFact[] = [];
    const diagnostics: FocusedInputDiagnostic[] = [];
    let errorCode: string | undefined = "worker-timeout";
    let validGeometry = false;
    const adapter = new FocusedInputGeometryAdapter({ clock,
      readDesktopSnapshot: async () => desktopSnapshot(),
      readFocusedInputSnapshot: async request => validGeometry ? dynamicResponse(request) : ({ ...dynamicResponse(request),
        kind: errorCode ? "error" : "none", errorCode, textFocus: false, activeCaret: false,
        singleVisualBand: false, caretEvidenceKind: "none", rectPhysical: null }),
      onFact: fact => facts.push(fact), onDiagnostic: value => diagnostics.push(value),
    });
    adapter.start(); clock.advanceBy(0); await flushPromises();
    for (let n = 0; n < 10; n++) { clock.advanceBy(250); await flushPromises(); }
    expect(diagnostics).toEqual([{ input_status: "unavailable", input_kind: "error", input_code: "worker-timeout", approximate: true }]);
    expect(facts.at(-1)).toMatchObject({ kind: "none", approximate: true });
    errorCode = "private title sk-secret";
    clock.advanceBy(250); await flushPromises();
    expect(diagnostics.at(-1)?.input_code).toBe("unknown");
    expect(JSON.stringify(diagnostics)).not.toContain("sk-secret");
    errorCode = undefined;
    clock.advanceBy(250); await flushPromises();
    expect(diagnostics.at(-1)).toMatchObject({ input_status: "accepted", input_kind: "none", input_code: "ok", approximate: false });
    expect(facts.at(-1)).toMatchObject({ kind: "none", approximate: false });
    validGeometry = true;
    clock.advanceBy(250); await flushPromises();
    expect(diagnostics.at(-1)).toMatchObject({ input_status: "accepted", input_kind: "dynamic-line", input_code: "ok", approximate: false });
    adapter.dispose();
  });

  it("reports busy without replacing the last geometry fact", async () => {
    const clock = new ManualClock(); const facts: FocusedInputFact[] = [];
    const diagnostics: FocusedInputDiagnostic[] = []; let busy = false;
    const adapter = new FocusedInputGeometryAdapter({ clock,
      readDesktopSnapshot: async () => desktopSnapshot(),
      readFocusedInputSnapshot: async request => ({ ...dynamicResponse(request), busy }),
      onFact: fact => facts.push(fact), onDiagnostic: value => diagnostics.push(value),
    });
    adapter.start(); clock.advanceBy(0); await flushPromises(); busy = true;
    clock.advanceBy(250); await flushPromises();
    expect(facts).toHaveLength(1);
    expect(diagnostics.at(-1)).toMatchObject({ input_status: "busy", input_code: "worker-busy" });
    adapter.dispose();
  });

  it("reports desktop unavailability and isolates diagnostic callback errors", async () => {
    const clock = new ManualClock(); const facts: FocusedInputFact[] = [];
    const diagnostics: FocusedInputDiagnostic[] = [];
    const adapter = new FocusedInputGeometryAdapter({ clock, readDesktopSnapshot: async () => null,
      readFocusedInputSnapshot: async request => dynamicResponse(request), onFact: fact => facts.push(fact),
      onDiagnostic: value => { diagnostics.push(value); throw new Error("sink failed"); },
    });
    adapter.start(); clock.advanceBy(0); await flushPromises();
    clock.advanceBy(250); await flushPromises();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].input_code).toBe("desktop-unavailable");
    expect(facts).toHaveLength(2);
    expect(facts[1].approximate).toBe(true);
    adapter.dispose();
  });

  it("emits a dynamic fact only when the response and current monitor match", async () => {
    const clock = new ManualClock();
    const facts: FocusedInputFact[] = [];
    let desktopReadCount = 0;
    const adapter = new FocusedInputGeometryAdapter({
      clock,
      readDesktopSnapshot: async () => {
        desktopReadCount += 1;
        return desktopSnapshot();
      },
      readFocusedInputSnapshot: async (request) => dynamicResponse(request),
      onFact: (fact) => facts.push(fact),
    });

    adapter.start();
    clock.advanceBy(0);
    await flushPromises();

    expect(desktopReadCount).toBe(2);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      kind: "dynamic-line",
      monitorId: "monitor-1",
      monitorRevision: 1,
      revision: 1,
      focusSessionId: "focus-1",
    });
    adapter.dispose();
  });

  it("turns a stale response into fail-closed none geometry", async () => {
    const clock = new ManualClock();
    const responseGate = deferred<FocusedInputGeometryResponse>();
    const facts: FocusedInputFact[] = [];
    let request: FocusedInputGeometryRequest | undefined;
    const adapter = new FocusedInputGeometryAdapter({
      clock,
      readDesktopSnapshot: async () => desktopSnapshot(),
      readFocusedInputSnapshot: async (receivedRequest) => {
        request = receivedRequest;
        return responseGate.promise;
      },
      onFact: (fact) => facts.push(fact),
    });

    adapter.start();
    clock.advanceBy(0);
    await flushPromises();
    if (!request) {
      throw new Error("The focused-input request was not started.");
    }

    clock.advanceBy(FOCUSED_INPUT_STALE_AFTER_MS + 1);
    responseGate.resolve(dynamicResponse(request));
    await flushPromises();

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      kind: "none",
      approximate: true,
      monitorId: "monitor-1",
      monitorRevision: 1,
    });
    expect(facts[0]?.forbiddenRegion).toBeUndefined();
    adapter.dispose();
  });

  it("turns a response with mismatched request identity into fail-closed none geometry", async () => {
    const clock = new ManualClock();
    const responseGate = deferred<FocusedInputGeometryResponse>();
    const facts: FocusedInputFact[] = [];
    let request: FocusedInputGeometryRequest | undefined;
    const adapter = new FocusedInputGeometryAdapter({
      clock,
      readDesktopSnapshot: async () => desktopSnapshot(),
      readFocusedInputSnapshot: async (receivedRequest) => {
        request = receivedRequest;
        return responseGate.promise;
      },
      onFact: (fact) => facts.push(fact),
    });

    adapter.start();
    clock.advanceBy(0);
    await flushPromises();
    if (!request) {
      throw new Error("The focused-input request was not started.");
    }

    responseGate.resolve({
      ...dynamicResponse(request),
      requestRevision: request.requestRevision + 1,
    });
    await flushPromises();

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      kind: "none",
      approximate: true,
      monitorId: "monitor-1",
      monitorRevision: 1,
    });
    expect(facts[0]?.forbiddenRegion).toBeUndefined();
    adapter.dispose();
  });

  it("turns a monitor change during the read into fail-closed none geometry", async () => {
    const clock = new ManualClock();
    const facts: FocusedInputFact[] = [];
    let desktopReadCount = 0;
    const adapter = new FocusedInputGeometryAdapter({
      clock,
      readDesktopSnapshot: async () => {
        desktopReadCount += 1;
        return desktopReadCount === 1
          ? desktopSnapshot("monitor-1")
          : desktopSnapshot("monitor-2");
      },
      readFocusedInputSnapshot: async (request) => dynamicResponse(request),
      onFact: (fact) => facts.push(fact),
    });

    adapter.start();
    clock.advanceBy(0);
    await flushPromises();

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      kind: "none",
      approximate: true,
      monitorId: "monitor-2",
      monitorRevision: 2,
    });
    expect(facts[0]?.forbiddenRegion).toBeUndefined();
    adapter.dispose();
  });

  it("emits fail-closed none geometry when the desktop snapshot read fails", async () => {
    const clock = new ManualClock();
    const facts: FocusedInputFact[] = [];
    const adapter = new FocusedInputGeometryAdapter({
      clock,
      readDesktopSnapshot: async () => {
        throw new Error("desktop snapshot unavailable");
      },
      readFocusedInputSnapshot: async (request) => dynamicResponse(request),
      onFact: (fact) => facts.push(fact),
    });

    adapter.start();
    clock.advanceBy(0);
    await flushPromises();

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "none",
        approximate: true,
        revision: 1,
      }),
    ]);
    expect(facts[0]?.monitorId).toBeUndefined();
    expect(facts[0]?.forbiddenRegion).toBeUndefined();
    adapter.dispose();
  });

  it("emits fail-closed none geometry when the focused-input read fails", async () => {
    const clock = new ManualClock();
    const facts: FocusedInputFact[] = [];
    const adapter = new FocusedInputGeometryAdapter({
      clock,
      readDesktopSnapshot: async () => desktopSnapshot(),
      readFocusedInputSnapshot: async () => {
        throw new Error("focused-input snapshot unavailable");
      },
      onFact: (fact) => facts.push(fact),
    });

    adapter.start();
    clock.advanceBy(0);
    await flushPromises();

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "none",
        approximate: true,
        monitorId: "monitor-1",
        monitorRevision: 1,
        revision: 1,
      }),
    ]);
    expect(facts[0]?.forbiddenRegion).toBeUndefined();
    adapter.dispose();
  });

  it.each(["resolve", "reject"] as const)(
    "does not emit a late %s response after adapter dispose",
    async (lateOutcome) => {
      const clock = new ManualClock();
      const responseGate = deferred<FocusedInputGeometryResponse>();
      const facts: FocusedInputFact[] = [];
      let request: FocusedInputGeometryRequest | undefined;
      const adapter = new FocusedInputGeometryAdapter({
        clock,
        readDesktopSnapshot: async () => desktopSnapshot(),
        readFocusedInputSnapshot: async (receivedRequest) => {
          request = receivedRequest;
          return responseGate.promise;
        },
        onFact: (fact) => facts.push(fact),
      });

      adapter.start();
      clock.advanceBy(0);
      await flushPromises();
      if (!request) {
        throw new Error("The focused-input request was not started.");
      }

      adapter.dispose();
      if (lateOutcome === "resolve") {
        responseGate.resolve(dynamicResponse(request));
      } else {
        responseGate.reject(new Error("late focused-input failure"));
      }
      await flushPromises();
      clock.advanceBy(10_000);
      await flushPromises();

      expect(facts).toHaveLength(0);
    },
  );
});

describe("Home 跳跃输入准入", () => {
  async function setup() {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock, random: () => 1, homeRandom: () => 0,
      motionPort: {
        resync: async () => motionSnapshot("monitor-1", WORK_AREA, writes.at(-1) ?? windowPosition(312, 460)),
        writeWindowTopLeft: async point => { writes.push({ ...point }); },
      },
    });
    await runtime.initialize(async () => undefined);
    for (let i = 0; i < 20000 && !runtime.state.homeCyclePhase; i++) {
      clock.advanceBy(50); await flushPromises();
    }
    expect(runtime.state.homeCyclePhase).toBe("GO_HOME");
    return { runtime, clock, writes };
  }

  async function enterJump(runtime: PetRuntime, clock: ManualClock) {
    clock.advanceBy(500); await flushPromises();
    expect(runtime.state.activeAnimationId).toBe("jump_air");
  }

  async function enterRest(runtime: PetRuntime, clock: ManualClock) {
    await enterJump(runtime, clock);
    clock.advanceBy(HOME_JUMP_DURATION_MS); await flushPromises();
    expect(runtime.state.activeAnimationId).toBe("home_land");
    clock.advanceBy(100); await flushPromises();
    expect(runtime.state.behavior).toBe("REST");
    expect(runtime.state.homeRestDeadlineMs).toBeUndefined();
    clock.advanceBy(120000); await flushPromises();
    clock.advanceBy(100); await flushPromises();
    expect(runtime.state.activeAnimationId).toBe("sleep");
    expect(runtime.state.homeRestDeadlineMs).toBeGreaterThan(clock.now());
  }

  async function wake(runtime: PetRuntime, clock: ManualClock) {
    // LAND/清醒 REST 不存在睡眠截止时间，必须先观察实际 sleep 入口。
    for (let step = 0; step < 1400 && runtime.state.homeRestDeadlineMs === undefined; step++) {
      clock.advanceBy(100); await flushPromises();
    }
    expect(runtime.state.activeAnimationId).toBe("sleep");
    const deadline = runtime.state.homeRestDeadlineMs;
    expect(Number.isFinite(deadline)).toBe(true);
    clock.advanceBy(deadline! - clock.now()); await flushPromises();
    clock.advanceBy(HOME_WAKE_HOLD_MS); await flushPromises();
  }

  it("只挡弧线且不挡地面及端点：走至入口后延迟跳入，安全恢复重试", async () => {
    const { runtime, clock, writes } = await setup();
    // y=370 在弧线顶部，低于两端窗口顶边，地面 y=460 完全不相交。
    runtime.handleInputAvoidanceFact(activeFact(1, { left: 490, right: 500, top: 369, bottom: 371 }));
    clock.advanceBy(500); await flushPromises();
    expect(runtime.state.logicalPosition).toEqual({ x: 360, y: 460 });
    expect(runtime.state.homePending).toBe(true);
    const count = writes.length;
    clock.advanceBy(10000); await flushPromises();
    expect(writes).toHaveLength(count);
    runtime.handleInputAvoidanceFact(activeFact(2, { left: 0, right: 10, top: 0, bottom: 10 }));
    clock.advanceBy(40); await flushPromises();
    expect(runtime.state.homePending).toBeUndefined();
    expect(runtime.state.activeAnimationId).toBe("jump_air");
    runtime.dispose();
  });

  it.each(["LAND", "REST"])("%s 新覆盖不逃逸，回调不能绕过离窝准入", async stage => {
    const { runtime, clock, writes } = await setup();
    await enterJump(runtime, clock);
    clock.advanceBy(HOME_JUMP_DURATION_MS); await flushPromises();
    if (stage === "REST") { clock.advanceBy(100); await flushPromises(); }
    runtime.handleInputAvoidanceFact(activeFact(1, { left: 600, right: 620, top: 400, bottom: 420 }));
    clock.advanceBy(100); await flushPromises();
    const position = runtime.state.logicalPosition;
    const count = writes.length;
    await wake(runtime, clock);
    expect(runtime.state.behavior).toBe("REST");
    expect(runtime.state.homePending).toBe(true);
    expect(runtime.state.logicalPosition).toEqual(position);
    expect(writes).toHaveLength(count);
    expect(runtime.state.escapePlanId).toBeUndefined();
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 2 });
    expect(runtime.state.behavior).toBe("LEAVE_HOME");
    runtime.dispose();
  });

  it("只阻挡离窝路径而不覆盖 REST，移开后离窝", async () => {
    const { runtime, clock } = await setup();
    await enterRest(runtime, clock);
    runtime.handleInputAvoidanceFact(activeFact(1, { left: 400, right: 410, top: 480, bottom: 490 }));
    await wake(runtime, clock);
    expect(runtime.state).toMatchObject({ behavior: "REST", homePending: true, logicalPosition: { x: 521, y: 392 } });
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 2 });
    expect(runtime.state.behavior).toBe("LEAVE_HOME");
    runtime.dispose();
  });

  it.each(["进窝", "离窝"])("%s 起飞后的跳跃视为已提交，未知/阻塞事实不再空中冻结", async direction => {
    const { runtime, clock } = await setup();
    if (direction === "离窝") { await enterRest(runtime, clock); await wake(runtime, clock); }
    else await enterJump(runtime, clock);
    clock.advanceBy(200); await flushPromises();
    // 空中先注入未知事实，再注入完全覆盖跳跃包络的阻塞事实：必须飞完。
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: true, revision: 1 });
    clock.advanceBy(2000); await flushPromises();
    runtime.handleInputAvoidanceFact(activeFact(2, { left: 500, right: 700, top: 300, bottom: 450 }));
    clock.advanceBy(2000); await flushPromises();
    if (direction === "进窝") {
      expect(runtime.state).toMatchObject({
        behavior: "REST",
        homePending: undefined,
        logicalPosition: { x: 521, y: 392 },
      });
    } else {
      expect(runtime.state).toMatchObject({
        behavior: "IDLE",
        homePending: undefined,
        homeCyclePhase: undefined,
        logicalPosition: { x: 360, y: 460 },
      });
    }
    runtime.dispose();
  });

  it("离窝前 WAKE_HOLD 暂停仍被允许，恢复后立即起跳并从头计时", async () => {
    const { runtime, clock } = await setup();
    await enterRest(runtime, clock);
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 1 });
    clock.advanceBy(runtime.state.homeRestDeadlineMs! - clock.now()); await flushPromises();
    clock.advanceBy(HOME_WAKE_HOLD_MS - 300); await flushPromises();
    expect(runtime.state.behavior).toBe("REST");
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: true, revision: 2 });
    await flushPromises();
    expect(runtime.state.homePending).toBe(true);
    clock.advanceBy(5000); await flushPromises();
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 3 });
    await flushPromises();
    expect(runtime.state.homePending).toBeUndefined();
    expect(runtime.state.behavior).toBe("LEAVE_HOME");
    // 恢复即起跳：推进半程应精确落在弧线中点，不受暂停墙钟影响。
    clock.advanceBy(HOME_JUMP_DURATION_MS / 2); await flushPromises();
    expect(runtime.state.logicalPosition).toEqual(computeHomeJumpPoint(
      { x: 521, y: 392 }, { x: 360, y: 460 }, 0.5,
    ));
    runtime.dispose();
  });

  it.each(["跳入前", "进窝", "离窝前", "离窝"])("Drag 取消%s所有待恢复跳跃", async stage => {
    const { runtime, clock, writes } = await setup();
    if (stage === "离窝前" || stage === "离窝") {
      await enterRest(runtime, clock);
      if (stage === "离窝") await wake(runtime, clock);
    } else if (stage === "进窝") await enterJump(runtime, clock);
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: true, revision: 1 });
    if (stage === "离窝前") await wake(runtime, clock);
    // 空中阶段（进窝/离窝）已提交不再暂停；只有地面阶段（跳入前/离窝前）可暂停。
    expect(runtime.state.homePending).toBe(
      stage === "跳入前" || stage === "离窝前" ? true : undefined,
    );
    expect(runtime.beginDrag()).toBe(true);
    await flushPromises();
    const count = writes.length;
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 2 });
    clock.advanceBy(120000); await flushPromises();
    expect(runtime.state).toMatchObject({ behavior: "DRAG", homePending: undefined,
      homeCyclePhase: stage === "离窝前" ? "REST" : undefined });
    expect(writes).toHaveLength(count);
    runtime.dispose();
  });
});

describe("PetRuntime input avoidance consumption", () => {
  it("输入避让真实位移不计圈且重新定位近端", async () => {
    const clock = new ManualClock();
    let position = windowPosition(312, 460);
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock, random: () => 1, homeRandom: () => 0,
      motionPort: {
        resync: async () => motionSnapshot("monitor-1", WORK_AREA, position),
        writeWindowTopLeft: async next => { position = { ...next }; },
      },
    });
    await runtime.initialize(async () => undefined);
    await flushPromises();
    runtime.handleInputAvoidanceFact(activeFact(1, { left: 320, top: 400, right: 450, bottom: 590 }));
    await flushPromises();
    for (let step = 0; step < 200 && position.x === 312; step++) {
      clock.advanceBy(50); await flushPromises();
    }
    expect(position.x).not.toBe(312);
    expect(runtime.state.motionOwner).toBe("INPUT_AVOIDANCE");
    expect(runtime.state.homeRoundTripsCompleted).toBe(0);
    expect(runtime.state.homeWalkTargetX).toBe(312);
    expect(runtime.state.homeCyclePhase).toBeUndefined();
    runtime.dispose();
  });
  it("路径阻塞时不启动回窝，也不使用 homePending 等待靠近", async () => {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    const stateHistory: PetRuntimeState[] = [];
    const port: PetMotionPort = {
      resync: async () =>
        motionSnapshot("monitor-1", WORK_AREA, windowPosition(0, 440)),
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const runtime = await initializeRuntime(port, clock, (state) =>
      stateHistory.push({ ...state }),
    );
    runtime.handleInputAvoidanceFact(
      activeFact(1, {
        left: 200,
        top: 400,
        right: 500,
        bottom: 500,
      }),
    );
    await flushPromises();

    const writesBeforeCounter = writes.length;
    expect(runtime.state.homeRoundTripsCompleted).toBe(0);
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      homeCyclePhase: undefined,
      homeRoundTripsCompleted: 0,
    });
    expect(runtime.state.escapePlanId).toBeUndefined();
    expect(writes).toHaveLength(writesBeforeCounter);
    expect(stateHistory.map((state) => state.behavior)).not.toContain("GO_HOME");
  });

  it("安全未知时不启动回窝或推进圈数", async () => {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: async () =>
        motionSnapshot("monitor-1", WORK_AREA, writes.at(-1) ?? windowPosition(0, 460)),
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const runtime = await initializeRuntime(port, clock);
    const writesBeforeFact = writes.length;

    runtime.handleInputAvoidanceFact({
      kind: "none",
      approximate: true,
      revision: 1,
    });
    await flushPromises();
    expect(runtime.state.homeRoundTripsCompleted).toBe(0);
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      homeCyclePhase: undefined,
      homeRoundTripsCompleted: 0,
    });
    expect(runtime.state.escapePlanId).toBeUndefined();
    expect(writes).toHaveLength(writesBeforeFact);
  });

  it("明确安全事实不能令远处宠物直接回窝", async () => {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: async () =>
        motionSnapshot("monitor-1", WORK_AREA, writes.at(-1) ?? windowPosition(0, 460)),
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const runtime = await initializeRuntime(port, clock);

    runtime.handleInputAvoidanceFact({
      kind: "none",
      approximate: true,
      revision: 1,
    });
    await flushPromises();
    expect(runtime.state.homeRoundTripsCompleted).toBe(0);
    await flushPromises();
    expect(runtime.state.homePending).toBeUndefined();
    const writesBeforeRelease = writes.length;

    runtime.handleInputAvoidanceFact({
      kind: "none",
      approximate: false,
      revision: 2,
    });
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      homeCyclePhase: undefined,
    });
    expect(writes.length).toBe(writesBeforeRelease);
  });

  it("system-caret 缺少安全几何时不启动回窝", async () => {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    const port: PetMotionPort = {
      resync: async () =>
        motionSnapshot("monitor-1", WORK_AREA, writes.at(-1) ?? windowPosition(0, 460)),
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const runtime = await initializeRuntime(port, clock);
    const writesBeforeFact = writes.length;

    runtime.handleInputAvoidanceFact({
      kind: "system-caret",
      approximate: false,
      revision: 1,
      monitorId: "monitor-1",
      workArea: WORK_AREA,
      monitorRevision: 1,
      focusSessionId: "focus-system-caret",
    });
    await flushPromises();
    expect(runtime.state.homeRoundTripsCompleted).toBe(0);
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      homeCyclePhase: undefined,
      homeRoundTripsCompleted: 0,
    });
    expect(runtime.state.escapePlanId).toBeUndefined();
    expect(writes).toHaveLength(writesBeforeFact);
  });

  it("does not invent a horizontal escape path when neither side is safe", async () => {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    const warnings: Array<{ code: string; focusSessionId: string }> = [];
    const port: PetMotionPort = {
      resync: async () =>
        motionSnapshot("monitor-1", WORK_AREA, windowPosition(100, 440)),
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => 1,
      onInputAvoidanceWarning: (warning) => warnings.push({ ...warning }),
    });
    await runtime.initialize(async () => undefined);
    await flushPromises();
    const initialWrites = writes.map((position) => ({ ...position }));

    runtime.handleInputAvoidanceFact(
      activeFact(
        1,
        {
          left: 50,
          top: 0,
          right: 750,
          bottom: 600,
        },
        { focusSessionId: "focus-no-safe-side" },
      ),
    );
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
      motionOwner: "AUTONOMOUS",
    });
    expect(runtime.state.escapePlanId).toBeUndefined();
    expect(writes).toHaveLength(initialWrites.length + 1);
    expect(writes.slice(initialWrites.length).every((position) => position.x === 100)).toBe(
      true,
    );
    expect(warnings).toEqual([
      {
        code: "INPUT_AVOIDANCE_NO_SAFE_SIDE",
        focusSessionId: "focus-no-safe-side",
      },
    ]);
  });

  it("does not consume an avoidance fact when the resync confirms another monitor", async () => {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    let resyncCount = 0;
    const port: PetMotionPort = {
      resync: async () => {
        resyncCount += 1;
        return motionSnapshot("monitor-1");
      },
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const runtime = await initializeRuntime(port, clock);
    const initialWrites = writes.map((position) => ({ ...position }));

    runtime.handleInputAvoidanceFact(
      activeFact(
        1,
        {
          left: 50,
          top: 50,
          right: 300,
          bottom: 300,
        },
        { monitorId: "monitor-2", monitorRevision: 1 },
      ),
    );
    await flushPromises();

    expect(resyncCount).toBe(2);
    expect(runtime.state).toMatchObject({
      behavior: "IDLE",
    });
    expect(runtime.state.escapePlanId).toBeUndefined();
    expect(writes).toEqual(initialWrites);
  });

  it.each(["resolve", "reject"] as const)(
    "does not let a late %s avoidance resync regain authority after a newer fact",
    async (lateOutcome) => {
      const clock = new ManualClock();
      const lateResync = deferred<MotionSnapshot | null>();
      const writes: WindowTopLeftLogical[] = [];
      let resyncCount = 0;
      const port: PetMotionPort = {
        resync: async () => {
          resyncCount += 1;
          return resyncCount === 1
            ? motionSnapshot()
            : lateResync.promise;
        },
        writeWindowTopLeft: async (position) => {
          writes.push({ ...position });
        },
      };
      const runtime = await initializeRuntime(port, clock);
      runtime.handleInputAvoidanceFact(
        activeFact(
          1,
          {
            left: 50,
            top: 50,
            right: 300,
            bottom: 300,
          },
          { monitorId: "monitor-2", monitorRevision: 1 },
        ),
      );
      await flushPromises();
      expect(resyncCount).toBe(2);
      const writesBeforeNewerFact = writes.length;

      runtime.handleInputAvoidanceFact({
        kind: "none",
        approximate: true,
        revision: 2,
      });
      await flushPromises();

      if (lateOutcome === "resolve") {
        lateResync.resolve(motionSnapshot("monitor-2"));
      } else {
        lateResync.reject(new Error("late avoidance resync failure"));
      }
      await flushPromises();

      expect(runtime.state).toMatchObject({
        behavior: "IDLE",
        inputAvoidanceFactRevision: 2,
      });
      expect(runtime.state.escapePlanId).toBeUndefined();
      expect(writes).toHaveLength(writesBeforeNewerFact);
    },
  );

  it("pauses an already-running Home route when safety becomes unknown and resumes only after an explicit safe none fact", async () => {
    const clock = new ManualClock();
    const writes: WindowTopLeftLogical[] = [];
    const stateHistory: PetRuntimeState[] = [];
    const lifecycle: string[] = [];
    const port: PetMotionPort = {
      resync: async () =>
        motionSnapshot("monitor-1", WORK_AREA, writes.at(-1) ?? windowPosition(0, 460)),
      writeWindowTopLeft: async (position) => {
        writes.push({ ...position });
      },
    };
    const runtime = new PetRuntime(TEST_RESOURCES, {
      clock,
      motionPort: port,
      random: () => 1,
      onStateChange: (state) => stateHistory.push({ ...state }),
      onHomeLifecycle: (event) => lifecycle.push(event.type),
    });

    await runtime.initialize(async () => undefined);
    await flushPromises();
    for (let step = 0; step < 20000 && !runtime.state.homeCyclePhase; step += 1) {
      clock.advanceBy(50);
      await flushPromises();
    }
    expect(runtime.state.homeRoundTripsCompleted).toBe(runtime.state.homeRoundTripsTarget);
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "GO_HOME",
      homeCyclePhase: "GO_HOME",
      homePending: undefined,
      logicalPosition: { x: 336, y: 460 },
    });
    const writesBeforeTravel = writes.length;
    clock.advanceBy(HOME_CYCLE_TICK_MS + 1);
    await flushPromises();
    const positionBeforeUnsafeFact = runtime.state.logicalPosition;
    expect(positionBeforeUnsafeFact?.x).toBeGreaterThan(0);
    expect(positionBeforeUnsafeFact?.y).toBe(460);
    expect(writes.length).toBeGreaterThan(writesBeforeTravel);
    expect(lifecycle).toEqual([]);

    runtime.handleInputAvoidanceFact({
      kind: "none",
      approximate: true,
      revision: 1,
    });
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "GO_HOME",
      homeCyclePhase: "GO_HOME",
      homePending: true,
      motionOwner: "AUTONOMOUS",
    });
    const pausedPosition = runtime.state.logicalPosition;
    const writesAfterPause = writes.length;
    const lifecycleAfterPause = lifecycle.length;

    clock.advanceBy(10_000);
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "GO_HOME",
      homeCyclePhase: "GO_HOME",
      homePending: true,
      logicalPosition: pausedPosition,
      motionOwner: "AUTONOMOUS",
    });
    expect(writes).toHaveLength(writesAfterPause);
    expect(lifecycle).toHaveLength(lifecycleAfterPause);
    expect(lifecycle).not.toContain("MAIN_FADE_OUT");
    expect(lifecycle).not.toContain("MAIN_HIDE");
    expect(lifecycle).not.toContain("MAIN_SHOW_NO_ACTIVATE");
    expect(lifecycle).not.toContain("MAIN_FADE_IN");
    expect(stateHistory.some((state) => state.homeCyclePhase === "REST")).toBe(
      false,
    );

    runtime.handleInputAvoidanceFact({
      kind: "none",
      approximate: false,
      revision: 2,
    });
    await flushPromises();

    expect(runtime.state).toMatchObject({
      behavior: "GO_HOME",
      homeCyclePhase: "GO_HOME",
      homePending: undefined,
      motionOwner: "AUTONOMOUS",
    });
    const positionBeforeResume = runtime.state.logicalPosition;
    const writesBeforeResume = writes.length;
    clock.advanceBy(HOME_CYCLE_TICK_MS + 1);
    await flushPromises();

    expect(runtime.state.behavior).toBe("GO_HOME");
    expect(runtime.state.homeCyclePhase).toBe("GO_HOME");
    expect(runtime.state.logicalPosition?.x).toBeGreaterThan(
      positionBeforeResume?.x ?? Number.NEGATIVE_INFINITY,
    );
    expect(runtime.state.logicalPosition?.y).toBe(460);
    expect(writes.length).toBeGreaterThan(writesBeforeResume);
    expect(lifecycle).toEqual([]);
    runtime.dispose();
  });

  it.each(["resolve", "reject"] as const)(
    "does not resurrect a Runtime avoidance resync that arrives late after dispose (%s)",
    async (lateOutcome) => {
      const clock = new ManualClock();
      const lateResync = deferred<MotionSnapshot | null>();
      const writes: WindowTopLeftLogical[] = [];
      const stateChanges: PetRuntimeState[] = [];
      const frames: string[] = [];
      let resyncCount = 0;
      const port: PetMotionPort = {
        resync: async () => {
          resyncCount += 1;
          return resyncCount === 1
            ? motionSnapshot("monitor-1", WORK_AREA, windowPosition(0, 440))
            : lateResync.promise;
        },
        writeWindowTopLeft: async (position) => {
          writes.push({ ...position });
        },
      };
      const runtime = new PetRuntime(TEST_RESOURCES, {
        clock,
        motionPort: port,
        random: () => 1,
        onStateChange: (state) => stateChanges.push({ ...state }),
        onFrame: (event) => frames.push(event.animationId),
      });
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandledRejections.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        await runtime.initialize(async () => undefined);
        await flushPromises();
        runtime.handleInputAvoidanceFact(
          activeFact(
            1,
            {
              left: 50,
              top: 50,
              right: 300,
              bottom: 300,
            },
            { monitorId: "monitor-2", monitorRevision: 1 },
          ),
        );
        await flushPromises();

        expect(resyncCount).toBe(2);
        const stateChangesBeforeDispose = stateChanges.length;
        const framesBeforeDispose = frames.length;
        runtime.dispose();
        const stateAfterDispose = runtime.state;
        const scheduledAfterDispose = clock.scheduledCount;
        const pendingTimersAfterDispose = clock.pendingTimerCount;
        const writesAfterDispose = writes.length;

        if (lateOutcome === "resolve") {
          lateResync.resolve(motionSnapshot("monitor-2", WORK_AREA, windowPosition(0, 440)));
        } else {
          lateResync.reject(new Error("late Runtime avoidance resync failure"));
        }
        await flushPromises();
        clock.advanceBy(10_000);
        await flushPromises();

        expect(unhandledRejections).toEqual([]);
        expect(runtime.state).toEqual(stateAfterDispose);
        expect(stateChanges).toHaveLength(stateChangesBeforeDispose);
        expect(frames).toHaveLength(framesBeforeDispose);
        expect(clock.scheduledCount).toBe(scheduledAfterDispose);
        expect(clock.pendingTimerCount).toBe(pendingTimersAfterDispose);
        expect(writes).toHaveLength(writesAfterDispose);
        expect(runtime.state.motionOwner).toBe("AUTONOMOUS");
        expect(runtime.state.escapePlanId).toBeUndefined();
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        runtime.dispose();
      }
    },
  );
});
