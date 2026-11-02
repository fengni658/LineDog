import { systemTimelineClock, type TimelineClock } from "./animation-timeline";
import type { LogicalPoint } from "./native-motion";
import type { NativeDesktopSnapshotV1 } from "./native-platform";

/**
 * Home 邻近半透明交互的默认值：
 * - 进入半径 140 logical px（光标到小窗矩形边界的距离，内部为 0）；
 * - 退出半径 180 logical px（滞回，避免在边界来回抖动）；
 * - 半透明目标透明度 0.45，恢复不透明 1.0；
 * - 渐变用 8 步 × 50ms（约 400ms）逐级过渡，原生分层窗口无 CSS 过渡可用。
 */
export const HOME_PROXIMITY_ENTER_LOGICAL_PX = 140;
export const HOME_PROXIMITY_EXIT_LOGICAL_PX = 180;
export const HOME_PROXIMITY_OPACITY = 0.45;
export const HOME_OPAQUE_OPACITY = 1;
export const HOME_PROXIMITY_FADE_STEP_MS = 50;
export const HOME_PROXIMITY_FADE_STEPS = 8;

export interface HomeProximityRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 光标到矩形边界的最短距离；矩形内部为 0。任何非有限输入都返回 Infinity，
 * 让调用方 fail-closed 地保持不透明（与避让事实的失败语义一致）。
 */
export function distanceToRectBounds(
  point: LogicalPoint,
  rect: HomeProximityRect,
): number {
  const values = [
    point.x,
    point.y,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  ];
  if (!values.every((value) => Number.isFinite(value))) {
    return Number.POSITIVE_INFINITY;
  }
  if (rect.width <= 0 || rect.height <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

export type HomeProximityTarget = "opaque" | "translucent";

/**
 * 滞回判定：半透明态用更大的退出半径，非透明态用更小的进入半径。
 * 距离不可信（非有限值）时一律判定为远离。
 */
export function resolveHomeProximityTarget(
  previous: HomeProximityTarget,
  distancePx: number,
): HomeProximityTarget {
  if (!Number.isFinite(distancePx)) {
    return "opaque";
  }
  if (previous === "translucent") {
    return distancePx <= HOME_PROXIMITY_EXIT_LOGICAL_PX
      ? "translucent"
      : "opaque";
  }
  return distancePx <= HOME_PROXIMITY_ENTER_LOGICAL_PX
    ? "translucent"
    : "opaque";
}

export interface HomeProximityControllerOptions {
  readonly rect: HomeProximityRect | undefined;
  readonly clock?: TimelineClock;
  readonly applyOpacity: (opacity: number) => Promise<void> | void;
  readonly reportError?: (context: string, error: unknown) => void;
}

function clampOpacity(opacity: number): number {
  return Math.min(HOME_OPAQUE_OPACITY, Math.max(0, opacity));
}

/**
 * 依据全局光标采样驱动 Home 窗口透明度。判定是纯函数（可单测）；
 * 渐变是链式 setTimeout 的阶梯过渡，dispose/新目标会取消进行中的过渡。
 * rect 缺失（工作区无效等）时永远保持不透明，行为退化为现状。
 */
export class HomeProximityController {
  private rect: HomeProximityRect | undefined;
  private readonly clock: TimelineClock;
  private readonly applyOpacity: (opacity: number) => Promise<void> | void;
  private readonly reportError?: (context: string, error: unknown) => void;
  private target: HomeProximityTarget = "opaque";
  private appliedOpacity = HOME_OPAQUE_OPACITY;
  private fadeTimer: unknown | undefined;
  private disposed = false;
  private coordinateScaleFactor = 1;
  private snapshotRevision = -1;

  constructor(options: HomeProximityControllerOptions) {
    this.rect = options.rect;
    this.clock = options.clock ?? systemTimelineClock;
    this.applyOpacity = options.applyOpacity;
    this.reportError = options.reportError;
  }

  get currentTarget(): HomeProximityTarget {
    return this.target;
  }

  updateRect(rect: HomeProximityRect | undefined): void {
    this.clearFadeTimer();
    this.rect = rect;
    this.target = "opaque";
    this.appliedOpacity = HOME_OPAQUE_OPACITY;
    void this.safeApply(HOME_OPAQUE_OPACITY);
  }

  updateDesktopSnapshot(snapshot: NativeDesktopSnapshotV1): void {
    if (snapshot.snapshotRevision < this.snapshotRevision) return;
    this.snapshotRevision = snapshot.snapshotRevision;
    const rect = snapshot.homeWindow?.ready ? snapshot.homeWindow.rect : undefined;
    if (JSON.stringify(rect) === JSON.stringify(this.rect) && this.coordinateScaleFactor === snapshot.windowScaleFactor) return;
    this.coordinateScaleFactor = snapshot.windowScaleFactor;
    this.updateRect(rect);
  }

  get currentAppliedOpacity(): number {
    return this.appliedOpacity;
  }

  handlePointerSample(cursorLogical: LogicalPoint, pointerScaleFactor = this.coordinateScaleFactor): void {
    if (this.disposed || !this.rect) {
      return;
    }

    const ratio = this.coordinateScaleFactor / pointerScaleFactor;
    const next = resolveHomeProximityTarget(
      this.target,
      distanceToRectBounds(cursorLogical, { x: this.rect.x * ratio, y: this.rect.y * ratio,
        width: this.rect.width * ratio, height: this.rect.height * ratio }),
    );
    if (next === this.target) {
      return;
    }

    this.target = next;
    this.startFade(
      next === "translucent" ? HOME_PROXIMITY_OPACITY : HOME_OPAQUE_OPACITY,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.clearFadeTimer();
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer !== undefined) {
      this.clock.clearTimeout(this.fadeTimer);
      this.fadeTimer = undefined;
    }
  }

  private startFade(targetOpacity: number): void {
    this.clearFadeTimer();
    if (Math.abs(targetOpacity - this.appliedOpacity) < 0.01) {
      this.appliedOpacity = targetOpacity;
      void this.safeApply(targetOpacity);
      return;
    }

    const stepDelta =
      (targetOpacity - this.appliedOpacity) / HOME_PROXIMITY_FADE_STEPS;
    let stepsLeft = HOME_PROXIMITY_FADE_STEPS;
    const step = (): void => {
      if (this.disposed) {
        return;
      }
      stepsLeft -= 1;
      this.appliedOpacity =
        stepsLeft <= 0
          ? targetOpacity
          : clampOpacity(this.appliedOpacity + stepDelta);
      void this.safeApply(this.appliedOpacity);
      if (stepsLeft > 0) {
        this.fadeTimer = this.clock.setTimeout(step, HOME_PROXIMITY_FADE_STEP_MS);
      }
    };
    step();
  }

  private async safeApply(opacity: number): Promise<void> {
    try {
      await this.applyOpacity(opacity);
    } catch (error) {
      this.reportError?.("Home proximity opacity", error);
    }
  }
}
