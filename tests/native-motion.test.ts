import { describe, expect, it } from "vitest";
import { NativePlatformAdapter, type NativeDesktopSnapshotV1 } from "../src/native-platform";
import { resolveHomeSurface } from "../src/home-cycle";
import { NativeWindowMotionAdapter } from "../src/native-motion";

const SNAPSHOT: NativeDesktopSnapshotV1 = {
  protocolVersion: "linedog.native/v1",
  snapshotRevision: 1,
  capturedAtMonotonicMs: 0,
  currentMonitorId: "monitor-1",
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  windowPosition: {
    space: "WINDOW_TOP_LEFT_LOGICAL",
    x: 100,
    y: 460,
  },
  monitorScaleFactor: 1,
  windowScaleFactor: 1,
  homeWindow: null,
};

describe("NativeWindowMotionAdapter", () => {
  it("uses a newly accepted Runtime snapshot scale for newly rebased coordinates", async () => {
    const writes: unknown[] = [];
    const adapter = new NativeWindowMotionAdapter({
      desktopSnapshot: async () => ({ ...SNAPSHOT, windowScaleFactor: 1 }),
      setOverlayPosition: async request => { writes.push(request); },
    });
    await adapter.resync();
    adapter.acceptDesktopSnapshot({ windowScaleFactor: 2 });
    await adapter.writeWindowTopLeft({ space: "WINDOW_TOP_LEFT_LOGICAL", x: -240, y: 80 });
    expect(writes).toEqual([{ windowLabel: "main", x: -240, y: 80, coordinateScaleFactor: 2 }]);
    adapter.dispose();
  });

  it("keeps a throttled old command in its original scale after Runtime accepts a new snapshot", async () => {
    const writes: unknown[] = [];
    const timers: Array<() => void> = [];
    const adapter = new NativeWindowMotionAdapter({
      desktopSnapshot: async () => ({ ...SNAPSHOT, windowScaleFactor: 1.5 }),
      setOverlayPosition: async request => { writes.push(request); },
    }, { clock: { now: () => 0, setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => {} } });
    await adapter.resync();
    await adapter.writeWindowTopLeft({ space: "WINDOW_TOP_LEFT_LOGICAL", x: 100, y: 300 });
    const oldCommand = adapter.writeWindowTopLeft({ space: "WINDOW_TOP_LEFT_LOGICAL", x: 110, y: 310 });
    expect(timers).toHaveLength(1);
    adapter.acceptDesktopSnapshot({ windowScaleFactor: 2 });
    timers[0]();
    await oldCommand;
    expect(writes).toEqual([
      { windowLabel: "main", x: 100, y: 300, coordinateScaleFactor: 1.5 },
      { windowLabel: "main", x: 110, y: 310, coordinateScaleFactor: 1.5 },
    ]);
    adapter.dispose();
  });

  it("writes mixed-DPI coordinates with the scale of the synchronized snapshot", async () => {
    const writes: unknown[] = [];
    let scale = 1.5;
    const adapter = new NativeWindowMotionAdapter({
      desktopSnapshot: async () => ({ ...SNAPSHOT, windowScaleFactor: scale, monitorScaleFactor: 2 }),
      setOverlayPosition: async request => { writes.push(request); },
    });
    await adapter.resync();
    scale = 2;
    // Sampling monitor facts cannot reinterpret the coordinator's old coordinates.
    await adapter.readCurrentWorkArea();
    await adapter.writeWindowTopLeft({ space: "WINDOW_TOP_LEFT_LOGICAL", x: -1200, y: 600 });
    expect(writes).toEqual([{ windowLabel: "main", x: -1200, y: 600, coordinateScaleFactor: 1.5 }]);
    adapter.dispose();
  });
  it("completes startup resync with the latest facts when an older desktop response arrives late", async () => {
    let resolveOld!: (snapshot: NativeDesktopSnapshotV1) => void;
    let calls = 0; const observed: number[] = [];
    const latest = { ...SNAPSHOT, snapshotRevision: 2, currentMonitorId: "monitor-2",
      windowPosition: { ...SNAPSHOT.windowPosition, x: 2100 } };
    const platform = new NativePlatformAdapter(async () => ++calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) :
      latest, snapshot => observed.push(snapshot.snapshotRevision));
    const motion = new NativeWindowMotionAdapter(platform);
    const startup = motion.resync();
    await platform.desktopSnapshot();
    resolveOld(SNAPSHOT);
    await expect(startup).resolves.toMatchObject({ snapshotRevision: 2,
      currentMonitorId: "monitor-2", windowPosition: latest.windowPosition });
    expect(observed).toEqual([2]);
    motion.dispose();
  });

  it("still fails actual native errors instead of substituting cached facts", async () => {
    let calls = 0;
    const platform = new NativePlatformAdapter(async () => {
      if (++calls === 1) return SNAPSHOT;
      throw new Error("desktop_unavailable");
    });
    await platform.desktopSnapshot();
    await expect(platform.desktopSnapshot()).rejects.toThrow("desktop_unavailable");
  });

  it.each([1, 1.25, 1.5, 2])("uses actual negative-coordinate Home geometry once at scale %s", scale => {
    const snapshot = { ...SNAPSHOT, currentMonitorId: "negative", windowScaleFactor: scale, monitorScaleFactor: scale,
      workArea: { x: -1000, y: -100, width: 1000, height: 600 },
      homeWindow: { ready: true, currentMonitorId: "negative", windowScaleFactor: scale,
        rect: { x: -280, y: 244, width: 256, height: 256 } } };
    expect(resolveHomeSurface(snapshot)).toEqual(snapshot.homeWindow.rect);
    expect(resolveHomeSurface({ ...snapshot, monitorScaleFactor: scale + 0.5 })).toBeNull();
  });
  it.each([1, 1.25, 1.5, 2])("回读透传窗口缩放 %s，不使用 monitor 缩放", async windowScaleFactor => {
    const adapter = new NativeWindowMotionAdapter({
      desktopSnapshot: async () => ({ ...SNAPSHOT, monitorScaleFactor: 3, windowScaleFactor }),
      setOverlayPosition: async () => undefined,
    });
    expect(await adapter.resync()).toEqual({
      snapshotRevision: 1,
      monitorScaleFactor: 3,
      homeWindow: null,
      currentMonitorId: SNAPSHOT.currentMonitorId,
      workArea: SNAPSHOT.workArea,
      windowPosition: SNAPSHOT.windowPosition,
      windowScaleFactor,
    });
    adapter.dispose();
  });

  it("uses the position-only native command for walking motion", async () => {
    const positionRequests: Array<{ windowLabel: string; x: number; y: number }> = [];
    const adapter = new NativeWindowMotionAdapter({
      desktopSnapshot: async () => SNAPSHOT,
      setOverlayPosition: async (request) => {
        positionRequests.push({ ...request });
      },
    });

    await adapter.writeWindowTopLeft({
      space: "WINDOW_TOP_LEFT_LOGICAL",
      x: 106,
      y: 460,
    });

    expect(positionRequests).toEqual([
      { windowLabel: "main", x: 106, y: 460 },
    ]);
  });
});
