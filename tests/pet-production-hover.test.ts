import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import { PetRuntime, type PetInteractionResponse } from "../src/pet-runtime";
import { PointerGestureController } from "../src/pointer-gesture";
import { PointerHitBoxController, POLL_INTERVAL_MS } from "../src/pointer-hitbox";
import { FocusedInputGeometryAdapter } from "../src/input-avoidance";
import { bindPetPointerEvents } from "../src/pet-pointer-events";
import { PetBubbleController } from "../src/pet-bubble";
import { updatePetBubbleSurface, type PetBubbleSurface } from "../src/pet-bubble-surface";
import { createMotionSnapshot } from "../src/native-motion";
import type { NativeDesktopSnapshotV1 } from "../src/native-platform";

const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(readFileSync(
  new URL("../public/character/manifest.json", import.meta.url), "utf8"))));
const traces: unknown[] = [];
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers();
  if (process.env.LINEDOG_HOVER_REPORT) writeFileSync(process.env.LINEDOG_HOVER_REPORT, JSON.stringify(traces, null, 2)); });

async function setup(name: string, focus: "none" | "overlap" = "none", latency = 7) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  const events: unknown[] = []; traces.push({ name, focus, latency, events });
  let runtime: PetRuntime | undefined, gesture: PointerGestureController | undefined;
  let position = { x: 100, y: 460 }, near = true, revision = 0, currentFrame = resources.idle.frames[0], compact = false;
  const responses: PetInteractionResponse[] = [];
  const surface: PetBubbleSurface = { textContent: "", dataset: {}, style: { left: "", top: "" },
    get offsetWidth() { return this.dataset.compact === "true" ? 60 : 68; },
    get offsetHeight() { return this.dataset.compact === "true" ? 14 : 18; } };
  const log = (kind: string, data: unknown = {}) => {
    const internals = runtime as unknown as { behaviorRevision?: number; interactionResponse?: { event: PetInteractionResponse; revision: number } };
    events.push({ at: performance.now(), kind, data, behavior: runtime?.state.behavior,
      interaction: runtime?.state.interaction, behaviorRevision: internals?.behaviorRevision,
      responseId: internals?.interactionResponse?.event.id, responseRevision: internals?.interactionResponse?.revision,
      text: surface.textContent, visible: surface.dataset.visible });
  };
  const layout = () => updatePetBubbleSurface(surface, { frame: currentFrame, facing: "Right",
    grabBounds: { x: 32, y: 28, width: 96, height: 110 }, windowPosition: position,
    workArea: { x: 0, y: 0, width: 1000, height: 600 }, compact });
  const bubbles = new PetBubbleController(text => { surface.textContent = text; if (!text) compact = false; layout(); log("bubble-render"); }, undefined, () => 0);
  const delay = async () => { if (latency) await new Promise(resolve => setTimeout(resolve, latency)); };
  const desktop = async (): Promise<NativeDesktopSnapshotV1> => {
    await delay();
    const result: NativeDesktopSnapshotV1 = { protocolVersion: 1, snapshotRevision: ++revision,
      capturedAtMonotonicMs: performance.now(), currentMonitorId: "monitor-1", windowScaleFactor: 1,
      monitorScaleFactor: 1, workArea: { x: 0, y: 0, width: 1000, height: 600 },
      windowPosition: { space: "WINDOW_TOP_LEFT_LOGICAL", ...position }, homeWindow: null };
    runtime?.handleDesktopSnapshot(createMotionSnapshot(result));
    return result;
  };
  const motion = { resync: async () => createMotionSnapshot(await desktop()),
    writeWindowTopLeft: async (next: { x: number; y: number }) => { await delay(); position = { x: next.x, y: next.y }; log("native-position", position); } };
  runtime = new PetRuntime(resources, { random: () => 0, motionPort: motion,
    onFrame: event => { currentFrame = event.frame; layout(); log("frame", { animation: event.animationId, frame: event.frameIndex }); },
    onStateChange: state => { const moving = ["DRAG", "FALL", "LAND", "GO_HOME", "LEAVE_HOME"].includes(state.behavior) || state.restoreStatus === "busy";
      bubbles.update(!!runtime?.canShowIdleBubble, moving); layout(); log("state"); },
    onInteractionAcknowledged: () => { bubbles.acknowledgeClick(); log("click-acknowledged"); },
    onInteractionResponse: response => { if (response) responses.push(response); bubbles.respond(response); compact = response?.kind === "playful"; layout(); log("response", response); },
  });
  const pointer = new PointerHitBoxController({
    pointerSnapshot: async () => { await delay(); return { protocolVersion: 1, snapshotRevision: ++revision,
      capturedAtMonotonicMs: performance.now(), cursorScreenLogical: { x: position.x + (near ? 80 : 900), y: position.y + 80 },
      windowOuterTopLeftLogical: position, relativeLogical: { x: near ? 80 : 900, y: 80 }, scaleFactor: 1 }; },
    setWindowClickThrough: async args => { await delay(); log("native-click-through", args); },
  }, { setPressed: value => log("pressed", value) }, { onPointerSample: sample => {
    runtime?.handlePointerSample(sample.relativeLogical); gesture?.handleGlobalPointerSample(sample); log("pointer-poll");
  } });
  gesture = new PointerGestureController(runtime, pointer, motion);
  const focusAdapter = new FocusedInputGeometryAdapter({ readDesktopSnapshot: desktop,
    readFocusedInputSnapshot: async request => { await delay(); log("focus-native", focus); return { ...request,
      kind: focus === "overlap" ? "dynamic-line" : "none", approximate: false,
      rectPhysical: focus === "overlap" ? { left: 120, top: 490, right: 220, bottom: 520 } : null,
      textFocus: focus === "overlap", activeCaret: focus === "overlap", singleVisualBand: focus === "overlap",
      caretEvidenceKind: focus === "overlap" ? "dynamic-line" : "none", busy: false }; },
    onFact: fact => { log("avoidance-before", fact); runtime!.handleInputAvoidanceFact(fact); log("avoidance-after"); } });
  const target = new EventTarget() as unknown as HTMLElement;
  let captured = false;
  target.setPointerCapture = () => { captured = true; };
  target.hasPointerCapture = () => captured;
  target.releasePointerCapture = () => { captured = false; };
  const binding = bindPetPointerEvents(target, { gesture: () => gesture, isCoreHit: () => true,
    activity: () => bubbles.activity(), onError: error => log("error", String(error)) });
  const emit = (type: string) => { log(type); const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0 }); target.dispatchEvent(event); };
  const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };
  const click = async (hold = 40) => { emit("pointerdown"); await advance(hold); emit("pointerup"); await advance(60); log("click-feedback"); };
  cleanup = () => { log("teardown"); focusAdapter.dispose(); pointer.dispose(); binding.dispose(); bubbles.dispose(); runtime!.dispose(); vi.clearAllTimers(); };
  const ready = runtime.initialize(async () => undefined); await advance(100); await ready;
  pointer.startPolling(); focusAdapter.start(); await advance(Math.max(100, latency * 3 + 20));
  expect(runtime.state.pointerNearby).toBe(true);
  if (focus === "none") expect(events.some((event: any) => event.kind === "avoidance-before" &&
    event.data.kind === "none" && event.data.approximate === false)).toBe(true);
  return { runtime, responses, click, emit, advance, surface, events, log, focusAdapter, pointer, pollMs: POLL_INTERVAL_MS, setNear: (value: boolean) => { near = value; } };
}

describe("nearby pointer through production sampling and DOM event paths", () => {
  it("keeps feedback visible for legal second-to-fourth clicks inside action cooldown", async () => {
    const h = await setup("nearby-ordinary-clicks");
    for (let i = 0; i < 5; i++) {
      await h.click();
      expect(h.surface.textContent, `click ${i + 1} at ${performance.now()}`).not.toBe("");
      expect(h.surface.dataset.visible).toBe("true");
      await h.advance(1150);
    }
  });

  it("does not let a 250ms input-avoidance tick cancel the accepted blink response", async () => {
    const h = await setup("nearby-overlapping-focus", "overlap");
    await h.click(); await h.advance(5100);
    await h.click();
    expect(h.responses.at(-1)?.action).toBe("blink");
    await h.advance(350);
    expect(h.surface.textContent).not.toBe("");
    expect(h.runtime.state.activeAnimationId).toBe("blink");
  });
});


it("preserves the third-click upgrade across the 1600ms completion while hovering over input", async () => {
  const h = await setup("three-clicks-across-completion", "overlap");
  const start = performance.now();
  for (const offset of [0, 800, 1700]) {
    await h.advance(start + offset - performance.now()); await h.click();
  }
  expect(h.responses.map(response => response.kind)).toEqual(["hello", "playful"]);
  expect(h.surface.textContent).not.toBe("");
});

it("does not escape after the first LOOK ends while the pointer is still nearby", async () => {
  const h = await setup("look-completion-no-escape", "overlap");
  await h.click(); await h.advance(1700);
  expect(h.surface.textContent).not.toBe("");
  expect(h.runtime.state.motionOwner).not.toBe("INPUT_AVOIDANCE");
  const frames = h.events.filter((event: any) => event.kind === "frame") as any[];
  expect(frames.some(event => ["walk", "turn"].includes(event.data.animation))).toBe(false);
});

it("protects an active blink after the pointer leaves, then resumes safe avoidance later", async () => {
  const h = await setup("blink-pointer-leaves", "overlap");
  await h.click(); await h.advance(5100); await h.click();
  h.setNear(false); await h.advance(350);
  expect(h.surface.textContent).not.toBe("");
  expect(h.runtime.state.activeAnimationId).toBe("blink");
  await h.advance(1900);
  expect(h.runtime.state.motionOwner).toBe("INPUT_AVOIDANCE");
});

it.each([0, 7, 35])("keeps feedback and a bounded action rate for 60s hover clicks with %sms native latency", async latency => {
  const h = await setup(`long-hover-${latency}`, "none", latency);
  for (let i = 0; i < 60; i++) {
    h.emit("pointerdown"); await h.advance(20); h.emit("pointerup"); await h.advance(200);
    expect(h.runtime.state.interaction).toBe("NONE");
    expect(h.surface.textContent).not.toBe("");
    expect(h.surface.dataset.visible).toBe("true");
    await h.advance(780);
  }
  expect(h.responses.length).toBeGreaterThan(6);
  expect(h.responses.length).toBeLessThan(35);
});

it("does not insert idle and restart look when a greeting finishes under a nearby pointer", async () => {
  const h = await setup("nearby-look-completion-stability");
  await h.click();
  const afterClick = h.events.length;
  await h.advance(1900);
  const frames = h.events.slice(afterClick).filter((event: any) => event.kind === "frame") as any[];
  expect(frames.some(event => event.data.animation === "idle")).toBe(false);
  expect(h.runtime.state.behavior).toBe("LOOK");
  expect(h.surface.textContent).not.toBe("");
  h.setNear(false); await h.advance(400);
  expect(h.runtime.state.behavior).toBe("LOOK");
  await h.advance(250);
  expect(h.runtime.state.behavior).toBe("IDLE");
  const resumed = h.events.length;
  await h.advance(2800);
  expect(h.events.slice(resumed).some((event: any) => event.kind === "frame" && event.data.animation === "blink")).toBe(true);
});
