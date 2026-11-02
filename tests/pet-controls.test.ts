import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PetRuntime, type PetRuntimeDiagnostic } from "../src/pet-runtime";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import { AnimationTimeline, type TimelineClock } from "../src/animation-timeline";
import { PetBubbleController } from "../src/pet-bubble";
import { MotionCoordinator } from "../src/motion-coordinator";
import { restoreDesktopLayout } from "../src/pet-controls";
import { HomeProximityController } from "../src/home-proximity";
import type { MotionSnapshot, WindowTopLeftLogical } from "../src/native-motion";
import { NativePlatformAdapter, type NativeDesktopSnapshotV1 } from "../src/native-platform";
import { FocusedInputGeometryAdapter, type FocusedInputFact, type FocusedInputGeometryResponse } from "../src/input-avoidance";

class Clock implements TimelineClock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(id: unknown) { this.timers.delete(id as number); }
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}
const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(readFileSync("public/character/manifest.json", "utf8"))));
const area = { x: 0, y: 0, width: 1000, height: 600 };
const point = (x: number, y: number): WindowTopLeftLogical => ({ space: "WINDOW_TOP_LEFT_LOGICAL", x, y });
async function flush() { for (let n = 0; n < 8; n++) await Promise.resolve(); }
async function advance(clock: Clock, ms: number) {
  for (let left = ms; left > 0; left -= 20) { clock.advance(Math.min(left, 20)); await flush(); }
}
const actualHome = { ready: true, currentMonitorId: "screen", windowScaleFactor: 1,
  rect: { x: 720, y: 344, width: 256, height: 256 } };
async function setup(x = 100, y = 460, homeWindow: MotionSnapshot["homeWindow"] = actualHome, onDiagnostic?: (value: PetRuntimeDiagnostic) => void) {
  const clock = new Clock();
  let position = point(x, y);
  const writes: WindowTopLeftLogical[] = [];
  const snapshot = (): MotionSnapshot => ({ currentMonitorId: "screen", windowScaleFactor: 1, workArea: area, windowPosition: position, homeWindow });
  const runtime = new PetRuntime(resources, { clock, random: () => 1, homeRandom: () => 0, onDiagnostic,
    motionPort: { resync: async () => snapshot(), writeWindowTopLeft: async p => { position = p; writes.push(p); } } });
  await runtime.initialize(async () => undefined); await flush();
  return { runtime, clock, writes, snapshot };
}
async function inHome(onDiagnostic?: (value: PetRuntimeDiagnostic) => void) {
  const test = await setup(721, 300, actualHome, onDiagnostic);
  test.runtime.beginDrag(); await test.runtime.endDrag();
  for (let n = 0; n < 300 && test.runtime.state.behavior !== "REST"; n++) await advance(test.clock, 20);
  expect(test.runtime.state.behavior).toBe("REST");
  return test;
}

describe("1.1.0 native input adaptation and behavior recovery", () => {
  function connectInput(test: Awaited<ReturnType<typeof setup>>, initial: "error" | "none" | "blocked" = "error") {
    let mode: "error" | "none" | "blocked" | "busy" = initial;
    const adapter = new FocusedInputGeometryAdapter({ clock: test.clock,
      readDesktopSnapshot: async () => ({ ...test.snapshot(), protocolVersion: 1, snapshotRevision: 1,
        capturedAtMonotonicMs: test.clock.now(), monitorScaleFactor: 1 }),
      readFocusedInputSnapshot: async request => {
        const response: FocusedInputGeometryResponse = { ...request, kind: "none", rectPhysical: null,
          approximate: false, textFocus: false, activeCaret: false, singleVisualBand: false,
          caretEvidenceKind: "none", busy: mode === "busy" };
        if (mode === "error") return { ...response, kind: "error", errorCode: "uia-failure" };
        if (mode === "blocked") return { ...response, kind: "dynamic-line", textFocus: true,
          activeCaret: true, singleVisualBand: true, caretEvidenceKind: "provider-active",
          rectPhysical: { left: 0, top: 0, right: 1000, bottom: 600 } };
        return response;
      }, onFact: fact => test.runtime.handleInputAvoidanceFact(fact) });
    adapter.start();
    return { set: (value: typeof mode) => { mode = value; }, dispose: () => adapter.dispose() };
  }

  it.each([false, true])("trusted native none restores scheduling while respecting paused=%s", async paused => {
    const test = await setup(); const input = connectInput(test);
    await advance(test.clock, 12000);
    expect(test.runtime.diagnosticState.input_unknown).toBe(true);
    test.runtime.setAutonomyPaused(paused); input.set("none");
    await advance(test.clock, 250);
    expect(test.runtime.diagnosticState.input_unknown).toBe(false);
    if (paused) {
      const position = test.runtime.state.logicalPosition;
      await advance(test.clock, 9000);
      expect(test.runtime.diagnosticState.wait_reason).toBe("user_paused");
      expect(test.runtime.state.logicalPosition).toEqual(position);
      test.runtime.setAutonomyPaused(false);
    }
    await advance(test.clock, 9000);
    expect(test.runtime.state.behavior).toBe("WALK");
    input.dispose(); test.runtime.dispose();
  });

  it.each(["error", "blocked"] as const)("real adapter clears %s wake hold only after trusted native none", async reason => {
    const test = await inHome(); const input = connectInput(test, reason);
    await advance(test.clock, 124000);
    expect(test.runtime.diagnosticState.home_stage).toBe("SLEEP");
    await advance(test.clock, 12 * 60000);
    expect(test.runtime.diagnosticState).toMatchObject({ home_stage: "WAKE_HOLD",
      wait_reason: reason === "error" ? "input_unknown" : "input_blocked", home_pending: true });
    input.set("busy"); await advance(test.clock, 1000);
    expect(test.runtime.state.behavior).toBe("REST");
    input.set("none"); await advance(test.clock, 250);
    expect(test.runtime.state.behavior).toBe("LEAVE_HOME");
    await advance(test.clock, 2500);
    expect(test.runtime.diagnosticState).toMatchObject({ state: "IDLE", home_stage: "NONE", input_unknown: false });
    input.dispose(); test.runtime.dispose();
  });

  it("input recovery during paused sleep preserves its remaining departure time", async () => {
    const test = await inHome(); const input = connectInput(test);
    await advance(test.clock, 124000);
    const remaining = test.runtime.state.homeRestDeadlineMs! - test.clock.now();
    test.runtime.setAutonomyPaused(true); input.set("none");
    await advance(test.clock, 180000);
    expect(test.runtime.diagnosticState).toMatchObject({ home_stage: "SLEEP", paused: true, input_unknown: false });
    test.runtime.setAutonomyPaused(false);
    expect(test.runtime.state.homeRestDeadlineMs! - test.clock.now()).toBeCloseTo(remaining);
    await advance(test.clock, remaining + 5000);
    expect(test.runtime.diagnosticState.home_stage).toBe("NONE");
    input.dispose(); test.runtime.dispose();
  });

  it("completes a natural Home cycle with production resources and adapted native no-focus responses", async () => {
    const stages = new Set<string>();
    const test = await setup(100, 460, actualHome, diagnostic => stages.add(diagnostic.home_stage));
    const input = connectInput(test, "none");
    for (let i = 0; i < 1200 && !(stages.has("LEAVE_JUMP") && test.runtime.state.behavior === "IDLE"); i++) {
      await advance(test.clock, 1000);
    }
    expect([...stages]).toEqual(expect.arrayContaining(["APPROACH", "JUMP", "LAND", "AWAKE", "HOME_IDLE", "SLEEP", "WAKE_HOLD", "LEAVE_JUMP"]));
    expect(test.runtime.diagnosticState).toMatchObject({ state: "IDLE", home_stage: "NONE", input_unknown: false });
    input.dispose(); test.runtime.dispose();
  });
});

describe("behavior waiting diagnostics", () => {
  it("distinguishes unknown input from an explicit user pause and clears on recovery", async () => {
    const { runtime, clock } = await setup(400);
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: true, revision: 1 });
    await advance(clock, 12000);
    expect(runtime.diagnosticState).toMatchObject({ state: "IDLE", wait_reason: "input_unknown", paused: false, input_unknown: true });
    runtime.setAutonomyPaused(true);
    expect(runtime.diagnosticState.wait_reason).toBe("user_paused");
    runtime.setAutonomyPaused(false);
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 2 });
    await advance(clock, 9000);
    expect(runtime.diagnosticState).toMatchObject({ state: "WALK", wait_reason: "none", input_unknown: false });
    runtime.dispose();
  });

  it("explains a long REST as awake, sleep, then input-blocked wake hold without changing policy", async () => {
    const diagnostics: PetRuntimeDiagnostic[] = [];
    const { runtime, clock } = await inHome(value => diagnostics.push(value));
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: true, revision: 1 });
    expect(runtime.diagnosticState).toMatchObject({ home_stage: "AWAKE", wait_reason: "home_awake_window" });
    await advance(clock, 124000);
    expect(runtime.diagnosticState).toMatchObject({ home_stage: "SLEEP", wait_reason: "home_sleep", input_unknown: true });
    await advance(clock, 12 * 60000);
    expect(runtime.diagnosticState).toMatchObject({ state: "REST", home_stage: "WAKE_HOLD", wait_reason: "input_unknown", home_pending: true, paused: false });
    expect(diagnostics.map(row => row.home_stage)).toEqual(expect.arrayContaining(["AWAKE", "HOME_IDLE", "SLEEP", "WAKE_HOLD"]));
    expect(diagnostics.at(-1)).toEqual(runtime.diagnosticState);
    expect(diagnostics.length).toBeLessThan(30);
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 2 });
    await advance(clock, 2500);
    expect(runtime.state.behavior).toBe("IDLE");
    expect(runtime.diagnosticState.home_stage).toBe("NONE");
    expect(diagnostics.at(-1)).toEqual(runtime.diagnosticState);
    runtime.dispose();
  });

  it("identifies an obstructed exit separately from unavailable input facts", async () => {
    const { runtime, clock } = await inHome();
    runtime.handleInputAvoidanceFact({ kind: "dynamic-line", approximate: false, revision: 1,
      monitorId: "screen", monitorRevision: 1, workArea: area, forbiddenRegion: { left: 0, right: 1000, top: 0, bottom: 600 } });
    await advance(clock, 220000);
    expect(runtime.diagnosticState).toMatchObject({ home_stage: "WAKE_HOLD", wait_reason: "input_blocked", input_unknown: false, input_blocked: true });
    runtime.dispose();
  });

  it("coalesces updates and logs settled reasons only once for unchanged input facts", async () => {
    const clock = new Clock();
    const diagnostics: PetRuntimeDiagnostic[] = [];
    const runtime = new PetRuntime(resources, { clock, onDiagnostic: value => diagnostics.push(value) });
    await runtime.initialize(async () => undefined); await flush();
    diagnostics.length = 0;
    for (let revision = 1; revision <= 100; revision++) {
      runtime.handleInputAvoidanceFact({ kind: "none", approximate: true, revision });
      await flush();
    }
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ wait_reason: "input_unknown", input_unknown: true });
    runtime.dispose();
  });

  it("diagnostic consumer failures never stop behavior or leak a late callback after dispose", async () => {
    const clock = new Clock(); let calls = 0;
    const runtime = new PetRuntime(resources, { clock, random: () => 1,
      onDiagnostic: () => { calls++; throw new Error("diagnostic sink unavailable"); } });
    await runtime.initialize(async () => undefined); await flush();
    expect(calls).toBeGreaterThan(0);
    expect(runtime.state.readiness).toBe("ready");
    const before = calls;
    runtime.setAutonomyPaused(true); runtime.dispose(); await flush();
    expect(calls).toBe(before);
  });
});

describe("1.0.0 runtime controls", () => {
  it("cross-screen drag does not land on a fictional Home on the second screen", async () => {
    const clock = new Clock(); let currentArea = area; let monitor = "screen"; let position = point(721, 300);
    const runtime = new PetRuntime(resources, { clock, random: () => 1, motionPort: {
      resync: async () => ({ currentMonitorId: monitor, windowScaleFactor: 1, workArea: currentArea, windowPosition: position, homeWindow: actualHome }),
      writeWindowTopLeft: async p => { position = p; },
    } });
    await runtime.initialize(async () => undefined);
    runtime.beginDrag(); await flush();
    currentArea = { ...area, x: 1000 }; monitor = "second"; position = point(1721, 300);
    runtime.movePointerDrag(position, monitor, currentArea); await flush();
    await runtime.endDrag(); await advance(clock, 2500);
    expect(runtime.state).toMatchObject({ behavior: "IDLE", logicalPosition: { x: 1721, y: 460 } });
    expect(runtime.state.homeCyclePhase).toBeUndefined(); runtime.dispose();
  });

  it.each([null, { ...actualHome, ready: false }, { ...actualHome, windowScaleFactor: 1.5 }])(
    "unavailable or unsettled Home cannot support a fall: %j", async home => {
      const { runtime, clock } = await setup(721, 300, home);
      runtime.beginDrag(); await runtime.endDrag(); await advance(clock, 2500);
      expect(runtime.state).toMatchObject({ behavior: "IDLE", logicalPosition: { y: 460 } });
      runtime.dispose();
    },
  );

  it("Home entry uses its actual same-screen rectangle rather than its default placement", async () => {
    const { runtime, clock } = await setup(621, 300, { ...actualHome, rect: { ...actualHome.rect, x: 620, y: 324 } });
    runtime.beginDrag(); await runtime.endDrag(); await advance(clock, 2500);
    expect(runtime.state).toMatchObject({ behavior: "REST", logicalPosition: { x: 621, y: 372 } });
    runtime.dispose();
  });

  it("a lost Home invalidates resting callbacks and a late snapshot cannot restore its support", async () => {
    const { runtime, clock, snapshot } = await inHome();
    const oldCallbacks = [...clock.timers.values()].map(t => t.callback);
    runtime.handleDesktopSnapshot({ ...snapshot(), snapshotRevision: 3, homeWindow: null });
    runtime.handleDesktopSnapshot({ ...snapshot(), snapshotRevision: 2 });
    oldCallbacks.forEach(callback => callback()); await advance(clock, 2000);
    expect(runtime.state).toMatchObject({ behavior: "IDLE", logicalPosition: { y: 460 } });
    expect(runtime.state.homeCyclePhase).toBeUndefined(); runtime.dispose();
  });

  it("Home becoming ready after Main startup enables real Home entry", async () => {
    const { runtime, snapshot } = await setup(400, 460, null);
    expect(runtime.state.homeWalkTargetX).toBeUndefined();
    runtime.handleDesktopSnapshot({ ...snapshot(), snapshotRevision: 2, homeWindow: actualHome });
    expect(runtime.state.homeWalkTargetX).toBe(512); runtime.dispose();
  });

  const inputFact = (revision: number, left = 380, right = 600, monitorId = "screen"): FocusedInputFact => ({
    kind: "dynamic-line", approximate: false, revision, monitorId, workArea: area,
    monitorRevision: 1, focusSessionId: "paused-input",
    forbiddenRegion: { left, right, top: 400, bottom: 600 },
  });

  it("pause keeps fresh input facts without moving and resume recomputes the latest safe side", async () => {
    const { runtime, clock, writes } = await setup(400);
    runtime.setAutonomyPaused(true); await flush();
    const count = writes.length;
    runtime.handleInputAvoidanceFact(inputFact(1));
    await advance(clock, 2000);
    expect(runtime.state).toMatchObject({ behavior: "IDLE", autonomyPaused: true, logicalPosition: { x: 400 } });
    expect(writes).toHaveLength(count);
    runtime.handleInputAvoidanceFact(inputFact(2, 150, 500));
    await flush();
    runtime.setAutonomyPaused(false); await advance(clock, 1000);
    expect(runtime.state.logicalPosition!.x).toBeGreaterThan(400);
    expect(runtime.state.inputAvoidanceFactRevision).toBe(2);
    runtime.dispose();
  });

  it("pausing an input escape clears its target and later facts cannot restart it", async () => {
    const { runtime, clock, writes } = await setup(400);
    runtime.handleInputAvoidanceFact(inputFact(1)); await advance(clock, 800);
    expect(runtime.state.escapePlanId).toBeDefined();
    runtime.setAutonomyPaused(true); await flush();
    const position = runtime.state.logicalPosition;
    const count = writes.length;
    runtime.handleInputAvoidanceFact(inputFact(2)); await advance(clock, 2000);
    expect(runtime.state.escapePlanId).toBeUndefined();
    expect(runtime.state.logicalPosition).toEqual(position);
    expect(writes).toHaveLength(count);
    runtime.dispose();
  });

  it("pause/resume invalidates an in-flight input resync and starts a fresh read", async () => {
    const clock = new Clock(); let reads = 0; let release!: (s: MotionSnapshot) => void;
    const initial: MotionSnapshot = { currentMonitorId: "screen", windowScaleFactor: 1, workArea: area, windowPosition: point(400, 460) };
    const runtime = new PetRuntime(resources, { clock, random: () => 1, motionPort: {
      resync: () => ++reads === 2 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(initial),
      writeWindowTopLeft: async () => undefined,
    } });
    await runtime.initialize(async () => undefined);
    runtime.handleInputAvoidanceFact(inputFact(1, 380, 600, "other")); await flush();
    expect(reads).toBe(2);
    runtime.setAutonomyPaused(true); runtime.setAutonomyPaused(false); await flush();
    expect(reads).toBe(3);
    release({ ...initial, currentMonitorId: "other" }); await advance(clock, 1000);
    expect(runtime.state).toMatchObject({ behavior: "IDLE", currentMonitorId: "screen", logicalPosition: { x: 400 } });
    expect(runtime.state.escapePlanId).toBeUndefined(); runtime.dispose();
  });

  it("resume with no safe input-avoidance side stays stopped", async () => {
    const { runtime, clock } = await setup(400);
    runtime.setAutonomyPaused(true);
    runtime.handleInputAvoidanceFact(inputFact(1, 0, 1000)); await flush();
    runtime.setAutonomyPaused(false); await advance(clock, 12000);
    expect(runtime.state).toMatchObject({ behavior: "IDLE", logicalPosition: { x: 400 } });
    expect(runtime.state.escapePlanId).toBeUndefined(); runtime.dispose();
  });

  it("resume waits for unknown input safety to clear before autonomous walking", async () => {
    const { runtime, clock } = await setup(400);
    runtime.setAutonomyPaused(true);
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: true, revision: 1 });
    runtime.setAutonomyPaused(false); await advance(clock, 12000);
    expect(runtime.state).toMatchObject({ behavior: "IDLE", logicalPosition: { x: 400 } });
    runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 2 });
    await advance(clock, 9000); expect(runtime.state.behavior).toBe("WALK"); runtime.dispose();
  });

  it("pauses approach, lets an already committed jump land and keeps manual home entry", async () => {
    const { runtime, clock } = await setup(512, 460);
    for (let n = 0; n < 30000 && runtime.state.homeCyclePhase !== "GO_HOME"; n++) await advance(clock, 20);
    expect(runtime.state.homeCyclePhase).toBe("GO_HOME");
    runtime.setAutonomyPaused(true); await flush();
    const position = runtime.state.logicalPosition;
    await advance(clock, 10000); expect(runtime.state.logicalPosition).toEqual(position);
    expect(runtime.state.activeAnimationId).toBe("idle");
    runtime.setAutonomyPaused(false);
    for (let n = 0; n < 200 && runtime.state.activeAnimationId !== "jump_air"; n++) await advance(clock, 20);
    expect(runtime.state.activeAnimationId).toBe("jump_air");
    runtime.setAutonomyPaused(true); await advance(clock, 2500);
    expect(runtime.state.behavior).toBe("REST");
    runtime.beginDrag(); runtime.movePointerDrag({ x: 721, y: 300 }, "screen", area); await flush();
    await runtime.endDrag(); await advance(clock, 2500);
    expect(runtime.state).toMatchObject({ behavior: "REST", autonomyPaused: true }); runtime.dispose();
  });

  it("pause during wake hold waits and resume restarts the full hold", async () => {
    const { runtime, clock } = await inHome();
    await advance(clock, 124000);
    await advance(clock, runtime.state.homeRestDeadlineMs! - clock.now());
    expect(runtime.state.activeAnimationId).toBe("home_idle");
    runtime.setAutonomyPaused(true); await advance(clock, 10000);
    expect(runtime.state.behavior).toBe("REST");
    runtime.setAutonomyPaused(false); await advance(clock, 100);
    expect(runtime.state.behavior).toBe("REST");
    await advance(clock, 2500); expect(runtime.state.behavior).toBe("IDLE"); runtime.dispose();
  });

  it("rapid pause/resume invalidates a pending walk rather than replaying it", async () => {
    const clock = new Clock(); let count = 0; let release!: (s: MotionSnapshot) => void;
    const snap = { currentMonitorId: "screen", windowScaleFactor: 1, workArea: area, windowPosition: point(100, 460) };
    const runtime = new PetRuntime(resources, { clock, random: () => 1,
      motionPort: { resync: () => ++count === 2 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(snap),
        writeWindowTopLeft: async () => undefined } });
    await runtime.initialize(async () => undefined); await advance(clock, 8000);
    runtime.setAutonomyPaused(true); runtime.setAutonomyPaused(false); release(snap); await flush();
    expect(runtime.state.behavior).toBe("IDLE"); await advance(clock, 1000);
    expect(runtime.state.behavior).toBe("IDLE"); runtime.dispose();
  });

  it("stops a ground walk and stays paused after Happy, Look and drag/fall", async () => {
    const { runtime, clock } = await setup();
    await advance(clock, 9000);
    expect(runtime.state.behavior).toBe("WALK");
    runtime.setAutonomyPaused(true); await flush();
    const position = runtime.state.logicalPosition;
    await advance(clock, 200);
    expect(runtime.state.logicalPosition).toEqual(position);
    expect(runtime.state.behavior).toBe("IDLE");
    expect(runtime.triggerHappy()).toBe(true);
    await advance(clock, 3000);
    runtime.handlePointerSample({ x: 80, y: 80 });
    expect(runtime.state.behavior).toBe("LOOK");
    runtime.handlePointerSample({ x: -1000, y: -1000 });
    await advance(clock, 1000);
    runtime.beginDrag(); runtime.movePointerDrag({ x: 100, y: 200 }, "screen", area); await flush();
    await runtime.endDrag(); await advance(clock, 3000);
    expect(runtime.state.behavior).toBe("IDLE");
    await advance(clock, 20000);
    expect(runtime.state.behavior).toBe("IDLE");
    runtime.setAutonomyPaused(false); await advance(clock, 9000);
    expect(runtime.state.behavior).toBe("WALK"); runtime.dispose();
  });

  it("paused before a pending walk snapshot prevents late autonomous start", async () => {
    const clock = new Clock(); let count = 0; let release!: (s: MotionSnapshot) => void;
    const snap = { currentMonitorId: "screen", windowScaleFactor: 1, workArea: area, windowPosition: point(100, 460) };
    const runtime = new PetRuntime(resources, { clock, random: () => 1,
      motionPort: { resync: () => ++count === 1 ? Promise.resolve(snap) : new Promise(resolve => { release = resolve; }),
        writeWindowTopLeft: async () => undefined } });
    await runtime.initialize(async () => undefined); await advance(clock, 8000);
    runtime.setAutonomyPaused(true); release(snap); await flush();
    await advance(clock, 30000); expect(runtime.state.behavior).toBe("IDLE"); runtime.dispose();
  });

  it("sleep entered while paused starts its departure clock only on resume", async () => {
    const { runtime, clock } = await inHome();
    runtime.setAutonomyPaused(true);
    await advance(clock, 124000);
    expect(runtime.state.activeAnimationId).toBe("sleep");
    expect(runtime.state.homeRestDeadlineMs).toBeUndefined();
    await advance(clock, 100000); expect(runtime.state.behavior).toBe("REST");
    runtime.setAutonomyPaused(false);
    expect(runtime.state.homeRestDeadlineMs! - clock.now()).toBeGreaterThanOrEqual(30000);
    await advance(clock, 10000);
    const remaining = runtime.state.homeRestDeadlineMs! - clock.now();
    runtime.setAutonomyPaused(true); await advance(clock, 100000);
    runtime.setAutonomyPaused(false);
    expect(runtime.state.homeRestDeadlineMs! - clock.now()).toBe(remaining);
    await advance(clock, remaining + 2500);
    expect(runtime.state.behavior).toBe("IDLE"); runtime.dispose();
  });

  it("paused sleep remains interactive and clicking wakes in the same home", async () => {
    const { runtime, clock } = await inHome();
    runtime.setAutonomyPaused(true); await advance(clock, 124000);
    expect(runtime.triggerHappy()).toBe(true); await advance(clock, 3000);
    expect(runtime.state.behavior).toBe("REST");
    expect(runtime.state.autonomyPaused).toBe(true);
    expect(runtime.state.homeAwakeStartedAtMs).toBeGreaterThan(120000);
    expect(runtime.state.homeRestDeadlineMs).toBeUndefined(); runtime.dispose();
  });

  it("restores out of REST, retains pause, invalidates callbacks, and handles failure/retry", async () => {
    const { runtime, clock, snapshot } = await inHome();
    runtime.setAutonomyPaused(true);
    const old = [...clock.timers.values()].map(t => t.callback);
    let release!: (value: MotionSnapshot) => void;
    const pending = runtime.restoreDefaultPosition(() => new Promise(resolve => { release = resolve; }));
    await flush(); expect(runtime.canRestorePosition).toBe(false);
    expect(runtime.beginDrag()).toBe(false);
    expect(await runtime.restoreDefaultPosition(async () => snapshot())).toBe(false);
    release({ ...snapshot(), windowPosition: point(420, 460) });
    expect(await pending).toBe(true);
    const saved = runtime.state; old.forEach(callback => callback()); await flush();
    expect(runtime.state).toEqual(saved);
    expect(runtime.state).toMatchObject({ behavior: "IDLE", autonomyPaused: true, restoreStatus: "idle" });
    expect(await runtime.restoreDefaultPosition(async () => { throw Error("write failed"); })).toBe(false);
    expect(runtime.state.restoreStatus).toBe("failed");
    expect(runtime.canRestorePosition).toBe(true);
    runtime.setAutonomyPaused(false); await advance(clock, 30000);
    expect(runtime.state.behavior).toBe("IDLE");
    expect(await runtime.restoreDefaultPosition(async () => snapshot())).toBe(true);
    runtime.dispose();
  });

  it("rejects restore during an active drag and Happy", async () => {
    const { runtime } = await setup();
    runtime.triggerHappy(); expect(runtime.canRestorePosition).toBe(false);
    runtime.beginDrag(); expect(runtime.canRestorePosition).toBe(false); runtime.dispose();
  });

  it("DPI readback rejection leaves Runtime stopped until an explicit settled retry", async () => {
    const { runtime, clock, writes, snapshot } = await setup();
    runtime.setAutonomyPaused(true);
    expect(await runtime.restoreDefaultPosition(async () => { throw Error("layout_readback_mismatch"); })).toBe(false);
    expect(runtime.state.restoreStatus).toBe("failed");
    expect(runtime.canRestorePosition).toBe(true);
    await flush(); const count = writes.length;
    runtime.setAutonomyPaused(false); await advance(clock, 30000);
    expect(writes.length).toBe(count); expect(runtime.state.behavior).toBe("IDLE");
    const settled = { ...snapshot(), windowScaleFactor: 1.5, windowPosition: point(420, 460) };
    expect(await runtime.restoreDefaultPosition(async () => settled)).toBe(true);
    expect(runtime.state.restoreStatus).toBe("idle");
    await advance(clock, 9000); expect(runtime.state.behavior).toBe("WALK");
    runtime.dispose();
  });

  it("quiesce waits for sent native motion and drops queued/stale writes", async () => {
    let finish!: () => void; const writes: number[] = [];
    const coordinator = new MotionCoordinator(async command => {
      writes.push(command.windowTopLeft.x); await new Promise<void>(resolve => { finish = resolve; });
    });
    const lease = coordinator.invalidateAndAcquire("AUTONOMOUS", point(1, 1));
    coordinator.request(lease, point(2, 2)); let drained = false;
    const stop = coordinator.quiesce().then(() => { drained = true; });
    await flush(); expect(drained).toBe(false);
    coordinator.request(lease, point(3, 3)); finish(); await stop; await flush();
    expect(writes).toEqual([1]); coordinator.dispose();
  });
});

describe("bubble presentation", () => {
  it("brief eligibility recovery discards the opportunity without resetting user inactivity", () => {
    const clock = new Clock(); let text = "";
    const bubble = new PetBubbleController(value => { text = value; }, clock, () => 0);
    bubble.update(true, false);
    clock.advance(290000); bubble.update(false, false);
    clock.advance(9000); bubble.update(true, false);
    bubble.update(true, false); // Repeated pointer samples do not restart the wait.
    clock.advance(1000); expect(text).toBe("");
    clock.advance(479999); expect(text).toBe("");
    clock.advance(1); expect(text).toBe("我在这里呀");
    bubble.dispose();
  });
  it.each([0, 1])("blocked opportunities keep one random schedule at endpoint %s without replay", random => {
    const clock = new Clock(); let text = "";
    const bubble = new PetBubbleController(value => { text = value; }, clock, () => random);
    bubble.update(true, false); clock.advance(300000); expect(text).not.toBe("");
    bubble.update(false, true); expect(text).toBe("");
    const delay = 480000 + random * 240000;
    clock.advance(delay); expect(text).toBe("");
    expect(clock.timers.size).toBe(1);
    bubble.update(true, false);
    clock.advance(delay - 1); expect(text).toBe("");
    clock.advance(1); expect(text).not.toBe("");
    bubble.setEnabled(false); bubble.update(false, true); bubble.update(true, false);
    clock.advance(1_000_000); expect(text).toBe(""); expect(clock.timers.size).toBe(0);
    bubble.dispose();
  });
  it("ordinary motion does not erase five minutes without user activity", () => {
    const clock = new Clock(); const shown: string[] = [];
    const bubble = new PetBubbleController(text => { if (text) shown.push(text); }, clock, () => 0);
    bubble.update(true, false);
    for (let n = 0; n < 29; n++) {
      clock.advance(8000); bubble.update(false, true);
      clock.advance(2000); bubble.update(true, false);
    }
    clock.advance(10000); expect(shown).toEqual(["我在这里呀"]);
    bubble.activity(); clock.advance(299999); expect(shown).toHaveLength(1);
    clock.advance(1); expect(shown).toHaveLength(2); bubble.dispose();
  });
  it("real Runtime walk and Home cycles still allow idle prompts without user activity", async () => {
    const clock = new Clock(); const shown: {at:number;text:string}[] = [];
    const bubble = new PetBubbleController(text => { if(text) shown.push({at:clock.now(),text}); }, clock, () => 0);
    let runtime: PetRuntime | undefined; let position = point(100, 460);
    const behaviors = new Set<string>();
    runtime = new PetRuntime(resources, {clock, random:()=>1, homeRandom:()=>0,
      motionPort:{resync:async()=>({currentMonitorId:"screen",windowScaleFactor:1,workArea:area,windowPosition:position,homeWindow:actualHome}),
        writeWindowTopLeft:async p=>{position=p;}},
      onInteractionResponse: response => bubble.respond(response),
      onStateChange:state=>{
        behaviors.add(state.behavior);
        bubble.update(!!runtime?.canShowIdleBubble,["DRAG","FALL","LAND","GO_HOME","LEAVE_HOME"].includes(state.behavior));
      }});
    await runtime.initialize(async()=>undefined); await advance(clock,1800000);
    expect(behaviors.has("WALK")).toBe(true); expect(behaviors.has("REST")).toBe(true);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown[0].at).toBeGreaterThanOrEqual(300000);
    for(let n=1;n<shown.length;n++) expect(shown[n].at-shown[n-1].at).toBeGreaterThanOrEqual(480000);
    const count=shown.length; runtime.setAutonomyPaused(true); await advance(clock,900000);
    expect(shown).toHaveLength(count);
    const wasSleeping = runtime.state.activeAnimationId === "sleep";
    expect(runtime.beginPointerGesture()).toBe(true);
    expect(await runtime.endPointerGesture({ triggerHappy: true })).toBe(true);
    expect(shown.at(-1)?.text).toBe(wasSleeping ? "嗯，我醒啦" : "窝里真舒服");
    bubble.control(true); expect(shown.at(-1)?.text).toBe("我安静一会");
    runtime.dispose(); bubble.dispose();
  });
  it("click cooldown, control replacement and disable cancel all pending display", () => {
    const clock = new Clock(); let text = "";
    const bubble = new PetBubbleController(value => { text = value; }, clock, () => 0);
    bubble.click(); const first = text; expect(text).toBe("摸摸头");
    clock.advance(3000); bubble.click(); expect(text).toBe("");
    clock.advance(12000); bubble.click(); expect(text).not.toBe(first);
    bubble.control(true); expect(text).toBe("我安静一会");
    bubble.setEnabled(false); clock.advance(1_000_000); expect(text).toBe("");
    expect(clock.timers.size).toBe(0); bubble.dispose();
  });
  it("idle prompt waits five minutes, discards blocked opportunities and does not repeat", () => {
    const clock = new Clock(); let text = "";
    const bubble = new PetBubbleController(value => { text = value; }, clock, () => 0);
    bubble.update(true, false); clock.advance(299999); expect(text).toBe("");
    clock.advance(1); const first = text; expect(first).toBe("我在这里呀");
    bubble.update(false, true); expect(text).toBe("");
    clock.advance(480000); bubble.update(true, false); expect(text).toBe("");
    clock.advance(480000); expect(text).toBe("伸个懒腰吧");
    bubble.activity(); clock.advance(3000); clock.advance(296999); expect(text).toBe("");
    clock.advance(1); expect(text).toBe("我在这里呀"); bubble.dispose();
  });
  it("home hit region can be replaced and old fading is cancelled", () => {
    const clock = new Clock(); const opacity: number[] = [];
    const home = new HomeProximityController({ clock, rect: { x: 700, y: 400, width: 256, height: 256 }, applyOpacity: v => { opacity.push(v); } });
    home.handlePointerSample({ x: 710, y: 410 }); clock.advance(100);
    home.updateRect({ x: -1000, y: 0, width: 256, height: 256 }); clock.advance(500);
    expect(opacity.at(-1)).toBe(1);
    home.handlePointerSample({ x: 710, y: 410 }); expect(home.currentTarget).toBe("opaque");
    home.handlePointerSample({ x: -990, y: 10 }); clock.advance(500);
    expect(home.currentTarget).toBe("translucent"); home.dispose();
  });
});

describe("existing animation completion", () => {
  it.each(["turn", "happy", "land", "homeLand", "homeIdle"] as const)("%s displays its last frame for its full duration exactly once", id => {
    const clock = new Clock(); const timeline = new AnimationTimeline(clock);
    const animation = resources[id]; let completed = 0; let frame = -1;
    timeline.play(animation, { onFrame: e => { frame = e.frameIndex; }, onComplete: () => { completed++; } });
    const duration = animation.frames.reduce((sum, f) => sum + f.durationMs, 0);
    clock.advance(duration - 1); expect(frame).toBe(animation.frames.length - 1); expect(completed).toBe(0);
    clock.advance(1); expect(completed).toBe(1); clock.advance(10000); expect(completed).toBe(1);
  });
  it("reentrant interruption during frame delivery leaves no orphan timer", () => {
    const clock = new Clock(); const timeline = new AnimationTimeline(clock); let completed = 0;
    timeline.play(resources.happy, { onFrame: () => timeline.stop(), onComplete: () => completed++ });
    expect(clock.timers.size).toBe(0); clock.advance(10000); expect(completed).toBe(0);
  });
});

describe("native layout boundary", () => {
  it.each([null, { ...actualHome, currentMonitorId: "elsewhere" }, { ...actualHome, rect: { ...actualHome.rect, x: 700 } }])(
    "a successful move command does not substitute for actual Home readback: %j", async home => {
      let pos = point(100, 460); let revision = 0;
      const platform = new NativePlatformAdapter(async (command, args) => {
        if (command === "desktop_snapshot") return { protocolVersion: "linedog.native/v1", snapshotRevision: ++revision,
          capturedAtMonotonicMs: 0, currentMonitorId: "screen", windowScaleFactor: 1, monitorScaleFactor: 1,
          workArea: area, windowPosition: pos, homeWindow: home };
        if (command === "set_overlay_frame") {
          const a = args as { windowLabel: string; x: number; y: number };
          if (a.windowLabel === "main") pos = point(a.x, a.y);
        }
      });
      await expect(restoreDesktopLayout(platform, () => undefined)).rejects.toThrow("layout_home_readback_mismatch");
    },
  );
  it.each(["unsettled", "settled", "monitor-changed", "work-area-changed"])("checks DPI and desktop facts before returning success: %s", async scenario => {
    let reads = 0; let pos = point(100, 200); const rects: unknown[] = [];
    const frames: string[] = [];
    const platform = new NativePlatformAdapter(async (command, args) => {
      if (command === "desktop_snapshot") {
        reads++;
        const windowScale = reads === 1 || scenario === "unsettled" ? 1 : 1.5;
        return { protocolVersion: "linedog.native/v1", snapshotRevision: reads, capturedAtMonotonicMs: 0,
          currentMonitorId: "target", windowScaleFactor: windowScale,
          monitorScaleFactor: reads > 1 && scenario === "monitor-changed" ? 2 : 1.5,
          homeWindow: { ...actualHome, currentMonitorId: "target", windowScaleFactor: 1.5,
            rect: { x: 720 * 1.5 / windowScale, y: 344 * 1.5 / windowScale, width: 256 * 1.5 / windowScale, height: 256 * 1.5 / windowScale } },
          workArea: reads > 1 && scenario === "work-area-changed" ? { ...area, height: 580 } :
            { x: area.x * 1.5 / windowScale, y: area.y * 1.5 / windowScale,
              width: area.width * 1.5 / windowScale, height: area.height * 1.5 / windowScale },
          windowPosition: point(pos.x / windowScale, pos.y / windowScale) };
      }
      if (command === "pointer_snapshot") return { protocolVersion: "linedog.native/v1", snapshotRevision: 1, capturedAtMonotonicMs: 0,
        cursorScreenLogical: { x: 0, y: 0 }, windowOuterTopLeftLogical: { x: 0, y: 0 }, relativeLogical: { x: 0, y: 0 }, scaleFactor: 1 };
      if (command === "set_overlay_frame") {
        const a = args as { windowLabel: string; x: number; y: number; coordinateScaleFactor: number };
        frames.push(a.windowLabel);
        if (a.windowLabel === "main") pos = point(a.x * a.coordinateScaleFactor, a.y * a.coordinateScaleFactor);
        return;
      }
      throw Error(command);
    });
    const restoring = restoreDesktopLayout(platform, rect => rects.push(rect));
    if (scenario === "settled") {
      const result = await restoring;
      expect(result.windowScaleFactor).toBe(1.5);
      expect(result.windowPosition).toEqual(point(420, 460));
      expect(rects.at(-1)).toEqual({ x: 720, y: 344, width: 256, height: 256 });
    } else {
      await expect(restoring).rejects.toThrow("layout_readback_mismatch");
      expect(rects.at(-1)).toBeUndefined();
    }
    expect(reads).toBe(2); expect(frames).toEqual(["home", "main"]);
  });
  it("partial Home/Main failure is surfaced without automatically retrying", async () => {
    const writes: string[] = [];
    const platform = new NativePlatformAdapter(async (command, args) => {
      if (command === "desktop_snapshot") return { protocolVersion: "linedog.native/v1", snapshotRevision: 1, capturedAtMonotonicMs: 0,
        currentMonitorId: "target", windowScaleFactor: 1, monitorScaleFactor: 1, homeWindow: null, workArea: area, windowPosition: point(100, 460) };
      if (command === "pointer_snapshot") return { protocolVersion: "linedog.native/v1", snapshotRevision: 1, capturedAtMonotonicMs: 0,
        cursorScreenLogical: { x: 0, y: 0 }, windowOuterTopLeftLogical: { x: 0, y: 0 }, relativeLogical: { x: 0, y: 0 }, scaleFactor: 1 };
      const label = (args as { windowLabel: string }).windowLabel; writes.push(label);
      if (label === "main") throw Error("native failure");
    });
    await expect(restoreDesktopLayout(platform, () => undefined)).rejects.toThrow("native failure");
    expect(writes).toEqual(["home", "main"]);
  });
  it.each([1, 1.5, 2])("restores both surfaces on negative-coordinate target at scale %s", async scale => {
    const target = { x: -1000, y: -100, width: 1000, height: 600 };
    let pos = point(-850, 100); const writes: unknown[] = []; const homeRects: unknown[] = [];
    const snapshot = (): NativeDesktopSnapshotV1 => ({ protocolVersion: "linedog.native/v1", snapshotRevision: 1, capturedAtMonotonicMs: 0,
      currentMonitorId: "target", windowScaleFactor: scale, monitorScaleFactor: scale, workArea: target, windowPosition: pos,
      homeWindow: { ready: true, currentMonitorId: "target", windowScaleFactor: scale, rect: { x: -280, y: 244, width: 256, height: 256 } } });
    const platform = new NativePlatformAdapter(async (command, args) => {
      if (command === "desktop_snapshot") return snapshot();
      if (command === "pointer_snapshot") return { protocolVersion: "linedog.native/v1", snapshotRevision: 1, capturedAtMonotonicMs: 0,
        cursorScreenLogical: { x: 0, y: 0 }, windowOuterTopLeftLogical: pos, relativeLogical: { x: 0, y: 0 }, scaleFactor: scale };
      if (command === "set_overlay_frame") {
        writes.push(args); const a = args as { windowLabel: string; x: number; y: number };
        if (a.windowLabel === "main") pos = point(a.x, a.y); return;
      }
      throw Error(command);
    });
    const result = await restoreDesktopLayout(platform, r => homeRects.push(r));
    expect(writes).toEqual([
      { windowLabel: "home", x: -280, y: 244, width: 256, height: 256, coordinateScaleFactor: scale },
      { windowLabel: "main", x: -580, y: 360, width: 160, height: 160, coordinateScaleFactor: scale },
    ]);
    expect(result.windowPosition).toEqual(point(-580, 360)); expect(homeRects.at(-1)).toMatchObject({ x: -280, y: 244 });
  });
});
