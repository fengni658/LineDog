import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TimelineClock, TimelineFrameEvent } from "../src/animation-timeline";
import { PET_BEHAVIOR_CONFIG } from "../src/pet-behavior-core";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import { PetRuntime, type PetRuntimeState } from "../src/pet-runtime";
import type { LogicalWorkArea, MotionSnapshot, WindowTopLeftLogical } from "../src/native-motion";

const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(
  readFileSync(new URL("../public/character/manifest.json", import.meta.url), "utf8"),
)));
const AREA: LogicalWorkArea = { x: 0, y: 0, width: 800, height: 600 };
const point = (x: number, y: number): WindowTopLeftLogical => ({ space: "WINDOW_TOP_LEFT_LOGICAL", x, y });

class Clock implements TimelineClock {
  time = 0;
  private id = 0;
  private timers = new Map<number, { due: number; callback: () => void }>();
  now() { return this.time; }
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
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup(options: {
  x?: number; y?: number; area?: LogicalWorkArea; homeMonitor?: string;
  expand?: (expanded: boolean) => Promise<boolean>;
  write?: (position: WindowTopLeftLogical) => Promise<void>;
  accepted?: (snapshot: MotionSnapshot) => void;
} = {}) {
  const clock = new Clock();
  let position = point(options.x ?? 100, options.y ?? 180);
  let area = options.area ?? AREA;
  let homeMonitor = options.homeMonitor ?? "m1";
  let resyncs = 0;
  const writes: WindowTopLeftLogical[] = [];
  const sizes: boolean[] = [];
  const frames: TimelineFrameEvent[] = [];
  const states: Array<PetRuntimeState & { time: number }> = [];
  const snapshot = (): MotionSnapshot => ({
    currentMonitorId: "m1", windowScaleFactor: 1, workArea: area, windowPosition: position,
    homeWindow: { ready: true, currentMonitorId: homeMonitor, windowScaleFactor: 1,
      rect: { x: area.x + area.width - 280, y: area.y + area.height - 256, width: 256, height: 256 } },
  });
  const runtime = new PetRuntime(resources, {
    clock, random: () => 0, homeRandom: () => 0,
    setParachuteExpanded: async expanded => { sizes.push(expanded); return options.expand ? options.expand(expanded) : true; },
    onMotionSnapshotAccepted: options.accepted,
    onFrame: frame => frames.push(frame),
    onStateChange: state => states.push({ ...state, time: clock.now() }),
    motionPort: {
      resync: async () => { resyncs++; return snapshot(); },
      readCurrentWorkArea: async () => snapshot(),
      writeWindowTopLeft: async next => { await options.write?.(next); position = { ...next }; writes.push(position); },
    },
  });
  await runtime.initialize(async () => undefined);
  runtime.setAutonomyPaused(true);
  await flush();
  const advance = async (ms: number) => {
    for (let remaining = ms; remaining > 0; remaining -= 10) { clock.step(Math.min(remaining, 10)); await flush(); }
  };
  const until = async (predicate: () => boolean, limit = 15_000) => {
    for (let elapsed = 0; elapsed < limit && !predicate(); elapsed += 10) await advance(10);
    expect(predicate()).toBe(true);
  };
  const drop = async () => { expect(runtime.beginDrag()).toBe(true); await flush(); await runtime.endDrag(); await flush(); };
  return { runtime, clock, advance, until, drop, sizes, frames, states, writes, snapshot,
    resyncs: () => resyncs, setArea: (next: LogicalWorkArea) => { area = next; },
    setHomeMonitor: (next: string) => { homeMonitor = next; } };
}

describe("FALL local parachute", () => {
  it.each([{ y: 181, open: false }, { y: 180, open: true }])(
    "decides the 280px ground threshold once at release (y=$y)", async ({ y, open }) => {
      const t = await setup({ y });
      await t.drop();
      expect(t.runtime.state.behavior).toBe("FALL");
      expect(t.runtime.state.parachutePhase).toBe(open ? "OPENING" : "NONE");
      await t.advance(350);
      if (open) {
        expect(t.runtime.state.parachutePhase).toBe("GLIDING");
        expect(t.runtime.state.verticalVelocityLogicalPxPerSecond).toBe(95);
      } else {
        expect(t.sizes).toEqual([]);
        expect(t.runtime.state.verticalVelocityLogicalPxPerSecond).toBeGreaterThan(300);
        expect(t.frames.filter(frame => frame.animationId === "fall").map(frame => frame.frameIndex)).toEqual([0, 1, 0]);
      }
      t.runtime.dispose();
    },
  );

  it.each([{ y: 113, homeMonitor: "m1", open: false }, { y: 112, homeMonitor: "m1", open: true },
    { y: 113, homeMonitor: "another-monitor", open: true }])(
    "measures the actual same-screen cushion first (y=$y, home=$homeMonitor)", async options => {
      const t = await setup({ x: 521, ...options });
      await t.drop();
      expect(t.runtime.state.parachutePhase).toBe(options.open ? "OPENING" : "NONE");
      await t.until(() => t.runtime.state.behavior !== "FALL");
      await t.advance(1_000);
      expect(t.runtime.state.behavior).toBe(options.homeMonitor === "m1" ? "REST" : "IDLE");
      expect(t.runtime.state.parachutePhase).toBe("NONE");
      expect(t.runtime.state.logicalPosition?.y).toBe(options.homeMonitor === "m1" ? 392 : 460);
      t.runtime.dispose();
    },
  );

  it("free-falls below the top edge before asking for the 80px headroom", async () => {
    const t = await setup({ y: 0 });
    await t.drop();
    await t.advance(300);
    expect(t.sizes).toEqual([]);
    expect(t.runtime.state.logicalPosition!.y).toBeLessThan(80);
    await t.until(() => t.sizes.includes(true));
    expect(t.runtime.state.logicalPosition!.y).toBeGreaterThanOrEqual(80);
    expect(t.runtime.state.parachutePhase).toBe("OPENING");
    t.runtime.dispose();
  });

  it("opens over 300ms, glides at 95px/s, sways within 14px and settles over the final 50px", async () => {
    const t = await setup({ y: 100, area: { ...AREA, height: 1_000 } });
    await t.drop();
    await t.advance(150);
    expect(t.runtime.state.parachuteProgress).toBeGreaterThan(0);
    expect(t.runtime.state.parachuteProgress).toBeLessThan(1);
    await t.advance(200);
    expect(t.runtime.state.parachutePhase).toBe("GLIDING");
    const y = t.runtime.state.logicalPosition!.y;
    await t.advance(1_000);
    expect(t.runtime.state.logicalPosition!.y - y).toBeCloseTo(95, 6);
    await t.advance(1_500);
    const fallX = t.states.filter(s => s.behavior === "FALL").map(s => s.logicalPosition!.x);
    expect(Math.max(...fallX)).toBeGreaterThan(113);
    expect(Math.min(...fallX)).toBeLessThan(87);
    expect(fallX.every(x => x >= 86 && x <= 114)).toBe(true);
    await t.until(() => 860 - t.runtime.state.logicalPosition!.y < 45);
    const remaining = 860 - t.runtime.state.logicalPosition!.y;
    expect(Math.abs(t.runtime.state.logicalPosition!.x - 100)).toBeLessThanOrEqual(14 * remaining / 50);
    await t.until(() => t.runtime.state.parachutePhase === "CLOSING");
    expect(t.runtime.state).toMatchObject({ behavior: "LAND", logicalPosition: { x: 100, y: 860 } });
    await t.advance(299);
    expect(t.runtime.state.parachutePhase).toBe("CLOSING");
    await t.advance(1);
    expect(t.runtime.state.parachutePhase).toBe("NONE");
    expect(t.sizes).toEqual([true, false]);
    await t.advance(500);
    expect(t.runtime.state.behavior).toBe("IDLE");
    t.runtime.dispose();
  });

  it("holds the displayed original FALL pose when deployment succeeds while glide and sway continue", async () => {
    const expanded = deferred<boolean>();
    const t = await setup({ y: 100, area: { ...AREA, height: 1_000 },
      expand: async expanding => expanding ? expanded.promise : true });
    await t.drop();
    await t.advance(150);
    expect(t.runtime.state.parachutePhase).toBe("NONE");
    const displayedFrame = t.frames.at(-1)!;
    expect(displayedFrame).toMatchObject({ animationId: "fall", frameIndex: 1, frame: resources.fall.frames[1] });

    expanded.resolve(true);
    await flush();
    expect(t.runtime.state.parachutePhase).toBe("OPENING");
    expect(t.frames.at(-1)).toBe(displayedFrame);
    await t.advance(350);
    expect(t.runtime.state.parachutePhase).toBe("GLIDING");
    const y = t.runtime.state.logicalPosition!.y;
    const statesBeforeGlide = t.states.length;
    await t.advance(2_400);
    expect(t.frames.at(-1)).toBe(displayedFrame);
    expect(t.runtime.state.logicalPosition!.y - y).toBeCloseTo(95 * 2.4, 6);
    const glideX = t.states.slice(statesBeforeGlide).map(state => state.logicalPosition!.x);
    expect(Math.max(...glideX)).toBeGreaterThan(113);
    expect(Math.min(...glideX)).toBeLessThan(87);
    expect(glideX.every(x => x >= 86 && x <= 114)).toBe(true);
    await t.until(() => t.runtime.state.parachutePhase === "CLOSING");
    expect(t.frames.at(-1)!.animationId).toBe("land");
    await t.advance(500);
    expect(t.runtime.state).toMatchObject({ behavior: "IDLE", parachutePhase: "NONE" });
    expect(t.frames.at(-1)!.animationId).toBe("idle");
    t.runtime.dispose();
  });

  it("disables sway under reduced motion while keeping the glide and original FALL pose", async () => {
    const t = await setup();
    t.runtime.setReducedMotion(true);
    await t.drop();
    const displayedFrame = t.frames.at(-1);
    await t.advance(1_500);
    expect(t.runtime.state).toMatchObject({ behavior: "FALL", parachutePhase: "GLIDING", activeAnimationId: "fall",
      logicalPosition: { x: 100 }, verticalVelocityLogicalPxPerSecond: 95 });
    expect(t.states.filter(s => s.behavior === "FALL").every(s => s.logicalPosition!.x === 100)).toBe(true);
    expect(t.frames.at(-1)).toBe(displayedFrame);
    const frameCount = t.frames.length;
    t.runtime.dispose();
    await t.advance(1_000);
    expect(t.frames).toHaveLength(frameCount);
  });

  it.each(["false", "reject"])("falls normally after a resize %s without retrying deployment", async mode => {
    const t = await setup({ expand: async expanded => {
      if (expanded && mode === "reject") throw new Error("resize failed");
      return !expanded;
    } });
    await t.drop();
    expect(t.runtime.state.parachutePhase).toBe("NONE");
    await t.advance(350);
    expect(t.frames.filter(frame => frame.animationId === "fall").map(frame => frame.frameIndex)).toEqual([0, 1, 0]);
    await t.until(() => t.runtime.state.behavior === "LAND");
    expect(t.sizes.filter(Boolean)).toHaveLength(1);
    await t.advance(500);
    expect(t.runtime.state.behavior).toBe("IDLE");
    t.runtime.dispose();
  });

  it.each(["low", "resize-failed", "glide"])("restores the correct FALL playback after re-grab and %s release", async mode => {
    let expands = 0;
    const t = await setup({ y: 100, area: { ...AREA, height: 1_000 },
      expand: async expanded => !expanded || ++expands === 1 || mode !== "resize-failed" });
    await t.drop();
    await t.advance(500);
    expect(t.runtime.state.parachutePhase).toBe("GLIDING");
    const beforeGrab = t.frames.length;
    expect(t.runtime.beginDrag()).toBe(true);
    await flush();
    expect(t.frames.slice(beforeGrab).map(frame => frame.animationId)).toEqual(["drag"]);
    const dragFrame = t.frames.at(-1);
    expect(dragFrame!.animationId).toBe("drag");
    await t.advance(300);
    expect(t.frames.at(-1)).toBe(dragFrame);
    expect(t.runtime.movePointerDrag({ x: 100, y: mode === "low" ? 681 : 100 }, "m1", t.snapshot().workArea)).toBe(true);
    await flush();
    const beforeRelease = t.frames.length;
    await t.runtime.endDrag();
    await flush();
    await t.advance(350);
    expect(t.runtime.state).toMatchObject({ behavior: "FALL", parachutePhase: mode === "glide" ? "GLIDING" : "NONE" });
    expect(t.frames.slice(beforeRelease).map(frame => frame.frameIndex)).toEqual(mode === "glide" ? [0] : [0, 1, 0]);
    expect(t.sizes.filter(Boolean)).toHaveLength(mode === "low" ? 1 : 2);
    t.runtime.dispose();
  });

  it.each(["click", "layout"])("reopens after a high click release but resumes free fall after a layout change (%s)", async mode => {
    const t = await setup({ y: 100, area: { ...AREA, height: 1_000 } });
    await t.drop();
    await t.advance(500);
    const beforeCancel = t.frames.length;
    if (mode === "click") {
      expect(t.runtime.beginPointerGesture()).toBe(true);
      await t.runtime.endPointerGesture({ triggerHappy: false });
    } else {
      t.setArea({ ...AREA, height: 1_200 });
      t.runtime.handleDesktopSnapshot(t.snapshot());
    }
    await t.advance(350);
    expect(t.runtime.state).toMatchObject({ behavior: "FALL", parachutePhase: mode === "click" ? "GLIDING" : "NONE" });
    const resumed = t.frames.slice(beforeCancel);
    if (mode === "click") {
      expect(resumed).toEqual([]);
      expect(t.sizes).toEqual([true, false, true]);
    } else {
      expect(resumed.every(frame => frame.animationId === "fall")).toBe(true);
      expect(new Set(resumed.map(frame => frame.frameIndex))).toEqual(new Set([0, 1]));
    }
    t.runtime.dispose();
  });

  it("cancels the old deployment on re-grab and ignores its delayed success after a new release", async () => {
    const old = deferred<boolean>();
    let expands = 0;
    const t = await setup({ expand: async expanded => expanded && ++expands === 1 ? old.promise : true });
    await t.drop();
    expect(t.runtime.state.parachutePhase).toBe("NONE");
    expect(t.runtime.beginPointerGesture()).toBe(true);
    expect(t.runtime.promotePointerGestureToDrag()).toBe(true);
    await flush();
    await t.runtime.endDrag();
    await flush();
    await t.advance(400);
    expect(t.runtime.state.parachutePhase).toBe("GLIDING");
    const displayedFrame = t.frames.at(-1);
    old.resolve(true);
    await flush();
    expect(t.runtime.state.parachutePhase).toBe("GLIDING");
    expect(t.sizes).toEqual([true, false, true]);
    await t.advance(300);
    expect(t.frames.at(-1)).toBe(displayedFrame);
    t.runtime.dispose();
  });

  it("closes a caught canopy immediately and reopens once after duplicate high blur/cancel releases", async () => {
    const t = await setup({ y: 100, area: { ...AREA, height: 1_000 } });
    await t.drop();
    await t.advance(400);
    expect(t.runtime.beginPointerGesture()).toBe(true);
    expect(t.runtime.state.parachutePhase).toBe("NONE");
    const reads = t.resyncs();
    const cancel = t.runtime.endPointerGesture({ triggerHappy: false });
    const blur = t.runtime.endPointerGesture({ triggerHappy: false });
    expect(cancel).toBe(blur);
    await Promise.all([cancel, blur]);
    await t.advance(400);
    expect(t.resyncs()).toBe(reads + 1);
    expect(t.sizes.filter(Boolean)).toHaveLength(2);
    expect(t.runtime.state).toMatchObject({ interaction: "NONE", behavior: "FALL", parachutePhase: "GLIDING" });
    await t.until(() => t.runtime.state.behavior === "IDLE");
    expect(t.runtime.state.parachutePhase).toBe("NONE");
    t.runtime.dispose();
  });

  it("waits for a confirmed landing before its 300ms close", async () => {
    const landing = deferred<void>();
    let blockLanding = false;
    const t = await setup({ write: async next => { if (blockLanding && next.y === 460) await landing.promise; } });
    await t.drop();
    blockLanding = true;
    await t.until(() => t.runtime.state.behavior === "LAND");
    await t.advance(600);
    expect(t.runtime.state.parachutePhase).toBe("GLIDING");
    expect(t.runtime.state.behavior).toBe("LAND");
    blockLanding = false;
    landing.resolve();
    await flush();
    expect(t.runtime.state.parachutePhase).toBe("CLOSING");
    await t.advance(300);
    expect(t.runtime.state).toMatchObject({ parachutePhase: "NONE", behavior: "IDLE" });
    t.runtime.dispose();
  });

  it("cancels the canopy and converges safely after work-area or Home layout changes", async () => {
    const t = await setup();
    await t.drop();
    await t.advance(400);
    t.setArea({ ...AREA, y: 100, height: 700 });
    t.runtime.handleDesktopSnapshot(t.snapshot());
    expect(t.runtime.state.parachutePhase).toBe("NONE");
    await t.until(() => t.runtime.state.behavior === "LAND");
    expect(t.runtime.state.logicalPosition!.y).toBe(660);
    expect(t.sizes.filter(Boolean)).toHaveLength(1);
    t.runtime.dispose();
  });

  it("clears the canopy and leaves restore available after a native motion failure", async () => {
    let fail = false;
    const t = await setup({ write: async () => { if (fail) throw new Error("geometry_unknown"); } });
    await t.drop();
    await t.advance(400);
    fail = true;
    await t.advance(100);
    expect(t.runtime.state).toMatchObject({ behavior: "IDLE", parachutePhase: "NONE" });
    expect(t.runtime.canRestorePosition).toBe(true);
    t.runtime.dispose();
  });

  it("keeps the current horizontal position when reduced motion is switched on during glide", async () => {
    const t = await setup();
    await t.drop();
    await t.advance(600);
    const x = t.runtime.state.logicalPosition!.x;
    expect(x).toBeGreaterThan(110);
    t.runtime.setReducedMotion(true);
    await t.advance(400);
    expect(t.runtime.state.logicalPosition!.x).toBe(x);
    t.runtime.setReducedMotion(false);
    await t.advance(400);
    expect(t.runtime.state.logicalPosition!.x).toBe(x);
    t.runtime.dispose();
  });

  it("retries a failed shrink once and retains repair eligibility if both attempts fail", async () => {
    let shrinks = 0;
    const t = await setup({ expand: async expanded => expanded || ++shrinks > 2 });
    await t.drop();
    await t.until(() => t.runtime.state.behavior === "IDLE");
    expect(shrinks).toBe(2);
    expect(t.runtime.beginPointerGesture()).toBe(true);
    await flush();
    expect(shrinks).toBe(3);
    await t.runtime.endPointerGesture({ triggerHappy: false });
    t.runtime.dispose();
  });

  it.each([100, 521])("makes restore available if the final landing write fails (x=%i)", async x => {
    const targetY = x === 521 ? 392 : 460;
    let fail = false;
    const t = await setup({ x, y: 100,
      write: async next => { if (fail && next.y === targetY) throw new Error("landing write failed"); } });
    await t.drop();
    fail = true;
    await t.until(() => t.runtime.state.behavior !== "FALL");
    await t.advance(1_000);
    expect(t.runtime.state).toMatchObject({ behavior: "IDLE", parachutePhase: "NONE", restoreStatus: "failed" });
    expect(t.runtime.canRestorePosition).toBe(true);
    expect(t.runtime.state.logicalPosition!.y).toBeLessThan(targetY);
    const writes = t.writes.length;
    await t.advance(5_000);
    expect(t.writes).toHaveLength(writes);
    t.runtime.dispose();
  });

  it("finishes a landing safely when desktop layout changes while its canopy closes", async () => {
    const t = await setup();
    await t.drop();
    await t.until(() => t.runtime.state.parachutePhase === "CLOSING");
    t.setArea({ ...AREA, height: 700 });
    t.runtime.handleDesktopSnapshot(t.snapshot());
    await t.advance(1_000);
    expect(t.runtime.state).toMatchObject({ behavior: "IDLE", parachutePhase: "NONE", logicalPosition: { y: 560 } });
    expect(t.runtime.canRestorePosition).toBe(true);
    t.runtime.dispose();
  });

  it("adopts a new FALL coordinate space before writing it, without adopting a snapshot during DRAG", async () => {
    const events: string[] = [];
    const t = await setup({ accepted: snapshot => events.push(`accept:${snapshot.windowScaleFactor}`),
      write: async next => { events.push(`write:${next.x}:${next.y}`); } });
    await t.drop();
    await t.advance(400);
    events.length = 0;
    t.runtime.handleDesktopSnapshot({ ...t.snapshot(), snapshotRevision: 20, windowScaleFactor: 2,
      monitorScaleFactor: 2, homeWindow: null, windowPosition: point(200, 220) });
    await flush();
    expect(events[0]).toBe("accept:2");
    expect(events).toContain("write:200:220");
    expect(t.runtime.state).toMatchObject({ behavior: "FALL", parachutePhase: "NONE", logicalPosition: { x: 200, y: 220 } });
    t.runtime.beginDrag();
    await flush();
    events.length = 0;
    t.runtime.handleDesktopSnapshot({ ...t.snapshot(), snapshotRevision: 21, windowScaleFactor: 1.5,
      monitorScaleFactor: 1.5, homeWindow: null, windowPosition: point(300, 250) });
    expect(events).toEqual([]);
    expect(t.runtime.state.behavior).toBe("DRAG");
    t.runtime.dispose();
  });

  it("keeps all configured tuning values inside the approved range", () => {
    const p = PET_BEHAVIOR_CONFIG.parachute;
    expect(p.minimumDropLogicalPx).toBe(280);
    expect(p.openingDurationMs).toBeGreaterThanOrEqual(250);
    expect(p.openingDurationMs).toBeLessThanOrEqual(350);
    expect(p.closingDurationMs).toBeGreaterThanOrEqual(250);
    expect(p.closingDurationMs).toBeLessThanOrEqual(350);
    expect(p.glideSpeedLogicalPxPerSecond).toBeGreaterThanOrEqual(80);
    expect(p.glideSpeedLogicalPxPerSecond).toBeLessThanOrEqual(110);
    expect(p.swayAmplitudeLogicalPx).toBeGreaterThanOrEqual(10);
    expect(p.swayAmplitudeLogicalPx).toBeLessThanOrEqual(16);
    expect(p.swayPeriodMs).toBeGreaterThanOrEqual(2_000);
    expect(p.swayPeriodMs).toBeLessThanOrEqual(3_000);
  });
});
