import { describe, expect, it, vi } from "vitest";
import { ParachuteViewportAdapter } from "../src/parachute-viewport";
import {
  NATIVE_PLATFORM_PROTOCOL_VERSION,
  type NativeDesktopSnapshotV1,
  type NativePlatformPort,
  type NativeSetOverlayFrameArgs,
  type NativeSetOverlayPositionArgs,
} from "../src/native-platform";
import { HIT_BOX, resolveHitState } from "../src/pointer-hitbox";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(initialScale = 1) {
  const state = { x: -400 * initialScale, y: 300 * initialScale, width: 160 * initialScale,
    height: 160 * initialScale, scale: initialScale, cursorX: -320 * initialScale, cursorY: 360 * initialScale };
  let revision = 0;
  const frames: NativeSetOverlayFrameArgs[] = [];
  const positions: NativeSetOverlayPositionArgs[] = [];
  const frameSteps: Array<(args: NativeSetOverlayFrameArgs) => Promise<void>> = [];
  const positionSteps: Array<() => Promise<void>> = [];
  const raw: NativePlatformPort = {
    desktopSnapshot: vi.fn(async (): Promise<NativeDesktopSnapshotV1> => ({
      protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION, snapshotRevision: ++revision,
      capturedAtMonotonicMs: revision, currentMonitorId: "negative-monitor",
      workArea: { x: -1000, y: -100, width: 2000, height: 1200 },
      windowPosition: { space: "WINDOW_TOP_LEFT_LOGICAL", x: state.x / state.scale, y: state.y / state.scale },
      windowScaleFactor: state.scale, monitorScaleFactor: state.scale,
      homeWindow: { ready: true, currentMonitorId: "negative-monitor", windowScaleFactor: state.scale,
        rect: { x: 0, y: 800, width: 256, height: 256 } },
    })),
    pointerSnapshot: vi.fn(async () => ({
      protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION, snapshotRevision: ++revision,
      capturedAtMonotonicMs: revision,
      cursorScreenLogical: { x: state.cursorX / state.scale, y: state.cursorY / state.scale },
      windowOuterTopLeftLogical: { x: state.x / state.scale, y: state.y / state.scale },
      relativeLogical: { x: (state.cursorX - state.x) / state.scale, y: (state.cursorY - state.y) / state.scale },
      scaleFactor: state.scale,
    })),
    setOverlayFrame: vi.fn(async args => {
      frames.push(args);
      const step = frameSteps.shift();
      if (step) return step(args);
      applyFrame(args);
    }),
    setOverlayPosition: vi.fn(async args => {
      positions.push(args);
      const scale = args.coordinateScaleFactor ?? state.scale;
      state.x = Math.round(args.x * scale);
      state.y = Math.round(args.y * scale);
      await positionSteps.shift()?.();
    }),
    focusedInputSnapshot: vi.fn(async request => ({ ...request, kind: "none", rectPhysical: null,
      approximate: false, textFocus: false, activeCaret: false, singleVisualBand: false,
      caretEvidenceKind: null, busy: false })),
    setOverlayVisibility: vi.fn(async () => {}),
    setOverlayOpacity: vi.fn(async () => {}),
    setWindowClickThrough: vi.fn(async () => {}),
    beginNativeDrag: vi.fn(async () => {}),
    surfaceReady: vi.fn(async surface => ({ protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION,
      surface, ready: true, alreadyReady: false })),
    exitApplication: vi.fn(async () => {}),
  };
  function applyFrame(args: NativeSetOverlayFrameArgs) {
    const scale = args.coordinateScaleFactor ?? state.scale;
    state.x = Math.round(args.x * scale);
    state.y = Math.round(args.y * scale);
    state.width = Math.round(args.width * scale);
    state.height = Math.round(args.height * scale);
  }
  return { state, raw, frames, positions, frameSteps, positionSteps, applyFrame };
}

describe("ParachuteViewportAdapter", () => {
  it.each([1, 1.25, 1.5, 2])("keeps the dog's physical foot and 160 canvas at scale %s", async scale => {
    const f = fixture(scale);
    const insets: number[] = [];
    const viewport = new ParachuteViewportAdapter(f.raw, { onInsetChange: inset => insets.push(inset) });
    const original = await viewport.desktopSnapshot();
    const originalFoot = f.state.y + 140 * scale;
    await expect(viewport.setExpanded(true)).resolves.toBe(true);
    expect(f.state.height).toBe(240 * scale);
    expect(f.state.width).toBe(160 * scale);
    expect(f.state.y + (80 + 140) * scale).toBe(originalFoot);
    const expanded = await viewport.desktopSnapshot();
    expect(expanded.windowPosition).toEqual(original.windowPosition);
    expect(expanded.workArea).toEqual(original.workArea);
    expect(expanded.homeWindow).toEqual(original.homeWindow);
    await expect(viewport.setExpanded(false)).resolves.toBe(true);
    expect(f.state.height).toBe(160 * scale);
    expect(f.state.y + 140 * scale).toBe(originalFoot);
    expect(insets).toEqual([80, 0]);
  });

  it("keeps pointer identities and only the dog hit box active in the larger window", async () => {
    const f = fixture(1.5);
    const viewport = new ParachuteViewportAdapter(f.raw);
    const before = await viewport.pointerSnapshot();
    await viewport.setExpanded(true);
    const after = await viewport.pointerSnapshot();
    expect(after.relativeLogical).toEqual(before.relativeLogical);
    expect(after.windowOuterTopLeftLogical).toEqual(before.windowOuterTopLeftLogical);
    expect(after.cursorScreenLogical).toEqual(before.cursorScreenLogical);
    expect(after.relativeLogical.y + after.windowOuterTopLeftLogical.y).toBe(after.cursorScreenLogical.y);
    expect(resolveHitState(after.relativeLogical, false, HIT_BOX)).toBe(true);
    f.state.cursorY = f.state.y + 40 * f.state.scale;
    const topSpace = await viewport.pointerSnapshot();
    expect(topSpace.relativeLogical.y).toBe(-40);
    expect(resolveHitState(topSpace.relativeLogical, false, HIT_BOX)).toBe(false);
  });

  it("serializes an in-flight move, expansion, pointer read and following move", async () => {
    const f = fixture();
    const wait = deferred();
    f.positionSteps.push(async () => wait.promise);
    const viewport = new ParachuteViewportAdapter(f.raw);
    const moving = viewport.setOverlayPosition({ windowLabel: "main", x: -420, y: 360 });
    await vi.waitFor(() => expect(f.positions).toHaveLength(1));
    const expanding = viewport.setExpanded(true);
    const pointer = viewport.pointerSnapshot();
    const next = viewport.setOverlayPosition({ windowLabel: "main", x: -430, y: 380 });
    expect(f.frames).toHaveLength(0);
    expect(f.raw.pointerSnapshot).not.toHaveBeenCalled();
    wait.resolve();
    await moving;
    await expanding;
    expect((await pointer).windowOuterTopLeftLogical).toEqual({ x: -420, y: 360 });
    await next;
    expect(f.frames[0]).toMatchObject({ x: -420, y: 280, width: 160, height: 240 });
    expect(f.positions[1]).toMatchObject({ x: -430, y: 300 });
    expect((await viewport.desktopSnapshot()).windowPosition).toMatchObject({ x: -430, y: 380 });
  });

  it("cancels an expansion before it starts without writing any frame", async () => {
    const f = fixture();
    const insets = vi.fn();
    const viewport = new ParachuteViewportAdapter(f.raw, { onInsetChange: insets });
    const expanding = viewport.setExpanded(true);
    const collapsing = viewport.setExpanded(false);
    expect(await expanding).toBe(false);
    expect(await collapsing).toBe(true);
    expect(f.frames).toHaveLength(0);
    expect(insets).not.toHaveBeenCalled();
  });

  it("rolls back a cancelled in-flight expansion before a new drag move", async () => {
    const f = fixture();
    const wait = deferred();
    const entered = deferred();
    f.frameSteps.push(async args => { f.applyFrame(args); entered.resolve(); await wait.promise; });
    const insets = vi.fn();
    const viewport = new ParachuteViewportAdapter(f.raw, { onInsetChange: insets });
    const expanding = viewport.setExpanded(true);
    await entered.promise;
    const collapsing = viewport.setExpanded(false);
    const drag = viewport.setOverlayPosition({ windowLabel: "main", x: -500, y: 400 });
    wait.resolve();
    expect(await expanding).toBe(false);
    expect(await collapsing).toBe(true);
    await drag;
    expect(f.state).toMatchObject({ x: -500, y: 400, height: 160 });
    expect(insets).not.toHaveBeenCalled();
    expect(f.frames.map(frame => frame.height)).toEqual([240, 160]);
  });

  it("lets the latest expansion win across an in-flight collapse", async () => {
    const f = fixture();
    const insets: number[] = [];
    const viewport = new ParachuteViewportAdapter(f.raw, { onInsetChange: inset => insets.push(inset) });
    await viewport.setExpanded(true);
    const wait = deferred();
    const entered = deferred();
    f.frameSteps.push(async args => { f.applyFrame(args); entered.resolve(); await wait.promise; });
    const closing = viewport.setExpanded(false);
    await entered.promise;
    const reopening = viewport.setExpanded(true);
    wait.resolve();
    expect(await closing).toBe(false);
    expect(await reopening).toBe(true);
    expect(f.state).toMatchObject({ y: 220, height: 240 });
    expect(insets).toEqual([80]);
  });

  it("uses actual HWND inset scale when motion coordinates belong to another monitor", async () => {
    const f = fixture(1.5);
    const viewport = new ParachuteViewportAdapter(f.raw);
    await viewport.setExpanded(true);
    await viewport.setOverlayPosition({ windowLabel: "main", x: -600, y: 450, coordinateScaleFactor: 1 });
    expect(f.positions[0]).toMatchObject({ x: -600, y: 330, coordinateScaleFactor: 1 });
    const snapshot = await viewport.desktopSnapshot();
    expect(snapshot.windowPosition).toMatchObject({ x: -400, y: 300 });
  });

  it("reconciles a DPI change caused by a move without moving the physical dog anchor", async () => {
    const f = fixture();
    const viewport = new ParachuteViewportAdapter(f.raw);
    await viewport.setExpanded(true);
    f.positionSteps.push(async () => { f.state.scale = 2; });
    await viewport.setOverlayPosition({ windowLabel: "main", x: -600, y: 600, coordinateScaleFactor: 1 });
    expect(f.state).toMatchObject({ x: -600, y: 440, height: 480, width: 320 });
    expect((await viewport.desktopSnapshot()).windowPosition).toMatchObject({ x: -300, y: 300 });
    expect(f.frames.at(-1)).toMatchObject({ x: -300, y: 220, coordinateScaleFactor: 2 });
  });

  it("retries frame dimensions at the new HWND scale if expansion itself crosses DPI", async () => {
    const f = fixture();
    const viewport = new ParachuteViewportAdapter(f.raw);
    f.frameSteps.push(async args => { f.applyFrame(args); f.state.scale = 2; });
    await viewport.setExpanded(true);
    expect(f.state).toMatchObject({ x: -480, y: 0, height: 480, width: 320 });
    expect(f.state.x + 80 * f.state.scale).toBe(-320);
    expect(f.state.y + (80 + 140) * f.state.scale).toBe(440);
    expect((await viewport.desktopSnapshot()).windowPosition).toMatchObject({ x: -240, y: 80 });
    expect(f.frames).toHaveLength(2);
  });

  it("restores both position and size after a partially failed native expansion", async () => {
    const f = fixture();
    const insets = vi.fn();
    f.frameSteps.push(async args => { f.state.y = args.y; throw new Error("size_failed_after_position"); });
    const viewport = new ParachuteViewportAdapter(f.raw, { onInsetChange: insets });
    await expect(viewport.setExpanded(true)).rejects.toThrow("size_failed_after_position");
    expect(f.state).toMatchObject({ y: 300, height: 160 });
    expect(viewport.geometryKnown).toBe(true);
    expect(viewport.topInset).toBe(0);
    expect(insets).not.toHaveBeenCalled();
    expect(f.frames.map(frame => frame.height)).toEqual([240, 160]);
  });

  it("repairs a size-first partial failure as well as the native explicit-scale position-first path", async () => {
    const f = fixture();
    f.frameSteps.push(async args => { f.state.height = args.height; throw new Error("position_failed_after_size"); });
    const viewport = new ParachuteViewportAdapter(f.raw);
    await expect(viewport.setExpanded(true)).rejects.toThrow("position_failed_after_size");
    expect(f.state).toMatchObject({ y: 300, height: 160 });
    expect(viewport.geometryKnown).toBe(true);
  });

  it("publishes the new canonical DPI geometry before resolving an expansion invalidated by Runtime", async () => {
    const f = fixture();
    const insets: number[] = [];
    const published: NativeDesktopSnapshotV1[] = [];
    let collapse: Promise<boolean> | undefined;
    const viewport = new ParachuteViewportAdapter(f.raw, {
      onInsetChange: inset => insets.push(inset),
      onDesktopSnapshot: snapshot => {
        published.push(snapshot);
        collapse = viewport.setExpanded(false);
      },
    });
    f.frameSteps.push(async args => { f.applyFrame(args); f.state.scale = 2; });
    expect(await viewport.setExpanded(true)).toBe(false);
    expect(published).toHaveLength(1);
    expect(published[0].windowPosition).toMatchObject({ x: -240, y: 80 });
    expect(published[0].windowScaleFactor).toBe(2);
    expect(await collapse).toBe(true);
    expect(f.state.x + 80 * f.state.scale).toBe(-320);
    expect(f.state.y + 140 * f.state.scale).toBe(440);
    expect(insets).toEqual([80, 0]);
  });

  it("preserves the physical foot when a partial failure also changed DPI", async () => {
    const f = fixture();
    const snapshots: NativeDesktopSnapshotV1[] = [];
    const viewport = new ParachuteViewportAdapter(f.raw, { onDesktopSnapshot: snapshot => snapshots.push(snapshot) });
    f.frameSteps.push(async args => { f.applyFrame(args); f.state.scale = 2; throw new Error("partial_dpi_change"); });
    await expect(viewport.setExpanded(true)).rejects.toThrow("partial_dpi_change");
    expect(f.state).toMatchObject({ x: -480, y: 160, width: 320, height: 320 });
    expect(f.state.x + 80 * f.state.scale).toBe(-320);
    expect(f.state.y + 140 * f.state.scale).toBe(440);
    expect(viewport.topInset).toBe(0);
    expect(snapshots[0].windowPosition).toMatchObject({ x: -240, y: 80 });
  });

  it("repairs dimensions when DPI changed before a queued motion write", async () => {
    const f = fixture();
    const snapshots: NativeDesktopSnapshotV1[] = [];
    const viewport = new ParachuteViewportAdapter(f.raw, { onDesktopSnapshot: snapshot => snapshots.push(snapshot) });
    await viewport.setExpanded(true);
    f.state.scale = 2;
    await viewport.setOverlayPosition({ windowLabel: "main", x: -400, y: 600, coordinateScaleFactor: 1 });
    expect(f.state).toMatchObject({ x: -400, y: 440, width: 320, height: 480 });
    expect(snapshots[0].windowPosition).toMatchObject({ x: -200, y: 300 });
  });

  it("bounds repeated DPI churn and restores a usable ordinary viewport", async () => {
    const f = fixture();
    f.frameSteps.push(async args => { f.applyFrame(args); f.state.scale = 2; });
    f.frameSteps.push(async args => { f.applyFrame(args); f.state.scale = 1; });
    const viewport = new ParachuteViewportAdapter(f.raw);
    await expect(viewport.setExpanded(true)).rejects.toThrow("unstable_scale");
    expect(viewport.geometryKnown).toBe(true);
    expect(viewport.topInset).toBe(0);
    expect(f.state).toMatchObject({ x: -400, y: 300, width: 160, height: 160 });
    expect(f.frames).toHaveLength(3);
  });

  it("fails closed if rollback also fails, then repairs via explicit collapse", async () => {
    const f = fixture();
    const unsafe = vi.fn();
    const viewport = new ParachuteViewportAdapter(f.raw, { onUnsafe: unsafe });
    f.frameSteps.push(async args => { f.applyFrame(args); throw new Error("partial"); });
    f.frameSteps.push(async () => { throw new Error("rollback_failed"); });
    await expect(viewport.setExpanded(true)).rejects.toThrow("geometry_unknown");
    expect(viewport.geometryKnown).toBe(false);
    expect(unsafe).toHaveBeenCalledOnce();
    await expect(viewport.desktopSnapshot()).rejects.toThrow("geometry_unknown");
    await expect(viewport.pointerSnapshot()).rejects.toThrow("geometry_unknown");
    await expect(viewport.setOverlayPosition({ windowLabel: "main", x: 0, y: 0 })).rejects.toThrow("geometry_unknown");
    await expect(viewport.beginNativeDrag("main")).rejects.toThrow("geometry_unknown");
    await expect(viewport.setWindowClickThrough({ windowLabel: "main", ignore: false })).rejects.toThrow("geometry_unknown");
    await viewport.setWindowClickThrough({ windowLabel: "main", ignore: true });
    await expect(viewport.setExpanded(false)).resolves.toBe(true);
    expect(viewport.geometryKnown).toBe(true);
    expect(f.state).toMatchObject({ y: 300, height: 160 });
    expect((await viewport.desktopSnapshot()).windowPosition.y).toBe(300);
  });

  it("restores canonical layout and cancels pending expansion", async () => {
    const f = fixture();
    const viewport = new ParachuteViewportAdapter(f.raw);
    const expansion = viewport.setExpanded(true);
    const layout = viewport.setOverlayFrame({ windowLabel: "main", x: -350, y: 500,
      width: 160, height: 160, coordinateScaleFactor: 1 });
    expect(await expansion).toBe(false);
    await layout;
    expect(viewport.topInset).toBe(0);
    expect(f.state).toMatchObject({ x: -350, y: 500, height: 160 });
    await viewport.setExpanded(true);
    await viewport.setOverlayFrame({ windowLabel: "main", x: -400, y: 600, width: 160, height: 160 });
    expect((await viewport.desktopSnapshot()).windowPosition).toMatchObject({ x: -400, y: 600 });
    expect(viewport.topInset).toBe(0);
  });

  it("preserves expanded dog geometry when a canonical layout fails partially", async () => {
    const f = fixture();
    const viewport = new ParachuteViewportAdapter(f.raw);
    await viewport.setExpanded(true);
    f.frameSteps.push(async args => { f.applyFrame(args); throw new Error("layout_partial"); });
    await expect(viewport.setOverlayFrame({ windowLabel: "main", x: 100, y: 500, width: 160, height: 160 }))
      .rejects.toThrow("layout_partial");
    expect(f.state).toMatchObject({ x: -400, y: 220, height: 240 });
    expect(viewport.topInset).toBe(80);
    expect(viewport.geometryKnown).toBe(true);
  });

  it("rejects unverified frame success and restores the previous frame", async () => {
    const f = fixture();
    f.frameSteps.push(async () => {});
    const viewport = new ParachuteViewportAdapter(f.raw);
    await expect(viewport.setExpanded(true)).rejects.toThrow("readback_mismatch");
    expect(viewport.topInset).toBe(0);
    expect(viewport.geometryKnown).toBe(true);
    expect(f.state).toMatchObject({ y: 300, height: 160 });
  });

  it("declines expansion when the monitor no longer has room above the dog", async () => {
    const f = fixture();
    f.state.y = -60;
    const viewport = new ParachuteViewportAdapter(f.raw);
    expect(await viewport.setExpanded(true)).toBe(false);
    expect(f.frames).toHaveLength(0);
  });

  it("publishes only canonical public snapshots and keeps unrelated primitives unchanged", async () => {
    const f = fixture();
    const snapshots: NativeDesktopSnapshotV1[] = [];
    const viewport = new ParachuteViewportAdapter(f.raw, { onDesktopSnapshot: snapshot => snapshots.push(snapshot) });
    await viewport.setExpanded(true);
    expect(snapshots).toHaveLength(0);
    await viewport.desktopSnapshot();
    expect(snapshots[0].windowPosition.y).toBe(300);
    const home = { windowLabel: "home" as const, x: 20, y: 100, width: 256, height: 256 };
    await viewport.setOverlayFrame(home);
    expect(f.frames.at(-1)).toEqual(home);
    await viewport.setOverlayOpacity({ windowLabel: "home", opacity: 0.5 });
    await viewport.setOverlayVisibility({ windowLabel: "main", visible: true });
    await viewport.beginNativeDrag("main");
    expect(f.raw.beginNativeDrag).toHaveBeenCalledWith("main");
    expect(await viewport.surfaceReady("main")).toMatchObject({ surface: "main", ready: true });
    await viewport.exitApplication();
    expect(f.raw.exitApplication).toHaveBeenCalledOnce();
  });

  it("suppresses late callbacks and repairs the frame when disposed during expansion", async () => {
    const f = fixture();
    const wait = deferred();
    const entered = deferred();
    f.frameSteps.push(async args => { f.applyFrame(args); entered.resolve(); await wait.promise; });
    const insets = vi.fn();
    const viewport = new ParachuteViewportAdapter(f.raw, { onInsetChange: insets });
    const expansion = viewport.setExpanded(true);
    await entered.promise;
    const disposed = viewport.dispose();
    wait.resolve();
    expect(await expansion).toBe(false);
    await disposed;
    expect(f.state).toMatchObject({ y: 300, height: 160 });
    expect(insets).not.toHaveBeenCalled();
    await expect(viewport.setExpanded(true)).rejects.toThrow("disposed");
    await expect(viewport.desktopSnapshot()).rejects.toThrow("disposed");
  });

  it("collapses a committed viewport when disposed without publishing to a removed view", async () => {
    const f = fixture();
    const insets: number[] = [];
    const viewport = new ParachuteViewportAdapter(f.raw, { onInsetChange: inset => insets.push(inset) });
    await viewport.setExpanded(true);
    await viewport.dispose();
    expect(f.state).toMatchObject({ y: 300, height: 160 });
    expect(insets).toEqual([80]);
  });
});
