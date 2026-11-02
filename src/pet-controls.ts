import { computeHomeSurfaceRect, resolveHomeSurface } from "./home-cycle";
import { getGroundWindowTopY } from "./pet-behavior-core";
import { createMotionSnapshot, type MotionSnapshot } from "./native-motion";
import type { NativePlatformPort, NativeLogicalRect } from "./native-platform";

/** Layout is derived in the destination monitor's logical space, then converted once natively. */
export async function restoreDesktopLayout(platform: NativePlatformPort,
  onHomeRect: (rect: NativeLogicalRect | undefined) => void): Promise<MotionSnapshot> {
  try {
    return await applyDesktopLayout(platform, onHomeRect);
  } catch (error) {
    onHomeRect(undefined);
    throw error;
  }
}

async function applyDesktopLayout(platform: NativePlatformPort,
  onHomeRect: (rect: NativeLogicalRect | undefined) => void): Promise<MotionSnapshot> {
  const desktop = await platform.desktopSnapshot();
  if (!Number.isFinite(desktop.windowScaleFactor) || desktop.windowScaleFactor <= 0 ||
      !Number.isFinite(desktop.monitorScaleFactor) || desktop.monitorScaleFactor <= 0) {
    throw new Error("layout_unavailable");
  }
  // Desktop facts use Main's HWND scale; restore sizes belong to the target monitor.
  const ratio = desktop.windowScaleFactor / desktop.monitorScaleFactor;
  const area = { x: desktop.workArea.x * ratio, y: desktop.workArea.y * ratio,
    width: desktop.workArea.width * ratio, height: desktop.workArea.height * ratio };
  const home = computeHomeSurfaceRect(area);
  if (!home || area.width < 280 || area.height < 256) throw new Error("layout_unavailable");
  const main = { x: area.x + (area.width - 160) / 2, y: getGroundWindowTopY(area), width: 160, height: 160 };
  // Home geometry is unknown until the native write succeeds.
  onHomeRect(undefined);
  await platform.setOverlayFrame({ windowLabel: "home", ...home, coordinateScaleFactor: desktop.monitorScaleFactor });
  await platform.setOverlayFrame({ windowLabel: "main", ...main, coordinateScaleFactor: desktop.monitorScaleFactor });
  const actual = await platform.desktopSnapshot();
  // Runtime geometry has one logical space. A correct physical position alone
  // does not make a snapshot usable while the HWND is still changing DPI.
  const sameScale = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  if (!sameScale(actual.windowScaleFactor, actual.monitorScaleFactor) ||
      !sameScale(actual.monitorScaleFactor, desktop.monitorScaleFactor) ||
      (["x", "y", "width", "height"] as const).some(key => Math.abs(actual.workArea[key] - area[key]) > 1e-6)) {
    throw new Error("layout_readback_mismatch");
  }
  const expectedX = main.x * desktop.monitorScaleFactor / actual.windowScaleFactor;
  const expectedY = main.y * desktop.monitorScaleFactor / actual.windowScaleFactor;
  if (Math.abs(actual.windowPosition.x - expectedX) > 1 || Math.abs(actual.windowPosition.y - expectedY) > 1 ||
      actual.currentMonitorId !== desktop.currentMonitorId) throw new Error("layout_readback_mismatch");
  const actualHome = resolveHomeSurface(actual);
  if (!actualHome || (["x", "y", "width", "height"] as const).some(key => Math.abs(actualHome[key] - home[key]) > 1)) {
    throw new Error("layout_home_readback_mismatch");
  }
  onHomeRect(actual.homeWindow!.rect);
  return createMotionSnapshot(actual);
}
