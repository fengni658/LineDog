import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TimelineClock, TimelineFrameEvent } from "../src/animation-timeline";
import { PetBubbleController } from "../src/pet-bubble";
import { bindPetPointerEvents } from "../src/pet-pointer-events";
import { HOME_AWAKE_DURATION_MS, HOME_INTERACTION_QUIET_MS } from "../src/home-cycle";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import { PetRuntime, type PetInteractionResponse } from "../src/pet-runtime";
import { PointerGestureController, DRAG_START_THRESHOLD_LOGICAL_PX } from "../src/pointer-gesture";
import type { NativePointerSnapshotV1 } from "../src/native-platform";
import type { MotionSnapshot, WindowTopLeftLogical } from "../src/native-motion";

const RESOURCES = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(readFileSync(
  new URL("../public/character/manifest.json", import.meta.url), "utf8",
))));
const WORK_AREA = { x: 0, y: 0, width: 1000, height: 600 };

class ManualClock implements TimelineClock {
  private time = 0;
  private serial = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.serial;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(id: unknown) { this.timers.delete(id as number); }
  callbacks() { return [...this.timers.values()].map(timer => timer.callback); }
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const entry = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) break;
      this.time = entry[1].at;
      this.timers.delete(entry[0]);
      entry[1].callback();
    }
    this.time = end;
  }
}

async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

async function setup(options: { home?: boolean; random?: () => number } = {}) {
  const clock = new ManualClock();
  let position: WindowTopLeftLogical = { space: "WINDOW_TOP_LEFT_LOGICAL", x: options.home ? 721 : 100, y: options.home ? 300 : 460 };
  const writes: WindowTopLeftLogical[] = [];
  const frames: TimelineFrameEvent[] = [];
  const responses: Array<PetInteractionResponse | null> = [];
  const snapshot = (): MotionSnapshot => ({
    currentMonitorId: "monitor-1", windowScaleFactor: 1, workArea: WORK_AREA, windowPosition: { ...position },
    ...(options.home ? { homeWindow: { ready: true, currentMonitorId: "monitor-1", windowScaleFactor: 1,
      rect: { x: 720, y: 344, width: 256, height: 256 } } } : {}),
  });
  const motionPort = { resync: async () => snapshot(), writeWindowTopLeft: async (next: WindowTopLeftLogical) => {
    position = { ...next }; writes.push({ ...next });
  } };
  const sample = (dx = 0, dy = 0): NativePointerSnapshotV1 => ({
    protocolVersion: 1, snapshotRevision: 1, capturedAtMonotonicMs: clock.now(),
    cursorScreenLogical: { x: 400 + dx, y: 300 + dy }, windowOuterTopLeftLogical: { x: 0, y: 0 },
    relativeLogical: { x: 80, y: 80 }, scaleFactor: 1,
  });
  let bubbleText = "";
  const bubbles = new PetBubbleController(text => { bubbleText = text; }, clock, () => 0);
  const runtime = new PetRuntime(RESOURCES, { clock, random: options.random ?? (() => 0), homeRandom: () => 0,
    motionPort, onFrame: event => frames.push(event),
    onStateChange: state => bubbles.update(false, ["DRAG", "FALL", "LAND", "GO_HOME", "LEAVE_HOME"].includes(state.behavior)),
    onInteractionResponse: event => { responses.push(event); bubbles.respond(event); } });
  const samplePort = { readPointerSample: async () => sample(),
    setInteractionLock: async (_locked: boolean) => undefined, setPointerPressed: (_pressed: boolean) => undefined };
  const controller = new PointerGestureController(runtime, samplePort, motionPort);
  await runtime.initialize(async () => undefined);
  await flush();
  const advance = async (ms: number) => { for (let left = ms; left > 0; left -= 20) { clock.advance(Math.min(20, left)); await flush(); } };
  const click = async () => { expect(await controller.begin(1)).toBe(true); return controller.finish(1, "pointerup"); };
  const target = new EventTarget() as unknown as HTMLElement;
  let captured = false;
  target.setPointerCapture = () => { captured = true; };
  target.hasPointerCapture = () => captured;
  target.releasePointerCapture = () => { captured = false; };
  const binding = bindPetPointerEvents(target, { gesture: () => controller, isCoreHit: () => true,
    activity: () => undefined, onError: error => { throw error; } });
  const dispatch = (type: string) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0 });
    target.dispatchEvent(event);
  };
  const eventClick = async (holdMs = 0) => {
    dispatch("pointerdown");
    if (holdMs) await advance(holdMs);
    dispatch("pointerup");
    await flush(); await flush();
  };
  if (options.home) {
    expect(runtime.beginDrag()).toBe(true);
    await runtime.endDrag();
    await advance(3000);
    expect(runtime.state.behavior).toBe("REST");
  }
  frames.length = 0;
  return { runtime, controller, clock, frames, writes, responses, click, eventClick, dispatch, binding, advance, sample, samplePort, motionPort,
    position: () => ({ ...position }), bubbleText: () => bubbleText };
}

describe("contextual responses through real pointer gestures", () => {
  it.each([10, 50])("does not replay the HAPPY first frame for %s quick clicks", async count => {
    const h = await setup();
    for (let i = 0; i < count; i++) { await h.click(); await h.advance(20); }
    await h.advance(4500);
    expect(h.frames.filter(frame => frame.animationId === "happy" && frame.frameIndex === 0)).toHaveLength(1);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "playful", "cooldown"]);
    expect(h.responses.filter(Boolean).map(response => response!.durationMs)).toEqual([1600, 2200, 1600]);
    expect(h.responses.at(-1)?.action).toBe("still");
    expect(h.runtime.state.behavior).toBe("IDLE");
    h.runtime.dispose();
  });

  it("keeps the sleeping pose and deadline while a click is only armed or cancelled", async () => {
    const h = await setup({ home: true });
    await h.advance(HOME_AWAKE_DURATION_MS + 3000);
    expect(h.runtime.state.activeAnimationId).toBe("sleep");
    const deadline = h.runtime.state.homeRestDeadlineMs;
    const awake = h.runtime.state.homeAwakeStartedAtMs;
    await h.controller.begin(1);
    expect(h.runtime.state.activeAnimationId).toBe("sleep");
    await h.controller.cancel();
    expect(h.runtime.state.activeAnimationId).toBe("sleep");
    expect(h.runtime.state.homeRestDeadlineMs).toBe(deadline);
    expect(h.runtime.state.homeAwakeStartedAtMs).toBe(awake);
    h.runtime.dispose();
  });

  it("paces ordinary greetings at five seconds and alternates look and blink", async () => {
    const h = await setup();
    await h.click();
    expect(h.responses.at(-1)).toMatchObject({ kind: "hello", action: "look" });
    await h.advance(1600);
    expect(h.runtime.state.behavior).toBe("IDLE");
    expect(h.responses).not.toContain(null); // Presentation may outlast the motion.
    await h.advance(1400);
    expect(await h.click()).toBe(false);
    await h.advance(2001);
    await h.click();
    expect(h.responses.filter(Boolean).map(response => response!.action)).toEqual(["look", "blink"]);
    expect(h.runtime.state.animationLayer).toBe("BLINK");
    h.runtime.dispose();
  });

  it("keeps the current response through pointerdown and completes it after release", async () => {
    const h = await setup();
    await h.click();
    await h.advance(1450);
    const before = h.frames.length;
    await h.controller.begin(1);
    expect(h.frames).toHaveLength(before);
    await h.advance(300);
    expect(h.runtime.state.behavior).toBe("LOOK");
    await h.controller.finish(1, "pointerup");
    expect(h.runtime.state.behavior).toBe("IDLE");
    expect(h.responses.filter(Boolean)).toHaveLength(1);
    h.runtime.dispose();
  });

  it.each([10])("ends %s uninterrupted clicks with one static closing and one queued upgrade", async count => {
    const h = await setup();
    h.runtime.setAutonomyPaused(true);
    for (let i = 0; i < count; i++) { await h.click(); await h.advance(400); }
    const responseCount = h.responses.length;
    await h.advance(Math.max(0, 6000 - h.clock.now()));
    expect(h.responses).toHaveLength(responseCount);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "playful", "cooldown"]);
    expect(h.responses.at(-1)).toMatchObject({ action: "still", durationMs: 1600 });
    expect(h.frames.filter(frame => frame.animationId === "happy" && frame.frameIndex === 0)).toHaveLength(1);
    expect(h.frames.filter(frame => frame.timestampMs >= 3800 && frame.timestampMs <= 5400)
      .every(frame => frame.animationId === "idle" && frame.frameIndex === 0)).toBe(true);
    expect(h.runtime.state).toMatchObject({ behavior: "IDLE", animationLayer: "BASE" });
    await h.advance(5001);
    await h.click();
    expect(h.responses.filter(Boolean)).toHaveLength(4);
    h.runtime.dispose();
  });

  it.each([3, 4])("requires a fourth release to close a playful burst (%s releases)", async count => {
    const h = await setup();
    for (let i = 0; i < count; i++) await h.click();
    await h.advance(3799);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "playful"]);
    await h.advance(1);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(
      count === 3 ? ["hello", "playful"] : ["hello", "playful", "cooldown"]);
    if (count === 4) expect(h.runtime.state).toMatchObject({ behavior: "IDLE", activeAnimationId: "idle" });
    h.runtime.dispose();
  });

  it("accepts dense continuation during playful but never restarts its closing timer", async () => {
    const h = await setup();
    await h.click(); await h.click(); await h.click();
    await h.advance(1700);
    await h.click();
    await h.advance(2100);
    expect(h.responses.at(-1)).toMatchObject({ kind: "cooldown", action: "still" });
    const callbacks = h.clock.callbacks();
    for (let i = 0; i < 50; i++) { await h.click(); await h.advance(20); }
    await h.advance(600);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "playful", "cooldown"]);
    const frameCount = h.frames.length;
    callbacks.forEach(callback => callback());
    expect(h.frames).toHaveLength(frameCount);
    await h.advance(3401); await h.click();
    expect(h.responses.filter(Boolean)).toHaveLength(4);
    h.runtime.dispose();
  });

  it("does not lend the previous burst's closing to a new burst during its quiet phase", async () => {
    const h = await setup();
    for (let i = 0; i < 4; i++) await h.click();
    await h.advance(4400);
    for (let i = 0; i < 4; i++) { await h.click(); await h.advance(100); }
    await h.advance(4000);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "playful", "cooldown"]);
    expect(h.frames.filter(frame => frame.animationId === "happy" && frame.frameIndex === 0)).toHaveLength(1);
    await h.advance(1); await h.click();
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "playful", "cooldown", "hello"]);
    h.runtime.dispose();
  });

  it.each(["pointercancel", "lostpointercapture", "controller.cancel", "blur", "drag", "dispose"] as const)(
    "suppresses qualified closing after %s during HAPPY, including stale callbacks", async outcome => {
      const h = await setup();
      for (let i = 0; i < 4; i++) await h.click();
      await h.advance(1700);
      expect(h.runtime.state.behavior).toBe("HAPPY");
      const callbacks = h.clock.callbacks();
      if (outcome === "blur") h.runtime.cancelPendingClickResponses();
      else if (outcome === "dispose") h.runtime.dispose();
      else {
        await h.controller.begin(1);
        if (outcome === "controller.cancel") await h.controller.cancel();
        else if (outcome === "drag") {
          h.controller.handleGlobalPointerSample(h.sample(DRAG_START_THRESHOLD_LOGICAL_PX, -100));
          await flush();
        } else await h.controller.finish(1, outcome);
      }
      expect(h.responses.at(-1)).toBeNull();
      const responseCount = h.responses.length;
      callbacks.forEach(callback => callback());
      await h.advance(6000);
      expect(h.responses).toHaveLength(responseCount);
      expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "playful"]);
      expect(h.frames.filter(frame => frame.animationId === "happy" && frame.frameIndex === 0)).toHaveLength(1);
      if (outcome !== "drag" && outcome !== "dispose") {
        expect(h.runtime.state.behavior).toBe("IDLE");
        expect(h.frames.some(frame => frame.animationId === "land")).toBe(true);
      }
      if (outcome === "drag") {
        expect(h.runtime.state.behavior).toBe("DRAG");
        await h.controller.finish(1, "pointerup");
        await h.advance(3000);
        expect(h.responses).toHaveLength(responseCount);
      }
      h.runtime.dispose();
    },
  );

  it.each(["cancel", "blur", "restore", "dispose"] as const)(
    "clears active closing on %s without letting stale callbacks replay it", async outcome => {
      const h = await setup();
      for (let i = 0; i < 4; i++) await h.click();
      await h.advance(3900);
      expect(h.responses.at(-1)?.kind).toBe("cooldown");
      const callbacks = h.clock.callbacks();
      if (outcome === "cancel") { await h.controller.begin(1); await h.controller.cancel(); }
      else if (outcome === "blur") h.runtime.cancelPendingClickResponses();
      else if (outcome === "restore") expect(await h.runtime.restoreDefaultPosition(h.motionPort.resync)).toBe(true);
      else h.runtime.dispose();
      expect(h.responses.at(-1)).toBeNull();
      const responseCount = h.responses.length;
      callbacks.forEach(callback => callback());
      await h.advance(6000);
      expect(h.responses).toHaveLength(responseCount);
      if (outcome !== "dispose") {
        await h.click();
        expect(h.responses.at(-1)?.kind).toBe("hello");
      }
      h.runtime.dispose();
    },
  );

  it.each([1700, 3900])("finishes closing when paused at %s ms and accepts a later greeting", async pauseAt => {
    const h = await setup();
    for (let i = 0; i < 4; i++) await h.click();
    await h.advance(pauseAt);
    h.runtime.setAutonomyPaused(true);
    const position = h.position();
    await h.advance(9000 - pauseAt);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "playful", "cooldown"]);
    expect(h.runtime.state).toMatchObject({ behavior: "IDLE", autonomyPaused: true });
    expect(h.position()).toEqual(position);
    await h.click();
    expect(h.responses.at(-1)).toMatchObject({ kind: "hello", action: "blink" });
    h.runtime.dispose();
  });

  it("defers input avoidance until the accepted closing completes without replaying it", async () => {
    const h = await setup();
    for (let i = 0; i < 4; i++) await h.click();
    await h.advance(3900);
    expect(h.responses.at(-1)?.kind).toBe("cooldown");
    const callbacks = h.clock.callbacks();
    h.runtime.handleInputAvoidanceFact({ kind: "dynamic-line", approximate: false, revision: 1,
      monitorId: "monitor-1", workArea: WORK_AREA, monitorRevision: 1, focusSessionId: "session",
      forbiddenRegion: { left: 80, right: 300, top: 450, bottom: 600 } });
    await flush();
    expect(h.runtime.state.escapePlanId).toBeUndefined();
    expect(h.responses.at(-1)).not.toBeNull();
    await h.advance(1601);
    expect(h.runtime.state.escapePlanId).toBeDefined();
    expect(h.responses.at(-1)).toBeNull();
    const responseCount = h.responses.length;
    callbacks.forEach(callback => callback());
    h.runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 2 });
    await h.advance(6000);
    expect(h.responses).toHaveLength(responseCount);
    await h.click();
    expect(h.responses.at(-1)).toMatchObject({ kind: "hello", action: "blink" });
    h.runtime.dispose();
  });

  it("keeps qualified closing still when reduced motion is enabled during HAPPY", async () => {
    const h = await setup();
    for (let i = 0; i < 4; i++) await h.click();
    await h.advance(1700);
    h.runtime.setReducedMotion(true);
    await h.advance(5000);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "playful", "cooldown"]);
    expect(h.responses.at(-1)).toMatchObject({ action: "still" });
    expect(h.frames.filter(frame => frame.timestampMs >= 3800 && frame.timestampMs <= 5400)
      .every(frame => frame.animationId === "idle" && frame.frameIndex === 0)).toBe(true);
    h.runtime.dispose();
  });

  it("stops a real walk on press and responds to its confirmed click", async () => {
    const h = await setup({ random: () => 0.99 });
    await h.advance(8100);
    expect(h.runtime.state.behavior).toBe("WALK");
    await h.controller.begin(1);
    const position = h.position();
    await h.advance(200);
    expect(h.position()).toEqual(position);
    await h.controller.finish(1, "pointerup");
    expect(h.responses.at(-1)).toMatchObject({ kind: "walk", action: "look" });
    await h.advance(1700);
    expect(h.position()).toEqual(position);
    h.runtime.dispose();
  });

  it("preempts a pending playful upgrade at the unchanged 12px drag threshold", async () => {
    const h = await setup();
    await h.click(); await h.click(); await h.click();
    const callbacks = h.clock.callbacks();
    await h.controller.begin(1);
    h.controller.handleGlobalPointerSample(h.sample(DRAG_START_THRESHOLD_LOGICAL_PX - 1));
    expect(h.runtime.state.interaction).toBe("ARMED");
    h.controller.handleGlobalPointerSample(h.sample(DRAG_START_THRESHOLD_LOGICAL_PX, -100));
    await flush();
    expect(h.runtime.state.behavior).toBe("DRAG");
    expect(h.responses.at(-1)).toBeNull();
    const count = h.frames.length;
    callbacks.forEach(callback => callback());
    await h.advance(4000);
    expect(h.frames).toHaveLength(count);
    expect(h.runtime.state.behavior).toBe("DRAG");
    await h.controller.finish(1, "pointerup");
    await h.advance(3500);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello"]);
    expect(h.frames.some(frame => frame.animationId === "happy")).toBe(false);
    h.runtime.dispose();
  });

  it.each(["pointercancel", "lostpointercapture", "controller.cancel"] as const)("does not count %s as a click or preserve its queued upgrade", async outcome => {
    const h = await setup();
    await h.click(); await h.click(); await h.click();
    const callbacks = h.clock.callbacks();
    await h.controller.begin(1);
    if (outcome === "controller.cancel") await h.controller.cancel();
    else await h.controller.finish(1, outcome);
    expect(h.responses.at(-1)).toBeNull();
    callbacks.forEach(callback => callback());
    await h.advance(5000);
    expect(h.frames.some(frame => frame.animationId === "happy")).toBe(false);
    await h.click(); await h.click();
    await h.advance(2200);
    expect(h.responses.filter(Boolean).some(response => response!.kind === "playful")).toBe(false);
    h.runtime.dispose();
  });

  it("does not count any caught FALL release or LAND press toward the next three clicks", async () => {
    const h = await setup();
    await h.controller.begin(1);
    h.controller.handleGlobalPointerSample(h.sample(0, -300));
    await flush();
    await h.controller.finish(1, "pointerup");
    expect(h.runtime.state.behavior).toBe("FALL");
    for (let i = 0; i < 3; i++) {
      await h.click();
      expect(h.responses.filter(Boolean)).toHaveLength(0);
      expect(h.runtime.state.behavior).toBe("FALL");
    }
    for (let i = 0; i < 400 && h.runtime.state.behavior !== "LAND"; i++) await h.advance(20);
    expect(h.runtime.state.behavior).toBe("LAND");
    await h.controller.begin(1);
    await h.advance(2000);
    await h.controller.finish(1, "pointerup");
    expect(h.responses.filter(Boolean)).toHaveLength(0);
    await h.advance(1000);
    expect(h.runtime.state.behavior).toBe("IDLE");
    await h.click(); await h.click();
    await h.advance(2300);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["settled"]);
    h.runtime.dispose();
  });

  it.each([false, true])("uses settled only once and expires its context after five seconds (expired=%s)", async expired => {
    const h = await setup();
    h.runtime.setAutonomyPaused(true);
    await h.controller.begin(1);
    h.controller.handleGlobalPointerSample(h.sample(0, -100));
    await flush();
    await h.controller.finish(1, "pointerup");
    await h.advance(expired ? 7000 : 2000);
    expect(h.runtime.state.behavior).toBe("IDLE");
    await h.click();
    expect(h.responses.at(-1)?.kind).toBe(expired ? "hello" : "settled");
    await h.advance(5001); await h.click();
    expect(h.responses.at(-1)?.kind).toBe("hello");
    expect(h.responses.filter(response => response?.kind === "settled")).toHaveLength(expired ? 0 : 1);
    h.runtime.dispose();
  });

  it("keeps Home clicks seated at their original anchor and retains the awake start", async () => {
    const h = await setup({ home: true });
    const position = h.position();
    const start = h.runtime.state.homeAwakeStartedAtMs;
    for (let i = 0; i < 50; i++) { await h.click(); await h.advance(20); }
    await h.advance(3100);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["home"]);
    expect(h.runtime.state).toMatchObject({ behavior: "REST", activeAnimationId: "home_idle", homeAwakeStartedAtMs: start });
    expect(h.position()).toEqual(position);
    expect(h.frames.every(frame => frame.animationId === "home_idle" && frame.frameIndex === 0)).toBe(true);
    expect(h.runtime.state.homeQuietUntilMs).toBe(5000 + HOME_INTERACTION_QUIET_MS);
    await h.advance(HOME_AWAKE_DURATION_MS);
    expect(h.runtime.state.activeAnimationId).toBe("sleep");
    h.runtime.dispose();
  });

  it("wakes only on release, stays seated in Home, and starts one fresh 120-second awake period", async () => {
    const h = await setup({ home: true });
    await h.advance(HOME_AWAKE_DURATION_MS + 3000);
    const position = h.position();
    const stale = h.clock.callbacks();
    await h.controller.begin(1);
    await h.advance(300);
    expect(h.runtime.state.activeAnimationId).toBe("sleep");
    const wakeAt = h.clock.now();
    await h.controller.finish(1, "pointerup");
    expect(h.responses.at(-1)).toMatchObject({ kind: "wake", action: "wake", durationMs: 2000 });
    stale.forEach(callback => callback());
    for (let i = 0; i < 10; i++) { await h.click(); await h.advance(50); }
    await h.advance(3000);
    expect(h.runtime.state).toMatchObject({ behavior: "REST", activeAnimationId: "home_idle", homeAwakeStartedAtMs: wakeAt });
    expect(h.runtime.state.homeRestDeadlineMs).toBeUndefined();
    expect(h.position()).toEqual(position);
    expect(h.responses.filter(Boolean)).toHaveLength(1);
    await h.advance(115000);
    expect(h.runtime.state.activeAnimationId).toBe("home_idle");
    await h.advance(4000);
    expect(h.runtime.state.activeAnimationId).toBe("sleep");
    h.runtime.dispose();
  });

  it("uses a still greeting with reduced motion and clears an already queued jump", async () => {
    const h = await setup();
    await h.click(); await h.click(); await h.click();
    h.runtime.setReducedMotion(true);
    await h.advance(5000);
    for (let i = 0; i < 10; i++) { await h.click(); await h.advance(20); }
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "gentle"]);
    expect(h.responses.at(-1)).toMatchObject({ action: "still" });
    expect(h.frames.some(frame => frame.animationId === "happy")).toBe(false);
    h.runtime.dispose();
  });

  it("invalidates response callbacks when restoring position or disposing", async () => {
    const h = await setup();
    await h.click(); await h.click(); await h.click();
    const callbacks = h.clock.callbacks();
    expect(await h.runtime.restoreDefaultPosition(h.motionPort.resync)).toBe(true);
    const responses = h.responses.length;
    callbacks.forEach(callback => callback());
    await h.advance(4000);
    expect(h.responses).toHaveLength(responses);
    expect(h.frames.some(frame => frame.animationId === "happy")).toBe(false);
    await h.advance(1200); await h.click();
    const afterDisposeCallbacks = h.clock.callbacks();
    h.runtime.dispose();
    const count = h.frames.length;
    afterDisposeCallbacks.forEach(callback => callback());
    await h.advance(10000);
    expect(h.frames).toHaveLength(count);
    expect(h.responses.at(-1)).toBeNull();
  });

  it("does not let a later short burst bypass the cooldown after an upgrade", async () => {
    const h = await setup();
    for (let burst = 0; burst < 3; burst++) {
      for (let click = 0; click < 3; click++) { await h.click(); await h.advance(100); }
      await h.advance(2200);
    }
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "playful"]);
    await h.advance(2100); await h.click();
    expect(h.responses.filter(Boolean)).toHaveLength(3);
    h.runtime.dispose();
  });

  it("does not borrow a previous greeting's upgrade permission for a new burst", async () => {
    const h = await setup();
    await h.click();
    await h.advance(2200);
    for (let i = 0; i < 3; i++) { await h.click(); await h.advance(100); }
    await h.advance(2000);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello"]);
    h.runtime.dispose();
  });

  it("clears pending responses on focus loss without an active pointer or interrupting the current action", async () => {
    const h = await setup();
    await h.click(); await h.click(); await h.click();
    h.runtime.cancelPendingClickResponses();
    expect(h.runtime.state.behavior).toBe("LOOK");
    expect(h.responses.at(-1)).toBeNull();
    await h.advance(4000);
    expect(h.runtime.state.behavior).toBe("IDLE");
    expect(h.frames.some(frame => frame.animationId === "happy")).toBe(false);
    await h.advance(1100); await h.click(); await h.click();
    await h.advance(2200);
    expect(h.responses.filter(Boolean).map(response => response!.kind)).toEqual(["hello", "hello"]);
    h.runtime.dispose();
  });

  it("lets an already accepted HAPPY land safely after a cancelled pointer gesture", async () => {
    const h = await setup();
    await h.click(); await h.click(); await h.click();
    await h.advance(1700);
    expect(h.runtime.state.behavior).toBe("HAPPY");
    await h.controller.begin(1);
    await h.controller.cancel();
    expect(h.runtime.state.behavior).toBe("HAPPY");
    expect(h.responses.at(-1)).toBeNull();
    await h.advance(3000);
    expect(h.frames.some(frame => frame.animationId === "land")).toBe(true);
    expect(h.runtime.state.behavior).toBe("IDLE");
    expect(h.frames.filter(frame => frame.animationId === "happy" && frame.frameIndex === 0)).toHaveLength(1);
    h.runtime.dispose();
  });

  it.each(["blink", "gentle"] as const)("finishes an IDLE %s response when autonomy is paused and allows later clicks", async kind => {
    const h = await setup();
    if (kind === "blink") { await h.click(); await h.advance(5001); }
    else h.runtime.setReducedMotion(true);
    await h.click();
    expect(h.responses.at(-1)?.action).toBe(kind === "blink" ? "blink" : "still");
    h.runtime.setAutonomyPaused(true);
    await h.advance(6000);
    const count = h.responses.filter(Boolean).length;
    await h.click();
    expect(h.responses.filter(Boolean)).toHaveLength(count + 1);
    h.runtime.setAutonomyPaused(false);
    await h.advance(2000);
    expect(h.runtime.state.behavior).toBe("IDLE");
    h.runtime.dispose();
  });

  it("defers focused-input avoidance until a still response completes without stale work", async () => {
    const h = await setup();
    h.runtime.setReducedMotion(true);
    await h.click();
    const oldCallbacks = h.clock.callbacks();
    h.runtime.handleInputAvoidanceFact({ kind: "dynamic-line", approximate: false, revision: 1,
      monitorId: "monitor-1", workArea: WORK_AREA, monitorRevision: 1, focusSessionId: "session",
      forbiddenRegion: { left: 80, right: 300, top: 450, bottom: 600 } });
    await flush();
    expect(h.runtime.state.escapePlanId).toBeUndefined();
    expect(h.responses.at(-1)).not.toBeNull();
    await h.advance(1601);
    expect(h.runtime.state.escapePlanId).toBeDefined();
    expect(h.responses.at(-1)).toBeNull();
    oldCallbacks.forEach(callback => callback());
    h.runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 2 });
    await h.advance(6000);
    const count = h.responses.filter(Boolean).length;
    await h.click();
    expect(h.responses.filter(Boolean)).toHaveLength(count + 1);
    expect(h.responses.at(-1)).toMatchObject({ kind: "gentle", action: "still" });
    h.runtime.dispose();
  });
});


describe("1.3.6 repeated-click regression", () => {
  it("recovers responses under continuous 400ms clicks for 60 seconds", async () => {
    const h = await setup();
    h.runtime.setAutonomyPaused(true);
    const counts: number[] = [];
    for (let i = 0; i < 150; i++) {
      await h.eventClick(40); await h.advance(360);
      if (i % 25 === 24) counts.push(h.responses.filter(Boolean).length);
    }
    expect(counts.every((count, i) => i === 0 || count > counts[i - 1])).toBe(true);
    h.runtime.dispose();
  });

  it("does not hide existing copy or restart frames on a rejected cooldown click", async () => {
    const h = await setup();
    h.runtime.setAutonomyPaused(true);
    await h.click(); await h.advance(1800);
    const count = h.frames.length;
    await h.click();
    expect(h.responses).not.toContain(null);
    expect(h.frames).toHaveLength(count);
    h.runtime.dispose();
  });

  it("accepts pointerup received before asynchronous begin finishes", async () => {
    const h = await setup();
    await h.eventClick();
    expect(h.responses.filter(Boolean)).toHaveLength(1);
    expect(h.runtime.state.interaction).toBe("NONE");
    h.runtime.dispose();
  });
});


describe("1.3.6 production DOM event boundary", () => {
  it.each([0, 40, 150])("keeps later releases responsive over 30 normal rounds (%sms holds)", async holdMs => {
    const h = await setup();
    h.runtime.setAutonomyPaused(true);
    for (let round = 0; round < 30; round++) {
      const before = h.responses.filter(Boolean).length;
      await h.eventClick(holdMs);
      expect(h.runtime.state.interaction).toBe("NONE");
      expect(h.responses.filter(Boolean).length).toBe(before + 1);
      expect(h.bubbleText()).not.toBe("");
      await h.advance(5100);
    }
    h.runtime.dispose();
  });

  it("keeps a nearby LOOK frame stable through rejected clicks and polling", async () => {
    const h = await setup();
    h.runtime.setAutonomyPaused(true);
    await h.eventClick(40); await h.advance(1800);
    h.runtime.handlePointerSample({ x: 80, y: 80 });
    await h.advance(240);
    for (let i = 0; i < 2; i++) {
      const before = h.frames.filter(frame => frame.frameIndex === 0).length;
      await h.eventClick(40);
      h.runtime.handlePointerSample({ x: 80, y: 80 });
      expect(h.frames.filter(frame => frame.frameIndex === 0)).toHaveLength(before);
      expect(h.bubbleText()).not.toBe("");
      await h.advance(120);
    }
    h.runtime.dispose();
  });

  it.each(["pointercancel", "lostpointercapture"])("never upgrades %s into a response", async outcome => {
    const h = await setup();
    h.dispatch("pointerdown"); h.dispatch(outcome);
    await flush(); await flush();
    expect(h.responses.filter(Boolean)).toHaveLength(0);
    expect(h.runtime.state.interaction).toBe("NONE");
    await h.eventClick(40);
    expect(h.responses.filter(Boolean)).toHaveLength(1);
    h.runtime.dispose();
  });

  it("uses the drag threshold on samples observed before early release", async () => {
    const h = await setup();
    h.dispatch("pointerdown");
    h.controller.handleGlobalPointerSample(h.sample(DRAG_START_THRESHOLD_LOGICAL_PX));
    h.dispatch("pointerup");
    await flush(); await flush();
    expect(h.responses.filter(Boolean)).toHaveLength(0);
    expect(h.runtime.state.interaction).toBe("NONE");
    h.runtime.dispose();
  });
});


it("does not orphan a new same-id capture when a cancelled old begin resolves late", async () => {
  const h = await setup();
  let resolve!: (sample: NativePointerSnapshotV1) => void;
  h.samplePort.readPointerSample = () => new Promise(done => { resolve = done; });
  h.dispatch("pointerdown"); await flush();
  h.dispatch("pointercancel"); await flush(); await flush();
  h.samplePort.readPointerSample = async () => h.sample();
  h.dispatch("pointerdown"); await flush(); await flush();
  expect(h.runtime.state.interaction).toBe("ARMED");
  resolve(h.sample()); await flush(); await flush();
  h.dispatch("pointerup"); await flush(); await flush();
  expect(h.runtime.state.interaction).toBe("NONE");
  expect(h.responses.filter(Boolean)).toHaveLength(1);
  await h.advance(5100); await h.eventClick(40);
  expect(h.responses.filter(Boolean)).toHaveLength(2);
  h.runtime.dispose();
});


it("clears runtime arming even when the native unlock reports failure", async () => {
  const h = await setup();
  await h.controller.begin(1);
  h.samplePort.setInteractionLock = async locked => { if (!locked) throw new Error("unlock failed"); };
  await expect(h.controller.finish(1, "pointerup")).rejects.toThrow("unlock failed");
  expect(h.runtime.state.interaction).toBe("NONE");
  expect(h.controller.phase).toBe("NONE");
  h.samplePort.setInteractionLock = async () => undefined;
  await h.advance(5100); await h.eventClick(40);
  expect(h.responses.filter(Boolean)).toHaveLength(2);
  h.runtime.dispose();
});

it.each(["cancel", "dispose"])("drops a pending early release after %s and ignores late preparation", async outcome => {
  const h = await setup();
  let resolve!: (sample: NativePointerSnapshotV1) => void;
  h.samplePort.readPointerSample = () => new Promise(done => { resolve = done; });
  h.dispatch("pointerdown"); await flush();
  h.dispatch("pointerup");
  if (outcome === "dispose") { h.binding.dispose(); h.runtime.dispose(); }
  else h.binding.cancel();
  await flush(); await flush();
  const frames = h.frames.length;
  resolve(h.sample()); await flush(); await flush();
  expect(h.responses.filter(Boolean)).toHaveLength(0);
  expect(h.frames).toHaveLength(frames);
  expect(h.controller.phase).toBe("NONE");
  h.runtime.dispose();
});

it("rearms only expired idle timers after holding and cancelling a click", async () => {
  const h = await setup();
  h.dispatch("pointerdown"); await flush();
  await h.advance(9000);
  h.dispatch("pointercancel"); await flush(); await flush();
  const frames = h.frames.length;
  expect(h.runtime.state.interaction).toBe("NONE");
  await h.advance(2700);
  expect(h.frames.slice(frames).some(frame => frame.animationId === "blink")).toBe(true);
  h.runtime.dispose();
});

it("restores LOOK exit after its timer expires during a cancelled hold", async () => {
  const h = await setup();
  h.runtime.handlePointerSample({ x: 80, y: 80 });
  h.runtime.handlePointerSample({ x: 900, y: 900 });
  h.dispatch("pointerdown"); await flush();
  await h.advance(800);
  h.dispatch("pointercancel"); await flush(); await flush();
  await h.advance(501);
  expect(h.runtime.state.behavior).toBe("IDLE");
  expect(h.runtime.state.interaction).toBe("NONE");
  h.runtime.dispose();
});

describe("1.3.8 synchronous stationary release", () => {
  it("does not reuse an ended promise for a newer same-stack gesture", async () => {
    const h = await setup();
    expect(h.runtime.beginPointerGesture()).toBe(true);
    const first = h.runtime.endPointerGesture({ triggerHappy: true });
    expect(h.runtime.state.interaction).toBe("NONE");
    expect(h.runtime.beginPointerGesture()).toBe(true);
    const second = h.runtime.endPointerGesture({ triggerHappy: true });
    expect(second).not.toBe(first);
    expect(h.runtime.state.interaction).toBe("NONE");
    await Promise.all([first, second]);
    h.binding.dispose(); h.runtime.dispose();
  });
  it("suppresses a cancelled session while still clearing its ARMED state", async () => {
    const h = await setup();
    expect(h.runtime.beginPointerGesture()).toBe(true);
    expect(await h.runtime.endPointerGesture({ triggerHappy: true, isCurrent: () => false })).toBe(false);
    expect(h.runtime.state.interaction).toBe("NONE");
    expect(h.responses.filter(Boolean)).toEqual([]);
    h.binding.dispose(); h.runtime.dispose();
  });
});

describe("1.3.8 moving-origin release cancellation", () => {
  it.each(["lifecycle", "controller"] as const)("cancels %s while real WALK release resync is pending", async kind => {
    const h = await setup({ random: () => 0.99 });
    await h.advance(8100);
    expect(h.runtime.state.behavior).toBe("WALK");
    h.dispatch("pointerdown"); await flush(); await flush();
    expect(h.runtime.state.interaction).toBe("ARMED");
    const snapshot = await h.motionPort.resync();
    let resolve!: (value: MotionSnapshot) => void;
    const waiting = new Promise<MotionSnapshot>(done => { resolve = done; });
    h.motionPort.resync = () => waiting;
    h.dispatch("pointerup"); await flush();
    expect(h.runtime.state.interaction).toBe("ARMED");
    if (kind === "lifecycle") h.runtime.cancelPendingClickResponses();
    h.binding.cancel();
    resolve(snapshot); await flush(); await flush();
    expect(h.runtime.state.interaction).toBe("NONE");
    expect(h.responses.filter(Boolean)).toEqual([]);
    h.binding.dispose(); h.runtime.dispose();
  });
});
