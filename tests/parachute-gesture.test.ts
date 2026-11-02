import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TimelineClock, TimelineFrameEvent } from "../src/animation-timeline";
import { createCurrentWorkAreaSnapshot, createMotionSnapshot, type CurrentWorkAreaSnapshot, type PetMotionPort } from "../src/native-motion";
import { NATIVE_PLATFORM_PROTOCOL_VERSION, type NativePlatformPort, type NativeSetOverlayFrameArgs } from "../src/native-platform";
import { ParachuteViewportAdapter } from "../src/parachute-viewport";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import { PetRuntime } from "../src/pet-runtime";
import { DRAG_START_THRESHOLD_LOGICAL_PX, PointerGestureController, type PointerGestureEnd } from "../src/pointer-gesture";

const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(
  readFileSync(new URL("../public/character/manifest.json", import.meta.url), "utf8"),
)));
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
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Real gesture thresholds and viewport serialization; only the OS boundary is fake.
async function setup(options: { x?: number; y?: number; homeMonitor?: string } = {}) {
  const clock = new Clock();
  const nativeState = { x: options.x ?? 100, y: options.y ?? 100, height: 160, cursorX: 180, cursorY: 160 };
  const area = { x: 0, y: 0, width: 800, height: 1_000 };
  let revision = 0;
  let failedResync: "null" | "undefined" | "reject" | "stale" | undefined;
  let beforeFrame: ((frame: NativeSetOverlayFrameArgs) => Promise<void>) | undefined;
  let readWorkArea: (() => Promise<CurrentWorkAreaSnapshot | null>) | undefined;
  const sizes: boolean[] = [];
  const positions: Array<{ x: number; y: number }> = [];
  const frames: TimelineFrameEvent[] = [];
  const locks: boolean[] = [];
  const raw: NativePlatformPort = {
    desktopSnapshot: async () => ({
      protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION, snapshotRevision: ++revision,
      capturedAtMonotonicMs: clock.now(), currentMonitorId: "m1", windowScaleFactor: 1, monitorScaleFactor: 1,
      workArea: area, windowPosition: { space: "WINDOW_TOP_LEFT_LOGICAL", x: nativeState.x, y: nativeState.y },
      homeWindow: { ready: true, currentMonitorId: options.homeMonitor ?? "m1", windowScaleFactor: 1,
        rect: { x: 520, y: 744, width: 256, height: 256 } },
    }),
    pointerSnapshot: async () => ({
      protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION, snapshotRevision: ++revision,
      capturedAtMonotonicMs: clock.now(), scaleFactor: 1,
      cursorScreenLogical: { x: nativeState.cursorX, y: nativeState.cursorY },
      windowOuterTopLeftLogical: { x: nativeState.x, y: nativeState.y },
      relativeLogical: { x: nativeState.cursorX - nativeState.x, y: nativeState.cursorY - nativeState.y },
    }),
    setOverlayFrame: async frame => {
      await beforeFrame?.(frame);
      nativeState.x = frame.x; nativeState.y = frame.y; nativeState.height = frame.height;
    },
    setOverlayPosition: async next => {
      nativeState.x = next.x; nativeState.y = next.y;
      positions.push({ x: next.x, y: next.y });
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
      if (failedResync === "reject") throw new Error("release geometry unavailable");
      if (failedResync === "null") return null;
      if (failedResync === "undefined") return undefined as unknown as null;
      const snapshot = createMotionSnapshot(await viewport.desktopSnapshot());
      return failedResync === "stale" ? { ...snapshot, snapshotRevision: 0 } : snapshot;
    },
    readCurrentWorkArea: async () => readWorkArea ? readWorkArea() : createCurrentWorkAreaSnapshot(await viewport.desktopSnapshot()),
    writeWindowTopLeft: async position => viewport.setOverlayPosition({ windowLabel: "main", x: position.x, y: position.y }),
  };
  const runtime = new PetRuntime(resources, {
    clock, random: () => 0, homeRandom: () => 0, motionPort: motion,
    setParachuteExpanded: expanded => { sizes.push(expanded); return viewport.setExpanded(expanded); },
    onFrame: frame => frames.push(frame),
  });
  const controller = new PointerGestureController(runtime, {
    readPointerSample: () => viewport.pointerSnapshot(),
    setInteractionLock: async locked => { locks.push(locked); }, setPointerPressed: () => {},
  }, motion);
  await runtime.initialize(async () => undefined);
  runtime.setAutonomyPaused(true);
  await flush();
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) { clock.step(Math.min(10, ms - elapsed)); await flush(); }
  };
  const begin = async (id: number) => {
    nativeState.cursorX = runtime.state.logicalPosition!.x + 80;
    nativeState.cursorY = runtime.state.logicalPosition!.y + 60;
    return controller.begin(id);
  };
  const moveBy = async (dx: number, dy = 0) => {
    nativeState.cursorX += dx; nativeState.cursorY += dy;
    controller.handleGlobalPointerSample(await viewport.pointerSnapshot());
    await flush();
  };
  const finish = async (id: number, outcome: PointerGestureEnd | "blur") => {
    if (outcome === "blur") await controller.cancel();
    else await controller.finish(id, outcome);
    await flush();
  };
  const drop = async () => {
    expect(await begin(1)).toBe(true);
    await moveBy(DRAG_START_THRESHOLD_LOGICAL_PX + 1);
    expect(controller.phase).toBe("DRAG");
    await finish(1, "pointerup");
  };
  return { runtime, controller, viewport, nativeState, sizes, positions, frames, locks, advance, begin, moveBy, finish, drop,
    failResync: (mode: "null" | "undefined" | "reject" | "stale") => { failedResync = mode; },
    interceptFrame: (callback: typeof beforeFrame) => { beforeFrame = callback; },
    interceptWorkArea: (callback: typeof readWorkArea) => { readWorkArea = callback; },
    restore: () => runtime.restoreDefaultPosition(async () => {
      await raw.setOverlayFrame({ windowLabel: "main", x: 320, y: 860, width: 160, height: 160 });
      return createMotionSnapshot(await viewport.desktopSnapshot());
    }),
  };
}

describe("parachute release through the real pointer gesture", () => {
  it.each(["pointerup", "pointercancel", "lostpointercapture", "blur"] as const)(
    "reopens after an ARMED high re-grab ending with %s and keeps its held pose", async outcome => {
      const t = await setup();
      await t.drop();
      await t.advance(400);
      expect(t.runtime.state.parachutePhase).toBe("GLIDING");
      const heldFrame = t.frames.at(-1);
      const beforeGrab = t.frames.length;
      const position = { ...t.runtime.state.logicalPosition! };
      expect(await t.begin(2)).toBe(true);
      await t.moveBy(DRAG_START_THRESHOLD_LOGICAL_PX - 0.01);
      expect(t.controller.phase).toBe("ARMED");
      expect(t.runtime.state).toMatchObject({ interaction: "ARMED", parachutePhase: "NONE" });
      expect(t.nativeState.height).toBe(160);
      await t.advance(800);
      expect(t.runtime.state.logicalPosition).toEqual(position);
      expect(t.frames).toHaveLength(beforeGrab);
      await t.finish(2, outcome);
      expect(t.runtime.state).toMatchObject({ behavior: "FALL", interaction: "NONE", parachutePhase: "OPENING" });
      await t.advance(700);
      expect(t.runtime.state).toMatchObject({ parachutePhase: "GLIDING", verticalVelocityLogicalPxPerSecond: 95 });
      expect(t.sizes).toEqual([true, false, true]);
      expect(t.nativeState.height).toBe(240);
      expect(t.frames.at(-1)).toBe(heldFrame);
      expect(t.frames).toHaveLength(beforeGrab);
      await t.finish(2, "lostpointercapture");
      await t.finish(2, "blur");
      expect(t.sizes.filter(Boolean)).toHaveLength(2);
      t.runtime.dispose();
    },
  );

  it("reopens on each consecutive zero-movement catch, then still supports a real drag", async () => {
    const t = await setup();
    await t.drop();
    await t.advance(400);
    for (const id of [2, 3, 4]) {
      expect(await t.begin(id)).toBe(true);
      expect(t.controller.phase).toBe("ARMED");
      await t.finish(id, "pointerup");
      await t.advance(350);
      expect(t.runtime.state.parachutePhase).toBe("GLIDING");
      expect(t.sizes.filter(Boolean)).toHaveLength(id);
    }
    expect(await t.begin(5)).toBe(true);
    await t.moveBy(DRAG_START_THRESHOLD_LOGICAL_PX);
    expect(t.controller.phase).toBe("DRAG");
    expect(t.frames.at(-1)!.animationId).toBe("drag");
    await t.finish(5, "pointerup");
    await t.advance(350);
    expect(t.runtime.state.parachutePhase).toBe("GLIDING");
    expect(t.frames.at(-1)!.animationId).toBe("fall");
    expect(t.sizes.filter(Boolean)).toHaveLength(5);
    t.runtime.dispose();
  });

  it.each([{ x: 100, landingY: 860 }, { x: 521, landingY: 792 }])(
    "keeps a re-grab below 280px above the real landing surface in free fall (x=$x)", async ({ x, landingY }) => {
      const t = await setup({ x });
      await t.drop();
      while (t.runtime.state.logicalPosition!.y <= landingY - 279) await t.advance(20);
      expect(t.runtime.state.parachutePhase).toBe("GLIDING");
      expect(await t.begin(2)).toBe(true);
      await t.finish(2, "pointerup");
      await t.advance(350);
      expect(t.runtime.state.parachutePhase).toBe("NONE");
      expect(t.sizes.filter(Boolean)).toHaveLength(1);
      expect(new Set(t.frames.slice(-3).map(frame => frame.frameIndex))).toEqual(new Set([0, 1]));
      t.runtime.dispose();
    },
  );

  it.each([
    { x: 100, y: 580, homeMonitor: "m1", open: true },
    { x: 100, y: 581, homeMonitor: "m1", open: false },
    { x: 521, y: 512, homeMonitor: "m1", open: true },
    { x: 521, y: 513, homeMonitor: "m1", open: false },
    { x: 521, y: 513, homeMonitor: "another-monitor", open: true },
  ])("measures fresh release geometry at the 280px boundary (x=$x, y=$y, home=$homeMonitor)", async ({ x, y, homeMonitor, open }) => {
    const t = await setup({ x, homeMonitor });
    await t.drop();
    await t.advance(400);
    expect(await t.begin(2)).toBe(true);
    // A native relocation while held makes the release snapshot authoritative.
    // The runtime's old suspended FALL coordinates still describe a high drop.
    t.nativeState.x = x;
    t.nativeState.y = y;
    await t.finish(2, "pointerup");
    expect(t.runtime.state.logicalPosition!.y).toBe(y);
    expect(t.runtime.state.parachutePhase).toBe(open ? "OPENING" : "NONE");
    expect(t.sizes.filter(Boolean)).toHaveLength(open ? 2 : 1);
    t.runtime.dispose();
  });

  it("waits through a delayed native collapse before a quick ARMED release reopens", async () => {
    const t = await setup();
    await t.drop();
    await t.advance(400);
    const closed = deferred();
    t.interceptFrame(async frame => { if (frame.height === 160) await closed.promise; });
    const starting = t.begin(2);
    await flush();
    expect(t.controller.phase).toBe("ARMED");
    expect(t.runtime.state.parachutePhase).toBe("NONE");
    const ending = t.finish(2, "pointerup");
    await flush();
    await t.advance(700);
    expect(t.sizes).toEqual([true, false]);
    closed.resolve();
    await Promise.all([starting, ending]);
    await t.advance(350);
    expect(t.runtime.state).toMatchObject({ behavior: "FALL", interaction: "NONE", parachutePhase: "GLIDING" });
    expect(t.sizes).toEqual([true, false, true]);
    expect(t.viewport.topInset).toBe(80);
    expect(t.nativeState.height).toBe(240);
    t.runtime.dispose();
  });

  it("ignores old in-flight WorkArea facts while a high re-grab is held ARMED", async () => {
    const t = await setup();
    await t.drop();
    await t.advance(400);
    const oldFacts = deferred();
    let reads = 0;
    t.interceptWorkArea(async () => {
      reads++;
      await oldFacts.promise;
      return { currentMonitorId: "m1", windowScaleFactor: 1, workArea: { x: 0, y: 0, width: 800, height: 200 } };
    });
    await t.advance(500);
    expect(reads).toBe(1);
    expect(await t.begin(2)).toBe(true);
    const heldPosition = { ...t.runtime.state.logicalPosition! };
    const writes = t.positions.length;
    const heldFrame = t.frames.at(-1);

    t.interceptWorkArea(undefined);
    oldFacts.resolve();
    await flush();
    await t.advance(800);
    expect(t.runtime.state).toMatchObject({
      behavior: "FALL", interaction: "ARMED", parachutePhase: "NONE",
      logicalPosition: heldPosition, groundTopY: 860,
    });
    expect(t.positions).toHaveLength(writes);
    expect(t.frames.at(-1)).toBe(heldFrame);

    await t.finish(2, "pointerup");
    await t.advance(350);
    expect(t.runtime.state).toMatchObject({ behavior: "FALL", interaction: "NONE", parachutePhase: "GLIDING", groundTopY: 860 });
    expect(t.sizes).toEqual([true, false, true]);
    expect(t.viewport.topInset).toBe(80);
    expect(t.nativeState.height).toBe(240);
    await t.advance(10_000);
    expect(t.runtime.state).toMatchObject({ behavior: "IDLE", interaction: "NONE", parachutePhase: "NONE" });
    expect(t.viewport.topInset).toBe(0);
    expect(t.nativeState.height).toBe(160);
    t.runtime.dispose();
  });

  it("ignores old in-flight WorkArea facts after the next ARMED release", async () => {
    const t = await setup();
    await t.drop();
    await t.advance(400);
    const oldFacts = deferred();
    let reads = 0;
    t.interceptWorkArea(async () => {
      reads++;
      await oldFacts.promise;
      return { currentMonitorId: "m1", windowScaleFactor: 1, workArea: { x: 0, y: 0, width: 800, height: 600 } };
    });
    await t.advance(500);
    expect(reads).toBe(1);
    expect(await t.begin(2)).toBe(true);
    await t.finish(2, "pointerup");
    await t.advance(350);
    expect(t.runtime.state.parachutePhase).toBe("GLIDING");
    const heldFrame = t.frames.at(-1);
    t.interceptWorkArea(undefined);
    oldFacts.resolve();
    await flush();
    expect(t.runtime.state).toMatchObject({ behavior: "FALL", parachutePhase: "GLIDING", groundTopY: 860 });
    expect(t.frames.at(-1)).toBe(heldFrame);
    expect(t.sizes).toEqual([true, false, true]);
    t.runtime.dispose();
  });

  it.each(["null", "undefined", "reject", "stale"] as const)("stops without guessing coordinates when an ARMED release resync returns %s", async mode => {
    const t = await setup();
    await t.drop();
    await t.advance(400);
    expect(await t.begin(2)).toBe(true);
    const writes = t.positions.length;
    t.failResync(mode);
    await expect(t.finish(2, "pointerup")).resolves.toBeUndefined();
    expect(t.runtime.state).toMatchObject({ interaction: "NONE", isDragging: false, parachutePhase: "NONE", restoreStatus: "failed" });
    expect(t.runtime.canRestorePosition).toBe(true);
    await t.advance(5_000);
    expect(t.sizes.filter(Boolean)).toHaveLength(1);
    expect(t.positions).toHaveLength(writes);
    expect(t.locks.at(-1)).toBe(false);
    expect(await t.restore()).toBe(true);
    expect(t.runtime.state).toMatchObject({ behavior: "IDLE", restoreStatus: "idle", logicalPosition: { x: 320, y: 860 } });
    t.runtime.dispose();
  });
});
