import { expect, it } from "vitest";
import { restoreDesktopLayout } from "../src/pet-controls";
import { NativePlatformAdapter } from "../src/native-platform";

it("reprojects a transitioning HWND workarea before restoring on the destination monitor", async () => {
  let reads = 0;
  const writes: unknown[] = [];
  const platform = new NativePlatformAdapter(async (command, args) => {
    if (command === "set_overlay_frame") { writes.push(args); return; }
    if (command !== "desktop_snapshot") throw Error(command);
    const initial = ++reads === 1;
    return { protocolVersion: "linedog.native/v1", snapshotRevision: reads,
      capturedAtMonotonicMs: reads, currentMonitorId: "target", monitorScaleFactor: 2,
      windowScaleFactor: initial ? 1 : 2,
      workArea: initial ? { x: -2000, y: -200, width: 2000, height: 1200 } : { x: -1000, y: -100, width: 1000, height: 600 },
      windowPosition: { space: "WINDOW_TOP_LEFT_LOGICAL", x: initial ? -1700 : -580, y: initial ? 200 : 360 },
      homeWindow: initial ? null : { ready: true, currentMonitorId: "target", windowScaleFactor: 2,
        rect: { x: -280, y: 244, width: 256, height: 256 } } };
  });
  const result = await restoreDesktopLayout(platform, () => {});
  expect(writes).toEqual([
    { windowLabel: "home", x: -280, y: 244, width: 256, height: 256, coordinateScaleFactor: 2 },
    { windowLabel: "main", x: -580, y: 360, width: 160, height: 160, coordinateScaleFactor: 2 },
  ]);
  expect(result.windowPosition).toMatchObject({ x: -580, y: 360 });
});
