import { describe, expect, it } from "vitest";

import {
  IllegalProductTransitionError,
  PRODUCT_STATE_NAMES,
  PRODUCT_STATE_PRIORITY,
  ProductStateMachine,
  canPreemptProductState,
  compareProductStatePriority,
  createProductFsmState,
  isLegalProductTransition,
  transitionProductState,
  type ProductFsmEvent,
} from "../src/product-fsm";

describe("PRODUCT_STATE_NAMES", () => {
  it("恰好覆盖 11 个产品状态", () => {
    expect(PRODUCT_STATE_NAMES).toEqual([
      "BOOTING",
      "IDLE",
      "WALK",
      "LOOK",
      "HAPPY",
      "DRAG",
      "FALL",
      "LAND",
      "GO_HOME",
      "REST",
      "LEAVE_HOME",
    ]);
  });

  it("每个状态都有优先级定义", () => {
    for (const name of PRODUCT_STATE_NAMES) {
      expect(typeof PRODUCT_STATE_PRIORITY[name]).toBe("number");
    }
  });
});

describe("优先级（冻结基线 DRAG > HAPPY > LOOK > WALK/IDLE）", () => {
  it("DRAG 抢占一切，IDLE/WALK 不抢占任何状态", () => {
    expect(canPreemptProductState("DRAG", "HAPPY")).toBe(true);
    expect(canPreemptProductState("HAPPY", "LOOK")).toBe(true);
    expect(canPreemptProductState("LOOK", "WALK")).toBe(true);
    expect(canPreemptProductState("WALK", "LOOK")).toBe(false);
    expect(canPreemptProductState("IDLE", "WALK")).toBe(false);
  });

  it("compareProductStatePriority 与冻结顺序一致", () => {
    expect(compareProductStatePriority("DRAG", "HAPPY")).toBeGreaterThan(0);
    expect(compareProductStatePriority("HAPPY", "LOOK")).toBeGreaterThan(0);
    expect(compareProductStatePriority("LOOK", "IDLE")).toBeGreaterThan(0);
    expect(compareProductStatePriority("IDLE", "WALK")).toBe(0);
  });
});

describe("createProductFsmState", () => {
  it("timerOwner 始终等于状态自身", () => {
    for (const name of PRODUCT_STATE_NAMES) {
      const state = createProductFsmState(name);
      expect(state.type).toBe(name);
      expect(state.timerOwner).toBe(name);
      expect(state.generation).toBe(0);
    }
  });

  it("拒绝非法 generation", () => {
    expect(() => createProductFsmState("IDLE", -1)).toThrow();
    expect(() => createProductFsmState("IDLE", 1.5)).toThrow();
  });
});

describe("isLegalProductTransition：核心路径", () => {
  const legal: Array<[string, string, ProductFsmEvent]> = [
    ["BOOTING", "IDLE", { type: "BOOT_COMPLETE" }],
    ["IDLE", "WALK", { type: "START_WALK" }],
    ["IDLE", "LOOK", { type: "ENTER_LOOK" }],
    ["IDLE", "HAPPY", { type: "START_HAPPY" }],
    ["IDLE", "DRAG", { type: "START_DRAG" }],
    ["WALK", "IDLE", { type: "RESET_TO_IDLE", reason: "autonomous-walk" }],
    ["WALK", "LOOK", { type: "ENTER_LOOK" }],
    ["LOOK", "IDLE", { type: "RESET_TO_IDLE", reason: "recovery" }],
    ["HAPPY", "IDLE", { type: "FINISH_HAPPY", next: "IDLE" }],
    ["HAPPY", "REST", { type: "FINISH_HAPPY", next: "REST" }],
    ["DRAG", "FALL", { type: "RELEASE_DRAG", next: "FALL" }],
    ["DRAG", "LAND", { type: "RELEASE_DRAG", next: "LAND" }],
    ["FALL", "LAND", { type: "FALL_CONTACT" }],
    ["FALL", "DRAG", { type: "START_DRAG" }],
    ["LAND", "IDLE", { type: "FINISH_LAND", next: "IDLE" }],
  ];

  it.each(legal)("%s -> %s 合法", (from, to, event) => {
    expect(
      isLegalProductTransition(
        from as never,
        to as never,
        event,
      ),
    ).toBe(true);
  });

  const illegal: Array<[string, string, ProductFsmEvent]> = [
    // BOOTING 只能 BOOT_COMPLETE 到 IDLE
    ["BOOTING", "WALK", { type: "START_WALK" }],
    ["BOOTING", "IDLE", { type: "RUNTIME_SYNC", next: "IDLE", reason: "runtime-sync" }],
    // LOOK 不能直接去 WALK（无对应事件路径）
    ["LOOK", "WALK", { type: "START_WALK" }],
    // REST 不能进入 FALL
    ["REST", "FALL", { type: "FALL_CONTACT" }],
    // HAPPY 未 FINISH 不能直接去 WALK
    ["HAPPY", "WALK", { type: "START_WALK" }],
    // FALL 不能越过 LAND 直接回 IDLE（除 RESET_TO_IDLE）
    ["FALL", "IDLE", { type: "FINISH_LAND", next: "IDLE" }],
  ];

  it.each(illegal)("%s -> %s 非法", (from, to, event) => {
    expect(
      isLegalProductTransition(
        from as never,
        to as never,
        event,
      ),
    ).toBe(false);
  });
});

describe("isLegalProductTransition：Home 路径", () => {
  it("IDLE → GO_HOME → REST → LEAVE_HOME → IDLE 全程合法", () => {
    expect(
      isLegalProductTransition("IDLE", "GO_HOME", {
        type: "HOME_CYCLE_STEP",
        next: "GO_HOME",
      }),
    ).toBe(true);
    expect(
      isLegalProductTransition("GO_HOME", "REST", {
        type: "HOME_CYCLE_STEP",
        next: "REST",
      }),
    ).toBe(true);
    expect(
      isLegalProductTransition("REST", "LEAVE_HOME", {
        type: "HOME_CYCLE_STEP",
        next: "LEAVE_HOME",
      }),
    ).toBe(true);
    expect(
      isLegalProductTransition("LEAVE_HOME", "IDLE", {
        type: "HOME_CYCLE_STEP",
        next: "IDLE",
      }),
    ).toBe(true);
  });

  it("GO_HOME 可被 DRAG 打断（冻结优先级）", () => {
    expect(
      isLegalProductTransition("GO_HOME", "DRAG", { type: "START_DRAG" }),
    ).toBe(true);
  });
});

describe("同状态事件", () => {
  it("RESET_TO_IDLE / HOME_CYCLE_STEP / RUNTIME_SYNC 允许同状态", () => {
    expect(
      isLegalProductTransition("IDLE", "IDLE", {
        type: "RESET_TO_IDLE",
        reason: "recovery",
      }),
    ).toBe(true);
    expect(
      isLegalProductTransition("GO_HOME", "GO_HOME", {
        type: "HOME_CYCLE_STEP",
        next: "GO_HOME",
      }),
    ).toBe(true);
    expect(
      isLegalProductTransition("WALK", "WALK", {
        type: "RUNTIME_SYNC",
        next: "WALK",
        reason: "runtime-sync",
      }),
    ).toBe(true);
  });

  it("其他事件不允许同状态自转", () => {
    expect(
      isLegalProductTransition("WALK", "WALK", { type: "START_WALK" }),
    ).toBe(false);
    expect(
      isLegalProductTransition("HAPPY", "HAPPY", { type: "START_HAPPY" }),
    ).toBe(false);
  });
});

describe("transitionProductState", () => {
  it("跨状态转换 generation +1", () => {
    const idle = createProductFsmState("IDLE", 3);
    const walk = transitionProductState(idle, { type: "START_WALK" });
    expect(walk.type).toBe("WALK");
    expect(walk.generation).toBe(4);
  });

  it("同状态事件返回原对象（generation 不变）", () => {
    const idle = createProductFsmState("IDLE", 7);
    const same = transitionProductState(idle, {
      type: "RESET_TO_IDLE",
      reason: "recovery",
    });
    expect(same).toBe(idle);
  });

  it("非法转换抛出 IllegalProductTransitionError 并携带上下文", () => {
    const look = createProductFsmState("LOOK");
    try {
      transitionProductState(look, { type: "START_WALK" });
      expect.unreachable("应当抛出");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalProductTransitionError);
      const typed = error as IllegalProductTransitionError;
      expect(typed.from).toBe("LOOK");
      expect(typed.to).toBe("WALK");
      expect(typed.eventType).toBe("START_WALK");
    }
  });
});

describe("ProductStateMachine", () => {
  it("初始为 BOOTING，BOOT_COMPLETE 后进入 IDLE", () => {
    const machine = new ProductStateMachine();
    expect(machine.state.type).toBe("BOOTING");
    machine.transition({ type: "BOOT_COMPLETE" });
    expect(machine.state.type).toBe("IDLE");
    expect(machine.state.generation).toBe(1);
  });

  it("transitionTo 在 BOOTING→IDLE 时走 BOOT_COMPLETE 而非 RUNTIME_SYNC", () => {
    const machine = new ProductStateMachine();
    machine.transitionTo("IDLE");
    expect(machine.state.type).toBe("IDLE");
  });

  it("transitionTo 对其他状态走 RUNTIME_SYNC 并遵守转换图", () => {
    const machine = new ProductStateMachine();
    machine.transition({ type: "BOOT_COMPLETE" });
    machine.transitionTo("WALK");
    expect(machine.state.type).toBe("WALK");
    // WALK -> REST 不是合法的 RUNTIME_SYNC 目标
    expect(() => machine.transitionTo("REST")).toThrow(
      IllegalProductTransitionError,
    );
  });

  it("isCurrent 凭据同时匹配 type 与 generation", () => {
    const machine = new ProductStateMachine();
    machine.transition({ type: "BOOT_COMPLETE" });
    const ticket = { type: "IDLE" as const, generation: machine.state.generation };
    expect(machine.isCurrent(ticket)).toBe(true);

    machine.transition({ type: "START_WALK" });
    expect(machine.isCurrent(ticket)).toBe(false);
    expect(
      machine.isCurrent({ type: "WALK", generation: machine.state.generation }),
    ).toBe(true);
  });
});
