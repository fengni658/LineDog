import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TimelineClock } from "../src/animation-timeline";
import { createCurrentWorkAreaSnapshot, createMotionSnapshot, type CurrentWorkAreaSnapshot, type MotionSnapshot, type PetMotionPort } from "../src/native-motion";
import { NATIVE_PLATFORM_PROTOCOL_VERSION, type NativePlatformPort, type NativeSetOverlayFrameArgs, type NativeSetOverlayPositionArgs } from "../src/native-platform";
import { ParachuteViewportAdapter } from "../src/parachute-viewport";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import { PetRuntime } from "../src/pet-runtime";
import { DRAG_START_THRESHOLD_LOGICAL_PX, PointerGestureController, type PointerGestureEnd } from "../src/pointer-gesture";

// These tests deliberately reuse one Runtime/controller/viewport for every round.
// Only the native OS boundary is simulated. No private Runtime state is edited.
const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(
  readFileSync(new URL("../public/character/manifest.json", import.meta.url), "utf8"),
)));
const AREA = { x: 0, y: 0, width: 800, height: 1_000 };
const outcomes: PointerGestureEnd[] = ["pointerup", "pointercancel", "lostpointercapture"];
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
class Clock implements TimelineClock {
  time = 0;
  private id = 0;
  private timers = new Map<number, { due: number; callback: () => void }>();
  now() { return this.time; }
  get pendingTimerCount() { return this.timers.size; }
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.id;
    this.timers.set(id, { due: this.time + delay, callback });
    return id;
  }
  clearTimeout(id: unknown) { this.timers.delete(id as number); }
  step(ms: number) {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due <= this.time) { this.timers.delete(id); timer.callback(); }
    }
  }
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve, entered: false };
}
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 0x1_0000_0000; };
}
type Evidence = { name: string; seed?: number; rounds?: number; status: string; failure?: string;
  operations: Array<Record<string, unknown>>; releases: Array<Record<string, unknown>>; final?: Record<string, unknown> };
const evidence: Evidence[] = [];
afterAll(() => {
  const output = process.env.LINEDOG_STRESS_REPORT;
  if (!output) return;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({
    evidenceLayer: "Real PetRuntime + PointerGestureController + ParachuteViewportAdapter; simulated native OS callbacks, not Windows desktop acceptance",
    workArea: AREA, minimumDropLogicalPx: 280, dragThresholdLogicalPx: DRAG_START_THRESHOLD_LOGICAL_PX,
    heightResetPolicy: "Only actual pointer DRAG gestures raise the pet; no Runtime state or native position teleports",
    results: evidence,
  }, null, 2));
});

async function setup(report: Evidence, initialX = 100) {
  const clock = new Clock();
  const native = { x: initialX, y: 120, width: 160, height: 160, cursorX: initialX + 80, cursorY: 180 };
  let revision = 0, command = 0, gesture = 0, round = 0, workAreaOutstanding = 0;
  const gates: ReturnType<typeof gate>[] = [];
  const pendingBegins = new Set<number>();
  const counts = { beginAttempts: 0, acceptedAtPointerdown: 0, rejectedAtPointerdown: 0, readyForMovement: 0, endedDuringPreparation: 0, completedReleases: 0 };
  let frameHook: ((frame: NativeSetOverlayFrameArgs) => Promise<void>) | undefined;
  let positionHook: ((position: NativeSetOverlayPositionArgs) => Promise<void>) | undefined;
  let workAreaHook: (() => Promise<CurrentWorkAreaSnapshot | null>) | undefined;
  const pending = new Set<number>();
  const resyncs: MotionSnapshot[] = [];
  const expansions: boolean[] = [];
  const log = (operation: string, facts: Record<string, unknown> = {}) => {
    report.operations.push({ atMs: clock.now(), round, operation, ...facts });
  };
  const raw: NativePlatformPort = {
    desktopSnapshot: async () => ({
      protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION, snapshotRevision: ++revision,
      capturedAtMonotonicMs: clock.now(), currentMonitorId: "m1", windowScaleFactor: 1, monitorScaleFactor: 1,
      workArea: { ...AREA }, windowPosition: { space: "WINDOW_TOP_LEFT_LOGICAL", x: native.x, y: native.y },
      homeWindow: { ready: true, currentMonitorId: "m1", windowScaleFactor: 1,
        rect: { x: 520, y: 744, width: 256, height: 256 } },
    }),
    pointerSnapshot: async () => ({
      protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION, snapshotRevision: ++revision,
      capturedAtMonotonicMs: clock.now(), scaleFactor: 1,
      cursorScreenLogical: { x: native.cursorX, y: native.cursorY },
      windowOuterTopLeftLogical: { x: native.x, y: native.y },
      relativeLogical: { x: native.cursorX - native.x, y: native.cursorY - native.y },
    }),
    setOverlayFrame: async frame => {
      const id = ++command;
      pending.add(id); log("native-frame-request", { id, frame });
      try {
        await frameHook?.(frame);
        Object.assign(native, { x: frame.x, y: frame.y, width: frame.width, height: frame.height });
        log("native-frame-applied", { id, x: native.x, y: native.y, height: native.height });
      } catch (error) { log("native-frame-rejected", { id }); throw error; }
      finally { pending.delete(id); }
    },
    setOverlayPosition: async position => {
      const id = ++command;
      pending.add(id); log("native-position-request", { id, position });
      try {
        await positionHook?.(position);
        native.x = position.x; native.y = position.y;
        log("native-position-applied", { id, x: native.x, y: native.y, height: native.height });
      } finally { pending.delete(id); }
    },
    focusedInputSnapshot: async request => ({ ...request, kind: "none", rectPhysical: null,
      approximate: false, textFocus: false, activeCaret: false, singleVisualBand: false, caretEvidenceKind: null, busy: false }),
    setOverlayVisibility: async () => {}, setOverlayOpacity: async () => {},
    setWindowClickThrough: async () => {}, beginNativeDrag: async () => {},
    surfaceReady: async surface => ({ protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION, surface, ready: true, alreadyReady: false }),
    exitApplication: async () => {},
  };
  const viewport = new ParachuteViewportAdapter(raw);
  const motion: PetMotionPort = {
    resync: async () => {
      const snapshot = createMotionSnapshot(await viewport.desktopSnapshot());
      resyncs.push(snapshot);
      return snapshot;
    },
    readCurrentWorkArea: async () => {
      workAreaOutstanding++;
      try { return await (workAreaHook ? workAreaHook() : viewport.desktopSnapshot().then(createCurrentWorkAreaSnapshot)); }
      finally { workAreaOutstanding--; }
    },
    writeWindowTopLeft: position => viewport.setOverlayPosition({ windowLabel: "main", x: position.x, y: position.y }),
  };
  const runtime = new PetRuntime(resources, {
    clock, random: () => 0, homeRandom: () => 0, motionPort: motion,
    setParachuteExpanded: expanded => { expansions.push(expanded); log("viewport-request", { expanded }); return viewport.setExpanded(expanded); },
  });
  const controller = new PointerGestureController(runtime, {
    readPointerSample: () => viewport.pointerSnapshot(),
    setInteractionLock: async locked => { log("interaction-lock", { locked }); },
    setPointerPressed: () => {},
  }, motion);
  await runtime.initialize(async () => undefined);
  runtime.setAutonomyPaused(true);
  await flush();
  const state = () => ({ behavior: runtime.state.behavior, interaction: runtime.state.interaction,
    controllerPhase: controller.phase, parachute: runtime.state.parachutePhase,
    position: { ...runtime.state.logicalPosition! }, native: { x: native.x, y: native.y, width: native.width, height: native.height },
    topInset: viewport.topInset, pendingCallbacks: [...pending], workAreaOutstanding,
    pendingTimers: clock.pendingTimerCount, restoreStatus: runtime.state.restoreStatus });
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) { clock.step(Math.min(10, ms - elapsed)); await flush(); }
  };
  const until = async (predicate: () => boolean, limit = 15_000) => {
    for (let ms = 0; ms < limit && !predicate(); ms += 10) await advance(10);
    expect(predicate(), JSON.stringify(state())).toBe(true);
  };
  const begin = async (id: number) => {
    native.cursorX = runtime.state.logicalPosition!.x + 80;
    native.cursorY = runtime.state.logicalPosition!.y + 60;
    log("pointerdown", { id, before: state() });
    counts.beginAttempts++;
    const alreadyActive = controller.phase !== "NONE";
    pendingBegins.add(id);
    const starting = controller.begin(id);
    const accepted = !alreadyActive && controller.phase !== "NONE";
    if (accepted) counts.acceptedAtPointerdown++; else counts.rejectedAtPointerdown++;
    const result = await starting;
    pendingBegins.delete(id);
    if (result) counts.readyForMovement++; else if (accepted) counts.endedDuringPreparation++;
    await flush();
    log("pointerdown-settled", { id, result, after: state() });
    return result;
  };
  const move = async (dx: number, dy = 0) => {
    native.cursorX += dx; native.cursorY += dy;
    controller.handleGlobalPointerSample(await viewport.pointerSnapshot());
    await flush();
    log("pointermove", { dx, dy, after: state() });
  };
  const release = async (id: number, outcome: PointerGestureEnd, expected: "open" | "closed" | "rejected" | "pending" = "open") => {
    const phase = controller.phase;
    const beganDuringPreparation = pendingBegins.has(id);
    const resyncStart = resyncs.length;
    const expansionStart = expansions.length;
    await controller.finish(id, outcome);
    await flush();
    const snapshot = resyncs.slice(resyncStart).at(-1);
    expect(snapshot, "each release must obtain a fresh native snapshot").toBeDefined();
    const { x, y } = snapshot!.windowPosition;
    // Independent oracle from the fixture's physical surface: ground foot y=1000;
    // same-monitor Home cushion x=[572,630], foot y=932. Dog foot=(x+80,y+140).
    const home = x + 80 >= 572 && x + 80 <= 630 && y + 140 <= 932;
    const landingY = home ? 792 : 860;
    const remaining = landingY - y;
    const row = { round, pointerId: id, outcome, controllerPhaseAtRelease: phase, beganDuringPreparation,
      releaseSnapshot: snapshot, landingSurface: home ? "home" : "ground", landingTopY: landingY,
      remainingHeight: remaining, eligibleByHeight: remaining >= 280, expected,
      expansionRequests: expansions.slice(expansionStart), result: state() };
    counts.completedReleases++;
    report.releases.push(row);
    log("release-verified", row);
    expect(runtime.state.interaction).toBe("NONE");
    expect(controller.phase).toBe("NONE");
    if (expected !== "closed") expect(remaining).toBeGreaterThanOrEqual(280);
    if (expected === "open") {
      expect(remaining, "must not label low releases as high-drop failures").toBeGreaterThanOrEqual(280);
      expect(runtime.state.parachutePhase).toBe("OPENING");
      expect(native.height).toBe(240);
      expect(viewport.topInset).toBe(80);
    } else if (expected === "closed" || expected === "rejected") {
      if (expected === "closed") expect(remaining).toBeLessThan(280);
      expect(runtime.state.parachutePhase).toBe("NONE");
      expect(native.height).toBe(160);
      expect(viewport.topInset).toBe(0);
    }
    return row;
  };
  const nextId = () => ++gesture;
  const dragHigh = async (x = 100, y = 120) => {
    const id = nextId();
    expect(await begin(id)).toBe(true);
    const current = runtime.state.logicalPosition!;
    // A >=12px pointer movement promotes ARMED to DRAG. The real controller
    // and Runtime then send and confirm native movement before release.
    if (Math.hypot(x - current.x, y - current.y) < 12) await move(20);
    await move(x - runtime.state.logicalPosition!.x, y - runtime.state.logicalPosition!.y);
    expect(controller.phase).toBe("DRAG");
    expect(native.x).toBeCloseTo(x, 6);
    expect(native.y).toBeCloseTo(y, 6);
    log("height-raised-by-real-drag", { x, y });
    await release(id, "pointerup");
  };
  const coherent = () => {
    expect(pending.size).toBe(0);
    expect(workAreaOutstanding).toBe(0);
    expect(viewport.geometryKnown).toBe(true);
    expect(native.width).toBe(160);
    expect(native.height).toBe(160 + viewport.topInset);
    expect(native.x).toBeCloseTo(runtime.state.logicalPosition!.x, 6);
    expect(native.y + viewport.topInset).toBeCloseTo(runtime.state.logicalPosition!.y, 6);
  };
  const cleanup = async () => {
    for (const blocked of gates) blocked.resolve();
    await flush();
    runtime.dispose(); await flush(); await viewport.dispose(); await flush();
    const writesAfterDispose = command, requestsAfterDispose = expansions.length;
    expect(counts.beginAttempts).toBe(counts.acceptedAtPointerdown + counts.rejectedAtPointerdown);
    expect(counts.completedReleases).toBe(counts.acceptedAtPointerdown);
    if (report.rounds) expect(counts.completedReleases).toBeGreaterThanOrEqual(report.rounds);
    await advance(5_000);
    expect(command).toBe(writesAfterDispose);
    expect(clock.pendingTimerCount).toBe(0);
    expect(expansions).toHaveLength(requestsAfterDispose);
    expect(pending.size).toBe(0);
    expect(workAreaOutstanding).toBe(0);
    log("disposed-no-late-writes", { observedMs: 5_000, counts, writesAfterDispose, requestsAfterDispose, after: state() });
    if (report.final) report.final = { ...report.final, counts: { ...counts }, afterDispose: state(), noWritesDuring5SecondsAfterDispose: true };
  };
  return { runtime, controller, viewport, native, raw, report, expansions, pending, state, log, advance, until, begin,
    move, release, nextId, dragHigh, coherent, cleanup,
    makeGate: () => { const blocked = gate(); gates.push(blocked); return blocked; },
    setRound: (value: number) => { round = value; },
    frameHook: (hook?: typeof frameHook) => { frameHook = hook; },
    positionHook: (hook?: typeof positionHook) => { positionHook = hook; },
    workAreaHook: (hook?: typeof workAreaHook) => { workAreaHook = hook; },
  };
}

const modes = ["light-opening", "light-gliding", "real-drag", "delayed-collapse", "rejected-collapse",
  "obsolete-expansion", "rejected-expansion", "obsolete-position", "obsolete-workarea", "duplicate-end-burst"] as const;

describe("fixed-seed repeated high-altitude grabs through the complete gesture/viewport boundary", () => {
  it.each([{ rounds: 10, seed: 0x1310010 }, { rounds: 50, seed: 0x1310050 }, { rounds: 100, seed: 0x1310100 }])(
    "$rounds consecutive rounds, seed=$seed", async ({ rounds, seed }) => {
      const report: Evidence = { name: `mixed-${rounds}`, seed, rounds, status: "running", operations: [], releases: [] };
      evidence.push(report);
      const t = await setup(report);
      const random = seeded(seed);
      // Shuffle all ten modes per block; every stress length covers every mode.
      let order: typeof modes[number][] = [];
      try {
        await t.dragHigh();
        for (let round = 1; round <= rounds; round++) {
          t.setRound(round);
          if (!order.length) order = [...modes].map(mode => ({ mode, rank: random() })).sort((a, b) => a.rank - b.rank).map(item => item.mode);
          const mode = order.shift()!;
          const outcome = outcomes[Math.floor(random() * outcomes.length)];
          if (t.runtime.state.logicalPosition!.y > 400) await t.dragHigh(100, 120 + Math.floor(random() * 60));
          t.log("round-start", { mode, outcome, before: t.state() });
          if (mode === "real-drag") {
            await t.dragHigh(round % 2 ? 521 : 100, 100 + Math.floor(random() * 80));
          } else if (mode === "light-opening" || mode === "light-gliding" || mode === "duplicate-end-burst") {
            if (mode === "light-opening") {
              const prepare = t.nextId(); expect(await t.begin(prepare)).toBe(true); await t.release(prepare, outcome);
              await t.advance(30 + Math.floor(random() * 120));
              expect(t.runtime.state.parachutePhase).toBe("OPENING");
            } else { await t.advance(350); expect(t.runtime.state.parachutePhase).toBe("GLIDING"); }
            const id = t.nextId();
            expect(await t.begin(id)).toBe(true);
            await t.move(random() * 11.9);
            expect(t.controller.phase).toBe("ARMED");
            const held = { ...t.runtime.state.logicalPosition! };
            await t.advance(20 + Math.floor(random() * 100));
            expect(t.runtime.state.logicalPosition).toEqual(held);
            if (mode === "duplicate-end-burst") expect(await t.begin(id + 100_000)).toBe(false);
            const releasing = t.release(id, outcome);
            if (mode === "duplicate-end-burst") {
              expect(await t.controller.finish(id, "pointercancel")).toBe(false);
              expect(await t.controller.finish(id, "lostpointercapture")).toBe(false);
              expect(await t.controller.finish(id - 1, "pointerup")).toBe(false);
            }
            await releasing;
          } else if (mode === "delayed-collapse") {
            const blocked = t.makeGate();
            t.frameHook(async frame => { if (frame.height === 160 && !blocked.entered) { blocked.entered = true; await blocked.promise; } });
            const id = t.nextId(), starting = t.begin(id);
            await flush(); expect(blocked.entered).toBe(true);
            const held = { ...t.runtime.state.logicalPosition! };
            const ending = t.release(id, outcome);
            await t.advance(230);
            expect(t.controller.phase).toBe("NONE");
            expect(t.runtime.state.logicalPosition).toEqual(held);
            expect(t.pending.size).toBe(1);
            t.log("release-waiting-for-collapse", { after: t.state() });
            blocked.resolve();
            await Promise.all([starting, ending]);
            t.frameHook();
          } else if (mode === "rejected-collapse") {
            let rejected = 0;
            t.frameHook(async frame => { if (frame.height === 160 && rejected++ === 0) throw new Error("injected recoverable collapse failure"); });
            const id = t.nextId(); expect(await t.begin(id)).toBe(true);
            await flush(); expect(rejected).toBeGreaterThanOrEqual(2);
            expect(t.native.height).toBe(160);
            t.frameHook();
            await t.release(id, outcome);
          } else if (mode === "obsolete-expansion") {
            const id = t.nextId(); expect(await t.begin(id)).toBe(true);
            const blocked = t.makeGate();
            t.frameHook(async frame => { if (frame.height === 240 && !blocked.entered) { blocked.entered = true; await blocked.promise; } });
            await t.release(id, outcome, "pending");
            expect(blocked.entered).toBe(true);
            const nextId = t.nextId(), starting = t.begin(nextId);
            await flush();
            expect(t.controller.phase).toBe("ARMED");
            await t.advance(180);
            t.log("old-expansion-arrives-after-new-grab", { after: t.state() });
            blocked.resolve();
            expect(await starting).toBe(true);
            t.frameHook();
            expect(t.native.height).toBe(160);
            expect(t.runtime.state.parachutePhase).toBe("NONE");
            await t.release(nextId, outcome);
          } else if (mode === "rejected-expansion") {
            const id = t.nextId(); expect(await t.begin(id)).toBe(true);
            let rejected = false;
            t.frameHook(async frame => { if (frame.height === 240 && !rejected) { rejected = true; throw new Error("injected expansion refusal"); } });
            await t.release(id, outcome, "rejected");
            expect(rejected).toBe(true);
            t.frameHook();
            await t.advance(80);
            const retryId = t.nextId(); expect(await t.begin(retryId)).toBe(true);
            await t.release(retryId, outcome);
          } else if (mode === "obsolete-position") {
            const blocked = t.makeGate();
            t.positionHook(async () => { if (!blocked.entered) { blocked.entered = true; await blocked.promise; } });
            await t.advance(40); expect(blocked.entered).toBe(true);
            const id = t.nextId(), starting = t.begin(id);
            await flush();
            await t.advance(100);
            t.log("old-position-arrives-after-new-grab", { after: t.state() });
            blocked.resolve();
            expect(await starting).toBe(true);
            t.positionHook();
            await t.move(35, -30);
            expect(t.controller.phase).toBe("DRAG");
            t.coherent();
            await t.release(id, outcome);
          } else if (mode === "obsolete-workarea") {
            const blocked = t.makeGate();
            t.workAreaHook(async () => { blocked.entered = true; await blocked.promise; return {
              currentMonitorId: "m1", windowScaleFactor: 1, workArea: { ...AREA, height: 600 },
            }; });
            await t.advance(510); expect(blocked.entered).toBe(true);
            const id = t.nextId(); expect(await t.begin(id)).toBe(true);
            // Alternate the dangerous held window with the already-released window.
            // A late result must never move the held dog or reapply old ground facts.
            if (round % 2 === 0) await t.release(id, outcome);
            t.workAreaHook();
            const stable = t.state();
            blocked.resolve(); await flush();
            expect(t.runtime.state.groundTopY).toBe(860);
            expect(t.state()).toEqual({ ...stable, workAreaOutstanding: 0 });
            t.log("obsolete-workarea-ignored", { returnedWhileHeld: round % 2 !== 0, after: t.state() });
            if (round % 2 !== 0) await t.release(id, outcome);
          }
          await t.advance(10 + Math.floor(random() * 40));
          t.coherent();
          expect(t.runtime.state.restoreStatus).not.toBe("failed");
          expect(t.runtime.state.restoreStatus).not.toBe("busy");
          t.log("round-complete", { mode, after: t.state() });
        }
        await t.until(() => t.runtime.state.behavior === "IDLE" || t.runtime.state.behavior === "REST");
        await t.advance(500);
        t.coherent();
        expect(t.runtime.state.parachutePhase).toBe("NONE");
        expect(t.native.height).toBe(160);
        report.final = t.state(); report.status = "passed";
      } catch (error) { report.status = "failed"; report.failure = String(error); report.final = t.state(); throw error; }
      finally {
        await t.cleanup().catch(error => { report.status = "failed"; report.failure = `cleanup: ${String(error)}`; throw error; });
      }
    }, 30_000,
  );

  it.each([{ x: 100, landingTopY: 860, finalBehavior: "IDLE" }, { x: 521, landingTopY: 792, finalBehavior: "REST" }])(
    "naturally descends through the 280px threshold without height resets (x=$x)", async ({ x, landingTopY, finalBehavior }) => {
      const report: Evidence = { name: `cumulative-descent-${x}`, status: "running", operations: [], releases: [] };
      evidence.push(report);
      const t = await setup(report, x);
      try {
        await t.dragHigh(x, 120);
        let round = 0, high = 0, low = 0;
        while (t.runtime.state.behavior === "FALL") {
          t.setRound(++round);
          const remaining = landingTopY - t.runtime.state.logicalPosition!.y;
          const id = t.nextId(); expect(await t.begin(id)).toBe(true);
          await t.move((round % 3) * 3);
          expect(t.controller.phase).toBe("ARMED");
          await t.release(id, outcomes[round % 3], remaining >= 280 ? "open" : "closed");
          if (remaining >= 280) high++; else low++;
          await t.advance(remaining >= 280 ? 220 : 60);
          expect(round).toBeLessThan(100);
        }
        expect(high).toBeGreaterThan(5);
        expect(low).toBeGreaterThan(1);
        await t.until(() => t.runtime.state.behavior === finalBehavior);
        await t.advance(500);
        t.coherent();
        expect(t.native.height).toBe(160);
        expect(t.runtime.state.logicalPosition!.y).toBe(landingTopY);
        report.final = { ...t.state(), highReleases: high, lowReleases: low, noHeightResetsAfterInitialDrag: true };
        report.status = "passed";
      } catch (error) { report.status = "failed"; report.failure = String(error); report.final = t.state(); throw error; }
      finally {
        await t.cleanup().catch(error => { report.status = "failed"; report.failure = `cleanup: ${String(error)}`; throw error; });
      }
    }, 30_000,
  );
});
