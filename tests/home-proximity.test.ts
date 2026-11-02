import { describe, expect, it } from "vitest";
import type { TimelineClock } from "../src/animation-timeline";
import type { LogicalPoint } from "../src/native-motion";
import {
  HOME_OPAQUE_OPACITY,
  HOME_PROXIMITY_ENTER_LOGICAL_PX,
  HOME_PROXIMITY_EXIT_LOGICAL_PX,
  HOME_PROXIMITY_FADE_STEPS,
  HOME_PROXIMITY_OPACITY,
  HomeProximityController,
  distanceToRectBounds,
  resolveHomeProximityTarget,
} from "../src/home-proximity";

const HOME_RECT = { x: 700, y: 400, width: 256, height: 256 };

class ManualClock implements TimelineClock {
  private currentTimeMs = 0;
  private nextTimerId = 0;
  private readonly timers = new Map<
    number,
    { readonly dueAtMs: number; readonly callback: () => void }
  >();

  now(): number {
    return this.currentTimeMs;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const timerId = ++this.nextTimerId;
    this.timers.set(timerId, {
      dueAtMs: this.currentTimeMs + Math.max(0, delayMs),
      callback,
    });
    return timerId;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") {
      this.timers.delete(handle);
    }
  }

  advanceBy(deltaMs: number): void {
    this.currentTimeMs += deltaMs;
    while (true) {
      let nextTimerId: number | undefined;
      let nextDueAtMs = Number.POSITIVE_INFINITY;
      for (const [timerId, timer] of this.timers) {
        if (
          timer.dueAtMs <= this.currentTimeMs &&
          (timer.dueAtMs < nextDueAtMs ||
            (timer.dueAtMs === nextDueAtMs &&
              (nextTimerId === undefined || timerId < nextTimerId)))
        ) {
          nextTimerId = timerId;
          nextDueAtMs = timer.dueAtMs;
        }
      }
      if (nextTimerId === undefined) {
        return;
      }
      const timer = this.timers.get(nextTimerId);
      this.timers.delete(nextTimerId);
      timer?.callback();
    }
  }
}

function point(x: number, y: number): LogicalPoint {
  return { x, y };
}

describe("distanceToRectBounds", () => {
  it("follows the actual Home across Main DPI changes and rejects stale geometry", () => {
    const clock = new ManualClock();
    const controller = new HomeProximityController({ rect: undefined, clock, applyOpacity: () => undefined });
    const snapshot = { protocolVersion: "linedog.native/v1" as const, snapshotRevision: 2, capturedAtMonotonicMs: 0,
      currentMonitorId: "second", workArea: { x: 0, y: 0, width: 1000, height: 600 },
      windowPosition: { space: "WINDOW_TOP_LEFT_LOGICAL" as const, x: 100, y: 460 },
      windowScaleFactor: 1, monitorScaleFactor: 1,
      homeWindow: { ready: true, currentMonitorId: "first", windowScaleFactor: 1,
        rect: { x: -1000, y: 344, width: 256, height: 256 } } };
    controller.updateDesktopSnapshot(snapshot);
    controller.handlePointerSample({ x: -450, y: 230 }, 2);
    expect(controller.currentTarget).toBe("translucent");
    controller.updateDesktopSnapshot({ ...snapshot, snapshotRevision: 1, homeWindow: null });
    expect(controller.currentTarget).toBe("translucent");
    controller.handlePointerSample({ x: 900, y: 450 }, 2);
    expect(controller.currentTarget).toBe("opaque");
    controller.updateDesktopSnapshot({ ...snapshot, snapshotRevision: 3, homeWindow: null });
    controller.handlePointerSample({ x: -450, y: 230 }, 2);
    expect(controller.currentTarget).toBe("opaque"); controller.dispose();
  });
  it("矩形内部与边界距离为 0", () => {
    expect(distanceToRectBounds(point(800, 500), HOME_RECT)).toBe(0);
    expect(distanceToRectBounds(point(700, 400), HOME_RECT)).toBe(0);
  });

  it("外部取到最近边/角的欧氏距离", () => {
    expect(distanceToRectBounds(point(600, 500), HOME_RECT)).toBe(100);
    expect(distanceToRectBounds(point(600, 300), HOME_RECT)).toBe(
      Math.hypot(100, 100),
    );
  });

  it("非有限输入或退化矩形 fail-closed 返回 Infinity", () => {
    expect(
      distanceToRectBounds(point(Number.NaN, 0), HOME_RECT),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(
      distanceToRectBounds(point(0, 0), { x: 0, y: 0, width: 0, height: 10 }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("resolveHomeProximityTarget", () => {
  it("非透明态用进入半径判定", () => {
    expect(
      resolveHomeProximityTarget("opaque", HOME_PROXIMITY_ENTER_LOGICAL_PX),
    ).toBe("translucent");
    expect(
      resolveHomeProximityTarget(
        "opaque",
        HOME_PROXIMITY_ENTER_LOGICAL_PX + 1,
      ),
    ).toBe("opaque");
  });

  it("半透明态用更大的退出半径滞回，避免边界抖动", () => {
    const between = HOME_PROXIMITY_ENTER_LOGICAL_PX + 1;
    expect(between).toBeLessThan(HOME_PROXIMITY_EXIT_LOGICAL_PX);
    expect(resolveHomeProximityTarget("translucent", between)).toBe(
      "translucent",
    );
    expect(
      resolveHomeProximityTarget("translucent", HOME_PROXIMITY_EXIT_LOGICAL_PX),
    ).toBe("translucent");
    expect(
      resolveHomeProximityTarget(
        "translucent",
        HOME_PROXIMITY_EXIT_LOGICAL_PX + 1,
      ),
    ).toBe("opaque");
  });

  it("不可信距离一律判远离", () => {
    expect(
      resolveHomeProximityTarget("translucent", Number.POSITIVE_INFINITY),
    ).toBe("opaque");
  });
});

describe("HomeProximityController", () => {
  function makeController(
    clock: ManualClock,
    options: { rect?: typeof HOME_RECT | undefined } = {},
  ) {
    const applied: number[] = [];
    const controller = new HomeProximityController({
      rect: "rect" in options ? options.rect : HOME_RECT,
      clock,
      applyOpacity: (opacity) => {
        applied.push(opacity);
      },
    });
    return { controller, applied };
  }

  it("靠近时渐变到半透明，移开后渐变恢复不透明", () => {
    const clock = new ManualClock();
    const { controller, applied } = makeController(clock);

    controller.handlePointerSample(point(750, 450));
    expect(controller.currentTarget).toBe("translucent");
    // ManualClock 的 advanceBy 不重入同一批次内新调度的定时器，逐批推进。
    for (let i = 0; i < HOME_PROXIMITY_FADE_STEPS; i += 1) {
      clock.advanceBy(50);
    }
    expect(applied).toHaveLength(HOME_PROXIMITY_FADE_STEPS);
    expect(applied.at(-1)).toBeCloseTo(HOME_PROXIMITY_OPACITY, 5);
    expect(controller.currentAppliedOpacity).toBeCloseTo(
      HOME_PROXIMITY_OPACITY,
      5,
    );

    controller.handlePointerSample(point(100, 100));
    expect(controller.currentTarget).toBe("opaque");
    for (let i = 0; i < HOME_PROXIMITY_FADE_STEPS; i += 1) {
      clock.advanceBy(50);
    }
    expect(applied.at(-1)).toBeCloseTo(HOME_OPAQUE_OPACITY, 5);
  });

  it("滞回带内持续采样不会来回切换", () => {
    const clock = new ManualClock();
    const { controller, applied } = makeController(clock);

    controller.handlePointerSample(point(750, 450));
    clock.advanceBy(HOME_PROXIMITY_FADE_STEPS * 50);
    const afterEnter = applied.length;

    const bandPoint = point(
      700 - HOME_PROXIMITY_ENTER_LOGICAL_PX - 10,
      500,
    );
    for (let i = 0; i < 30; i += 1) {
      controller.handlePointerSample(bandPoint);
    }
    expect(controller.currentTarget).toBe("translucent");
    expect(applied).toHaveLength(afterEnter);
  });

  it("rect 缺失时保持不透明且不产生写入", () => {
    const clock = new ManualClock();
    const { controller, applied } = makeController(clock, { rect: undefined });

    controller.handlePointerSample(point(750, 450));
    clock.advanceBy(1000);
    expect(controller.currentTarget).toBe("opaque");
    expect(applied).toHaveLength(0);
  });

  it("dispose 取消进行中的渐变", () => {
    const clock = new ManualClock();
    const { controller, applied } = makeController(clock);

    controller.handlePointerSample(point(750, 450));
    controller.dispose();
    const count = applied.length;
    clock.advanceBy(1000);
    expect(applied).toHaveLength(count);
  });
});
