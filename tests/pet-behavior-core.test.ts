import { describe, expect, it } from "vitest";

import {
  FALL_WORK_AREA_REFRESH_INTERVAL_MS,
  IDLE_OR_PAUSE_WEIGHT,
  MAX_FALL_PHYSICS_DELTA_MS,
  PET_BEHAVIOR_CONFIG,
  RUNTIME_FOOT_BASELINE_LOGICAL_PX,
  asWindowTopLeftLogical,
  chooseAutonomousAction,
  chooseFacing,
  clamp,
  clampFallPhysicsDeltaMs,
  clampToWorkArea,
  distanceFromPetCenter,
  getGroundWindowTopY,
  integrateFallPhysicsStep,
  overlapArea,
  positionsMatch,
  rectsOverlap,
  sampleBlinkDelayMs,
  sampleIdleDurationMs,
  samplePauseDurationMs,
  sampleWalkDurationMs,
  sampleWalkSpeedLogicalPxPerSecond,
  shouldScheduleDoubleBlink,
  windowRectAt,
} from "../src/pet-behavior-core";

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

/** 构造确定性的伪随机源。 */
function fixed(value: number): () => number {
  return () => value;
}

describe("冻结配置与 AGENTS.md 基线一致", () => {
  it("行为数值等于冻结表", () => {
    expect(PET_BEHAVIOR_CONFIG.idle).toEqual({
      minDurationMs: 3_000,
      maxDurationMs: 8_000,
    });
    expect(PET_BEHAVIOR_CONFIG.blink.intervalMinMs).toBe(2_500);
    expect(PET_BEHAVIOR_CONFIG.blink.intervalMaxMs).toBe(6_000);
    expect(PET_BEHAVIOR_CONFIG.walk.minSpeedLogicalPxPerSecond).toBe(45);
    expect(PET_BEHAVIOR_CONFIG.walk.maxSpeedLogicalPxPerSecond).toBe(60);
    expect(PET_BEHAVIOR_CONFIG.pause).toEqual({
      minDurationMs: 1_000,
      maxDurationMs: 3_000,
    });
    expect(PET_BEHAVIOR_CONFIG.look.enterRadiusLogicalPx).toBe(90);
    expect(PET_BEHAVIOR_CONFIG.look.exitRadiusLogicalPx).toBe(130);
    expect(PET_BEHAVIOR_CONFIG.look.exitDelayMs).toBe(500);
    expect(PET_BEHAVIOR_CONFIG.fall.gravityLogicalPxPerSecondSquared).toBe(1_150);
    expect(PET_BEHAVIOR_CONFIG.fall.maxSpeedLogicalPxPerSecond).toBe(900);
    expect(PET_BEHAVIOR_CONFIG.land.durationMs).toBe(400);
    expect(IDLE_OR_PAUSE_WEIGHT).toBe(0.65);
    expect(RUNTIME_FOOT_BASELINE_LOGICAL_PX).toBe(140);
    expect(MAX_FALL_PHYSICS_DELTA_MS).toBe(100);
    expect(FALL_WORK_AREA_REFRESH_INTERVAL_MS).toBe(250);
  });
});

describe("采样函数：结果落在冻结区间内", () => {
  it("idle / pause / walk / blink 采样覆盖区间端点", () => {
    expect(sampleIdleDurationMs(fixed(0))).toBe(3_000);
    expect(sampleIdleDurationMs(fixed(1))).toBe(8_000);
    expect(samplePauseDurationMs(fixed(0))).toBe(1_000);
    expect(samplePauseDurationMs(fixed(1))).toBe(3_000);
    expect(sampleWalkDurationMs(fixed(0))).toBe(2_000);
    expect(sampleWalkDurationMs(fixed(1))).toBe(6_000);
    expect(sampleBlinkDelayMs(fixed(0))).toBe(2_500);
    expect(sampleBlinkDelayMs(fixed(1))).toBe(6_000);
  });

  it("walk 速度采样落在 45–60 logical px/s", () => {
    expect(sampleWalkSpeedLogicalPxPerSecond(fixed(0))).toBe(45);
    expect(sampleWalkSpeedLogicalPxPerSecond(fixed(1))).toBe(60);
  });

  it("非有限随机源直接抛错（fail-closed）", () => {
    expect(() => sampleIdleDurationMs(() => Number.NaN)).toThrow();
    expect(() => chooseFacing(() => Number.POSITIVE_INFINITY)).toThrow();
  });

  it("越界随机值被钳制到 [0,1]", () => {
    expect(sampleIdleDurationMs(() => -5)).toBe(3_000);
    expect(sampleIdleDurationMs(() => 42)).toBe(8_000);
  });
});

describe("自主决策权重（IDLE/PAUSE 65%，WALK 35%）", () => {
  it("chooseAutonomousAction 按 0.65 分界", () => {
    expect(chooseAutonomousAction(fixed(0))).toBe("PAUSE");
    expect(chooseAutonomousAction(fixed(0.649))).toBe("PAUSE");
    expect(chooseAutonomousAction(fixed(0.65))).toBe("WALK");
    expect(chooseAutonomousAction(fixed(1))).toBe("WALK");
  });

  it("chooseFacing 以 0.5 分界", () => {
    expect(chooseFacing(fixed(0.49))).toBe("Left");
    expect(chooseFacing(fixed(0.5))).toBe("Right");
  });

  it("shouldScheduleDoubleBlink 按 0.08 低概率分界", () => {
    expect(shouldScheduleDoubleBlink(fixed(0.07))).toBe(true);
    expect(shouldScheduleDoubleBlink(fixed(0.08))).toBe(false);
  });
});

describe("Fall 物理（重力 1150 px/s²，限速 900 px/s）", () => {
  it("delta 被钳制到 [0, 100ms]，拒绝非有限输入", () => {
    expect(clampFallPhysicsDeltaMs(16.7)).toBe(16.7);
    expect(clampFallPhysicsDeltaMs(0)).toBe(0);
    expect(clampFallPhysicsDeltaMs(-50)).toBe(0);
    expect(clampFallPhysicsDeltaMs(500)).toBe(100);
    expect(() => clampFallPhysicsDeltaMs(Number.NaN)).toThrow();
  });

  it("从静止积分：速度随重力增长，位置按梯形积分", () => {
    const step = integrateFallPhysicsStep(0, 0, 100);
    // v = 1150 * 0.1 = 115
    expect(step.verticalVelocityLogicalPxPerSecond).toBe(115);
    // y = (0 + 115) / 2 * 0.1 = 5.75
    expect(step.positionY).toBe(5.75);
    expect(step.elapsedMs).toBe(100);
  });

  it("速度封顶 900 px/s，且不出现负速度", () => {
    const capped = integrateFallPhysicsStep(0, 890, 100);
    expect(capped.verticalVelocityLogicalPxPerSecond).toBe(900);

    const negative = integrateFallPhysicsStep(0, -300, 100);
    expect(negative.verticalVelocityLogicalPxPerSecond).toBeGreaterThanOrEqual(0);
  });

  it("非有限位置或速度直接抛错", () => {
    expect(() => integrateFallPhysicsStep(Number.NaN, 0, 16)).toThrow();
    expect(() => integrateFallPhysicsStep(0, Number.NaN, 16)).toThrow();
  });
});

describe("几何与基线", () => {
  it("getGroundWindowTopY = workArea 底 - 140 脚基线", () => {
    expect(getGroundWindowTopY(WORK_AREA)).toBe(1080 - 140);
    expect(getGroundWindowTopY({ x: 100, y: 200, width: 800, height: 600 })).toBe(
      200 + 600 - 140,
    );
  });

  it("clamp 与 clampToWorkArea 把窗口限制在 WorkArea 内", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);

    const clamped = clampToWorkArea({ x: -100, y: 0 }, WORK_AREA);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(1080 - 140);
  });

  it("矩形重叠判定与面积", () => {
    const a = { left: 0, top: 0, right: 100, bottom: 100 };
    const b = { left: 50, top: 50, right: 150, bottom: 150 };
    const far = { left: 200, top: 200, right: 300, bottom: 300 };

    expect(rectsOverlap(a, b)).toBe(true);
    expect(rectsOverlap(a, far)).toBe(false);
    expect(overlapArea(a, b)).toBe(50 * 50);
    expect(overlapArea(a, far)).toBe(0);
  });

  it("windowRectAt 使用 160px 运行视口", () => {
    expect(windowRectAt({ x: 10, y: 20 })).toEqual({
      left: 10,
      top: 20,
      right: 170,
      bottom: 180,
    });
    expect(distanceFromPetCenter({ x: 0, y: 0 })).toBeCloseTo(
      Math.hypot(80, 80),
    );
  });

  it("positionsMatch 容差与 asWindowTopLeftLogical fail-closed", () => {
    expect(positionsMatch(1, 1 + 1e-7)).toBe(true);
    expect(positionsMatch(1, 1.1)).toBe(false);

    expect(asWindowTopLeftLogical({ x: 3, y: 4 })).toEqual({
      space: "WINDOW_TOP_LEFT_LOGICAL",
      x: 3,
      y: 4,
    });
    expect(asWindowTopLeftLogical({ x: Number.NaN, y: 4 })).toBeUndefined();
  });
});
