import type {
  LogicalPoint,
  LogicalWorkArea,
  MotionSnapshot,
  WindowTopLeftLogical,
} from "./native-motion";
import {
  RUNTIME_FOOT_BASELINE_LOGICAL_PX,
  clamp,
  getGroundWindowTopY,
  isFiniteLogicalWorkArea,
} from "./pet-behavior-core";

export const HOME_SURFACE_SIZE_LOGICAL = 256;
export const HOME_RIGHT_MARGIN_LOGICAL = 24;
export const HOME_MAIN_WINDOW_SIZE_LOGICAL = 160;
export const HOME_CANVAS_SIZE_PX = 512;
export const HOME_LANDING_SURFACE_CANVAS_LEFT_X = 104;
export const HOME_LANDING_SURFACE_CANVAS_RIGHT_X = 220;
export const HOME_REST_FOOT_ANCHOR_CANVAS_X = 162;
export const HOME_REST_FOOT_ANCHOR_CANVAS_Y = 376;
export const HOME_REST_FOOT_ANCHOR_LOGICAL_X =
  (HOME_REST_FOOT_ANCHOR_CANVAS_X / HOME_CANVAS_SIZE_PX) *
  HOME_SURFACE_SIZE_LOGICAL;
export const HOME_REST_FOOT_ANCHOR_LOGICAL_Y =
  (HOME_REST_FOOT_ANCHOR_CANVAS_Y / HOME_CANVAS_SIZE_PX) *
  HOME_SURFACE_SIZE_LOGICAL;
export const HOME_LANDING_SURFACE_CANVAS_Y = HOME_REST_FOOT_ANCHOR_CANVAS_Y;
export const HOME_LANDING_SURFACE_LOGICAL_LEFT_X =
  (HOME_LANDING_SURFACE_CANVAS_LEFT_X / HOME_CANVAS_SIZE_PX) *
  HOME_SURFACE_SIZE_LOGICAL;
export const HOME_LANDING_SURFACE_LOGICAL_RIGHT_X =
  (HOME_LANDING_SURFACE_CANVAS_RIGHT_X / HOME_CANVAS_SIZE_PX) *
  HOME_SURFACE_SIZE_LOGICAL;
export const HOME_LANDING_SURFACE_LOGICAL_Y = HOME_REST_FOOT_ANCHOR_LOGICAL_Y;
export const HOME_CHARACTER_FOOT_CENTER_CANVAS_X = 256;
export const HOME_CHARACTER_FOOT_CENTER_LOGICAL_X =
  (HOME_CHARACTER_FOOT_CENTER_CANVAS_X / HOME_CANVAS_SIZE_PX) *
  HOME_MAIN_WINDOW_SIZE_LOGICAL;
export const HOME_BOTTOM_MARGIN_LOGICAL = 0;
export const HOME_LANDING_BASELINE_ABOVE_WORKAREA_BOTTOM_LOGICAL =
  HOME_SURFACE_SIZE_LOGICAL - HOME_LANDING_SURFACE_LOGICAL_Y;
export const HOME_APPROACH_DISTANCE_LOGICAL = 24;

export function sampleHomeRoundTrips(random: () => number = Math.random): number {
  return random() < 0.5 ? 3 : 4;
}

export function computeHomeWalkRoute(workArea: LogicalWorkArea,
  surface: HomeSurfaceRect | null = computeHomeSurfaceRect(workArea) ?? null):
  { nearX: number; farX: number } | undefined {
  const entry = computeHomeEntryPoint(workArea, surface);
  if (!entry) return undefined;
  const nearX = entry.x - 48;
  const farX = nearX - Math.min(180, nearX - workArea.x);
  return nearX - farX >= 24 ? { nearX, farX } : undefined;
}
export const HOME_AWAKE_DURATION_MS = 120_000;
export const HOME_INTERACTION_QUIET_MS = 10_000;
export const HOME_REST_MIN_MS = 30_000;
export const HOME_REST_MAX_MS = 90_000;
export const HOME_FADE_DURATION_MS = 180;
export const HOME_WAKE_HOLD_MS = 700;
export const HOME_CYCLE_TICK_MS = 1000 / 30;
export const HOME_CYCLE_SPEED_LOGICAL_PX_PER_SECOND = 52;
/**
 * 进出窝跳跃时长。此值不属于 AGENTS.md 冻结基线，可按观感调整。
 * 650ms 把约 161 logical px 的进窝位移压缩得过急；900ms 让起跳、腾空、
 * 落垫三段的节奏与 jump_air 素材本身更接近，观感更从容。
 */
export const HOME_JUMP_DURATION_MS = 900;
export const HOME_JUMP_HEIGHT_LOGICAL = 40;
export const HOME_JUMP_MAX_DISTANCE_LOGICAL = 190;
/**
 * 跳跃看门狗余量：空中阶段一旦停滞（任何未知路径造成的计时/推进缺失），
 * 超过该余量后强制收尾到目标点，绝不把狗留在半空。
 */
export const HOME_JUMP_WATCHDOG_MARGIN_MS = 1_500;

export type HomeCyclePhase = "GO_HOME" | "FADE_OUT" | "REST" | "FADE_IN";

export type HomeLifecycleEvent = Readonly<{
  type:
    | "MAIN_FADE_OUT"
    | "MAIN_HIDE"
    | "MAIN_SHOW_NO_ACTIVATE"
    | "MAIN_FADE_IN";
  revision: number;
  durationMs?: number;
}>;

export type HomeMainVisibility = Readonly<{
  opacity: 1;
  visible: true;
}>;

/**
 * Home lifecycle phases may change behavior and timing, but they must not hide
 * the character window. The dog remains visible beside Home while resting.
 */
export function resolveHomeMainVisibility(
  event: HomeLifecycleEvent,
): HomeMainVisibility {
  switch (event.type) {
    case "MAIN_FADE_OUT":
    case "MAIN_HIDE":
    case "MAIN_SHOW_NO_ACTIVATE":
    case "MAIN_FADE_IN":
      return { opacity: 1, visible: true };
  }
}

export type HomeSurfaceRect = Readonly<{
  x: number;
  y: number;
  width: typeof HOME_SURFACE_SIZE_LOGICAL;
  height: typeof HOME_SURFACE_SIZE_LOGICAL;
}>;

export type HomeLandingSurface = Readonly<{
  leftX: number;
  rightX: number;
  y: number;
}>;

/** Only an actual, ready Home on Main's settled monitor can support the pet. */
export function resolveHomeSurface(snapshot: Pick<MotionSnapshot,
  "homeWindow" | "currentMonitorId" | "windowScaleFactor" | "monitorScaleFactor" | "workArea">): HomeSurfaceRect | null {
  const home = snapshot.homeWindow;
  const area = snapshot.workArea;
  if (!home?.ready || home.currentMonitorId !== snapshot.currentMonitorId ||
      !isFiniteLogicalWorkArea(area) || !isFiniteLogicalWorkArea(home.rect) ||
      !Number.isFinite(snapshot.windowScaleFactor) || snapshot.windowScaleFactor <= 0 ||
      Math.abs(home.windowScaleFactor - snapshot.windowScaleFactor) > 1e-6 ||
      Math.abs((snapshot.monitorScaleFactor ?? snapshot.windowScaleFactor) - snapshot.windowScaleFactor) > 1e-6) return null;
  const rect = home.rect;
  // Allow one physical pixel of native rounding, never a differently scaled surface.
  const tolerance = 1 / snapshot.windowScaleFactor;
  if (Math.abs(rect.width - HOME_SURFACE_SIZE_LOGICAL) > tolerance ||
      Math.abs(rect.height - HOME_SURFACE_SIZE_LOGICAL) > tolerance ||
      rect.x < area.x - tolerance || rect.y < area.y - tolerance ||
      rect.x + rect.width > area.x + area.width + tolerance ||
      rect.y + rect.height > area.y + area.height + tolerance) return null;
  return { x: rect.x, y: rect.y, width: HOME_SURFACE_SIZE_LOGICAL, height: HOME_SURFACE_SIZE_LOGICAL };
}

export function computeHomeSurfaceRect(
  workArea: LogicalWorkArea,
): HomeSurfaceRect | undefined {
  if (!isFiniteLogicalWorkArea(workArea)) {
    return undefined;
  }

  return {
    x:
      workArea.x +
      workArea.width -
      HOME_RIGHT_MARGIN_LOGICAL -
      HOME_SURFACE_SIZE_LOGICAL,
    y:
      workArea.y +
      workArea.height -
      HOME_BOTTOM_MARGIN_LOGICAL -
      HOME_SURFACE_SIZE_LOGICAL,
    width: HOME_SURFACE_SIZE_LOGICAL,
    height: HOME_SURFACE_SIZE_LOGICAL,
  };
}

export function computeHomeLandingSurface(
  workArea: LogicalWorkArea,
  surface: HomeSurfaceRect | null = computeHomeSurfaceRect(workArea) ?? null,
): HomeLandingSurface | undefined {
  if (!surface) {
    return undefined;
  }

  return {
    leftX: surface.x + HOME_LANDING_SURFACE_LOGICAL_LEFT_X,
    rightX: surface.x + HOME_LANDING_SURFACE_LOGICAL_RIGHT_X,
    y: surface.y + HOME_LANDING_SURFACE_LOGICAL_Y,
  };
}

export function crossesHomeLandingSurface(
  previousWindowTopLeft: LogicalPoint,
  nextWindowTopLeft: LogicalPoint,
  workArea: LogicalWorkArea,
  surface: HomeSurfaceRect | null = computeHomeSurfaceRect(workArea) ?? null,
): boolean {
  const landingSurface = computeHomeLandingSurface(workArea, surface);
  if (!landingSurface) {
    return false;
  }

  const footCenterX =
    nextWindowTopLeft.x + HOME_CHARACTER_FOOT_CENTER_LOGICAL_X;
  const previousFootY =
    previousWindowTopLeft.y + RUNTIME_FOOT_BASELINE_LOGICAL_PX;
  const nextFootY = nextWindowTopLeft.y + RUNTIME_FOOT_BASELINE_LOGICAL_PX;

  return (
    footCenterX >= landingSurface.leftX &&
    footCenterX <= landingSurface.rightX &&
    previousFootY <= landingSurface.y &&
    nextFootY >= landingSurface.y
  );
}

/** External ground approach point at Home's left edge. */
export function computeHomeEntryPoint(
  workArea: LogicalWorkArea,
  surface: HomeSurfaceRect | null = computeHomeSurfaceRect(workArea) ?? null,
): WindowTopLeftLogical | undefined {
  if (!surface) {
    return undefined;
  }

  const maximumX = Math.max(
    workArea.x,
    workArea.x + workArea.width - HOME_MAIN_WINDOW_SIZE_LOGICAL,
  );
  return {
    space: "WINDOW_TOP_LEFT_LOGICAL",
    x: clamp(surface.x - HOME_MAIN_WINDOW_SIZE_LOGICAL, workArea.x, maximumX),
    y: getGroundWindowTopY(workArea),
  };
}

/** Aligns canonical Main foot center to Home manifest restFootAnchor. */
export function computeHomeRestPoint(
  workArea: LogicalWorkArea,
  surface: HomeSurfaceRect | null = computeHomeSurfaceRect(workArea) ?? null,
): WindowTopLeftLogical | undefined {
  if (!surface) {
    return undefined;
  }

  return {
    space: "WINDOW_TOP_LEFT_LOGICAL",
    x:
      surface.x +
      HOME_REST_FOOT_ANCHOR_LOGICAL_X -
      HOME_CHARACTER_FOOT_CENTER_LOGICAL_X,
    y:
      surface.y +
      HOME_REST_FOOT_ANCHOR_LOGICAL_Y -
      RUNTIME_FOOT_BASELINE_LOGICAL_PX,
  };
}

/**
 * 进出窝抛物线。水平位移使用 smoothstep 缓动，垂直方向仍是匀速基线加
 * 对称抛物拱高：起跳与落垫接近垂直、中段最快，比整段线性位移更接近
 * 真实起跳受力，也避免"被水平弹射出去"的急促感。
 */
export function computeHomeJumpPoint(
  start: LogicalPoint,
  rest: LogicalPoint,
  progress: number,
): LogicalPoint {
  const t = clamp(progress, 0, 1);
  const eased = t * t * (3 - 2 * t);
  return {
    x: start.x + (rest.x - start.x) * eased,
    y:
      start.y +
      (rest.y - start.y) * t -
      4 * HOME_JUMP_HEIGHT_LOGICAL * t * (1 - t),
  };
}

/** 整段抛物线的保守窗口包络；包含端点及 160×160 窗口，不只检查脚点。 */
export function computeHomeJumpBounds(start: LogicalPoint, target: LogicalPoint) {
  return {
    left: Math.min(start.x, target.x),
    right: Math.max(start.x, target.x) + HOME_MAIN_WINDOW_SIZE_LOGICAL,
    top: Math.min(start.y, target.y) - HOME_JUMP_HEIGHT_LOGICAL,
    bottom: Math.max(start.y, target.y) + HOME_MAIN_WINDOW_SIZE_LOGICAL,
  };
}

export function sampleHomeRestDurationMsForRevision(revision: number): number {
  assertHomeCycleRevision(revision);
  const sampleCount = 5;
  const sampleIndex = (revision - 2 + sampleCount) % sampleCount;
  return Math.round(
    HOME_REST_MIN_MS +
      (sampleIndex / (sampleCount - 1)) *
        (HOME_REST_MAX_MS - HOME_REST_MIN_MS),
  );
}

function assertHomeCycleRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("LineDog Home cycle revision must be a positive integer.");
  }
}
