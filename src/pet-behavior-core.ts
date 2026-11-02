import type {
  LogicalPoint,
  LogicalWorkArea,
  MotionSnapshot,
  WindowTopLeftLogical,
} from "./native-motion";
import type { LogicalRect } from "./input-avoidance";
import { RUNTIME_VIEWPORT_SIZE } from "./sprite-renderer";

/**
 * 冻结产品行为基线（见 AGENTS.md「冻结产品行为基线」表）。
 * 本模块只含纯函数与配置：无 DOM、无 IPC、无副作用，可独立单测。
 * PetRuntime 类的事实真相仍在 pet-runtime.ts；本模块是它的可测内核。
 */
export const PET_BEHAVIOR_CONFIG = {
  idle: {
    minDurationMs: 3_000,
    maxDurationMs: 8_000,
  },
  blink: {
    intervalMinMs: 2_500,
    intervalMaxMs: 6_000,
    doubleBlinkProbability: 0.08,
  },
  walk: {
    minDurationMs: 2_000,
    maxDurationMs: 6_000,
    minSpeedLogicalPxPerSecond: 45,
    maxSpeedLogicalPxPerSecond: 60,
  },
  pause: {
    minDurationMs: 1_000,
    maxDurationMs: 3_000,
  },
  look: {
    enterRadiusLogicalPx: 90,
    exitRadiusLogicalPx: 130,
    exitDelayMs: 500,
  },
  /**
   * 松手下落与落地。原值（1800 / 1200 / 250ms）来自早期"快速复位"取向，
   * 落下时像被弹开而不是松手坠地。用户要求"轻柔但仍跟手"，故整体放缓：
   * 重力降到 1150、限速降到 900、落地展示延到 400ms。
   * 注意：这三项同时写在 AGENTS.md「冻结产品行为基线」中，本次变更已由
   * 用户口头批准，冻结表需同步更新。
   */
  fall: {
    gravityLogicalPxPerSecondSquared: 1_150,
    maxSpeedLogicalPxPerSecond: 900,
  },
  land: {
    durationMs: 400,
  },
  // A local FALL effect; ordinary short drops keep the existing gravity.
  parachute: {
    minimumDropLogicalPx: 280,
    openingDurationMs: 300,
    closingDurationMs: 300,
    glideSpeedLogicalPxPerSecond: 95,
    swayAmplitudeLogicalPx: 14,
    swayPeriodMs: 2_500,
    settleDistanceLogicalPx: 50,
    viewportTopInsetLogicalPx: 80,
  },
} as const;

export const IDLE_OR_PAUSE_WEIGHT = 0.65;
/**
 * Frozen budget for "Walk 安全停止 <= 200 ms" (logical stop, not physical).
 * Start = the frame a direct-interaction event is received; end = `behavior`
 * leaves WALK/GO_HOME. See docs/contracts/LINEDOG-STABLE-INTERFACES.md §4.
 */
export const DIRECT_INTERACTION_STOP_MAX_MS = 200;
export const WALK_MOTION_TICK_MS = 1000 / 30;
export const FALL_MOTION_TICK_MS = 1000 / 30;
export const MAX_FALL_PHYSICS_DELTA_MS = 100;
export const FALL_WORK_AREA_REFRESH_INTERVAL_MS = 250;
export const RUNTIME_FOOT_BASELINE_LOGICAL_PX = 140;
export const TURN_FACING_MIDPOINT_FRAME_INDEX = 2;

export type Facing = "Left" | "Right";
export type AutonomousAction = "PAUSE" | "WALK";

function normalizedRandom(random: () => number): number {
  const value = random();

  if (!Number.isFinite(value)) {
    throw new Error("LineDog random source must return a finite value.");
  }

  return Math.min(1, Math.max(0, value));
}

function sampleRange(
  minimum: number,
  maximum: number,
  random: () => number,
): number {
  return Math.round(minimum + normalizedRandom(random) * (maximum - minimum));
}

export function sampleIdleDurationMs(random: () => number): number {
  return sampleRange(
    PET_BEHAVIOR_CONFIG.idle.minDurationMs,
    PET_BEHAVIOR_CONFIG.idle.maxDurationMs,
    random,
  );
}

export function samplePauseDurationMs(random: () => number): number {
  return sampleRange(
    PET_BEHAVIOR_CONFIG.pause.minDurationMs,
    PET_BEHAVIOR_CONFIG.pause.maxDurationMs,
    random,
  );
}

export function sampleWalkDurationMs(random: () => number): number {
  return sampleRange(
    PET_BEHAVIOR_CONFIG.walk.minDurationMs,
    PET_BEHAVIOR_CONFIG.walk.maxDurationMs,
    random,
  );
}

export function sampleWalkSpeedLogicalPxPerSecond(random: () => number): number {
  return sampleRange(
    PET_BEHAVIOR_CONFIG.walk.minSpeedLogicalPxPerSecond,
    PET_BEHAVIOR_CONFIG.walk.maxSpeedLogicalPxPerSecond,
    random,
  );
}

export function chooseAutonomousAction(random: () => number): AutonomousAction {
  return normalizedRandom(random) < IDLE_OR_PAUSE_WEIGHT ? "PAUSE" : "WALK";
}

export function chooseFacing(random: () => number): Facing {
  return normalizedRandom(random) < 0.5 ? "Left" : "Right";
}

export function sampleBlinkDelayMs(random: () => number): number {
  return sampleRange(
    PET_BEHAVIOR_CONFIG.blink.intervalMinMs,
    PET_BEHAVIOR_CONFIG.blink.intervalMaxMs,
    random,
  );
}

export function shouldScheduleDoubleBlink(random: () => number): boolean {
  return normalizedRandom(random) < PET_BEHAVIOR_CONFIG.blink.doubleBlinkProbability;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function getGroundWindowTopY(workArea: LogicalWorkArea): number {
  return workArea.y + workArea.height - RUNTIME_FOOT_BASELINE_LOGICAL_PX;
}

export function isFiniteLogicalWorkArea(workArea: LogicalWorkArea): boolean {
  return (
    Number.isFinite(workArea.x) &&
    Number.isFinite(workArea.y) &&
    Number.isFinite(workArea.width) &&
    Number.isFinite(workArea.height) &&
    workArea.width > 0 &&
    workArea.height > 0
  );
}

export function isFiniteLogicalRect(rect: LogicalRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.right) &&
    Number.isFinite(rect.bottom) &&
    rect.right > rect.left &&
    rect.bottom > rect.top
  );
}

export function cloneWorkArea(workArea: LogicalWorkArea): LogicalWorkArea {
  return { ...workArea };
}

export function clampFallPhysicsDeltaMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) {
    throw new Error("LineDog Fall physics requires a finite elapsed duration.");
  }

  return clamp(elapsedMs, 0, MAX_FALL_PHYSICS_DELTA_MS);
}

export interface FallPhysicsStep {
  readonly positionY: number;
  readonly verticalVelocityLogicalPxPerSecond: number;
  readonly elapsedMs: number;
}

export function integrateFallPhysicsStep(
  positionY: number,
  verticalVelocityLogicalPxPerSecond: number,
  elapsedMs: number,
): FallPhysicsStep {
  if (
    !Number.isFinite(positionY) ||
    !Number.isFinite(verticalVelocityLogicalPxPerSecond)
  ) {
    throw new Error("LineDog Fall physics requires finite position and velocity.");
  }

  const safeElapsedMs = clampFallPhysicsDeltaMs(elapsedMs);
  const elapsedSeconds = safeElapsedMs / 1_000;
  const startingVelocity = clamp(
    verticalVelocityLogicalPxPerSecond,
    0,
    PET_BEHAVIOR_CONFIG.fall.maxSpeedLogicalPxPerSecond,
  );
  const nextVelocity = Math.min(
    PET_BEHAVIOR_CONFIG.fall.maxSpeedLogicalPxPerSecond,
    startingVelocity +
      PET_BEHAVIOR_CONFIG.fall.gravityLogicalPxPerSecondSquared * elapsedSeconds,
  );

  return {
    positionY:
      positionY + ((startingVelocity + nextVelocity) * elapsedSeconds) / 2,
    verticalVelocityLogicalPxPerSecond: nextVelocity,
    elapsedMs: safeElapsedMs,
  };
}

/**
 * The horizontal range the outer window top-left may occupy. Every walk, fall
 * and escape-plan target must use this same range: deriving it locally has
 * already produced targets that disagree with the clamp applied on arrival.
 */
/**
 * Tolerance for logical-pixel comparisons. Native window coordinates come back
 * as integers, so exact equality is never reliable; every distance and arrival
 * comparison must use this one value instead of a locally invented literal.
 */
export const LOGICAL_EPSILON = 0.000_001;

export function workAreaXRange(
  workArea: Pick<LogicalWorkArea, "x" | "width">,
): { readonly minimumX: number; readonly maximumX: number } {
  const minimumX = workArea.x;
  const maximumX = Math.max(
    minimumX,
    workArea.x + workArea.width - RUNTIME_VIEWPORT_SIZE,
  );
  return { minimumX, maximumX };
}

export function clampWorkAreaX(
  x: number,
  workArea: Pick<LogicalWorkArea, "x" | "width">,
): number {
  const { minimumX, maximumX } = workAreaXRange(workArea);
  return clamp(x, minimumX, maximumX);
}

export function clampToWorkArea(
  position: LogicalPoint,
  workArea: MotionSnapshot["workArea"],
): LogicalPoint {
  return {
    x: clampWorkAreaX(position.x, workArea),
    y: getGroundWindowTopY(workArea),
  };
}

export function clampWindowToWorkArea(
  position: LogicalPoint,
  workArea: MotionSnapshot["workArea"],
): LogicalPoint {
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = Math.max(minX, workArea.x + workArea.width - RUNTIME_VIEWPORT_SIZE);
  const maxY = Math.max(minY, workArea.y + workArea.height - RUNTIME_VIEWPORT_SIZE);

  return {
    x: clamp(position.x, minX, maxX),
    y: clamp(position.y, minY, maxY),
  };
}

export function clampFallPosition(
  position: LogicalPoint,
  workArea: LogicalWorkArea,
): LogicalPoint {
  return {
    x: clampWorkAreaX(position.x, workArea),
    y: position.y,
  };
}

export function distanceFromPetCenter(point: LogicalPoint): number {
  return Math.hypot(point.x - RUNTIME_VIEWPORT_SIZE / 2, point.y - RUNTIME_VIEWPORT_SIZE / 2);
}

export function windowRectAt(position: LogicalPoint): LogicalRect {
  return {
    left: position.x,
    top: position.y,
    right: position.x + RUNTIME_VIEWPORT_SIZE,
    bottom: position.y + RUNTIME_VIEWPORT_SIZE,
  };
}

export function rectsOverlap(left: LogicalRect, right: LogicalRect): boolean {
  return (
    Math.min(left.right, right.right) > Math.max(left.left, right.left) &&
    Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top)
  );
}

export function overlapArea(left: LogicalRect, right: LogicalRect): number {
  const width = Math.max(
    0,
    Math.min(left.right, right.right) - Math.max(left.left, right.left),
  );
  const height = Math.max(
    0,
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top),
  );

  return width * height;
}

export function positionsMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= LOGICAL_EPSILON;
}

export function asWindowTopLeftLogical(
  position: LogicalPoint,
): WindowTopLeftLogical | undefined {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return undefined;
  }

  return {
    space: "WINDOW_TOP_LEFT_LOGICAL",
    x: position.x,
    y: position.y,
  };
}
