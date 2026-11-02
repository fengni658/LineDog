export const PRODUCT_STATE_NAMES = [
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
] as const;

export type ProductStateName = (typeof PRODUCT_STATE_NAMES)[number];
export type ProductStateTicket = Readonly<{
  type: ProductStateName;
  generation: number;
}>;

/**
 * Product behavior is a discriminated union. The timer owner travels with
 * the state so that a state cannot silently borrow another state's timer.
 */
export type ProductFsmState = {
  readonly [Name in ProductStateName]: Readonly<{
    type: Name;
    generation: number;
    timerOwner: Name;
  }>;
}[ProductStateName];

export type ProductTransitionReason =
  | "boot-complete"
  | "autonomous-walk"
  | "look-enter"
  | "happy-start"
  | "drag-start"
  | "drag-release"
  | "fall-contact"
  | "land-complete"
  | "home-cycle-step"
  | "recovery"
  | "runtime-sync";

export type ProductFsmEvent =
  | Readonly<{ type: "BOOT_COMPLETE" }>
  | Readonly<{ type: "RESET_TO_IDLE"; reason: ProductTransitionReason }>
  | Readonly<{ type: "START_WALK" }>
  | Readonly<{ type: "ENTER_LOOK" }>
  | Readonly<{ type: "START_HAPPY" }>
  | Readonly<{
      type: "FINISH_HAPPY";
      next: "IDLE" | "LOOK" | "REST";
    }>
  | Readonly<{ type: "START_DRAG" }>
  | Readonly<{
      type: "RELEASE_DRAG";
      next: "IDLE" | "FALL" | "LAND";
    }>
  | Readonly<{ type: "FALL_CONTACT" }>
  | Readonly<{
      type: "FINISH_LAND";
      next: "IDLE" | "REST";
    }>
  | Readonly<{
      type: "HOME_CYCLE_STEP";
      next: "IDLE" | "GO_HOME" | "REST" | "LEAVE_HOME" | "LAND";
    }>
  | Readonly<{
      type: "RUNTIME_SYNC";
      next: ProductStateName;
      reason: ProductTransitionReason;
    }>;

/**
 * Contention order for the frozen baseline "DRAG > HAPPY > LOOK > WALK/IDLE".
 *
 * This table is the executable statement of that baseline, but it is NOT a
 * transition filter. Runtime enforces contention imperatively at the two
 * places a lower-priority request can actually interrupt a higher state:
 * `triggerHappy()` and `startLook()` (see src/pet-runtime.ts). Those guards
 * also reject by interaction ("NONE" is required), which the table cannot
 * express, and they deny a same-state re-trigger that this table scores as 0.
 *
 * Do NOT gate `updateState()` on this table. Several downward transitions are
 * legitimate and load-bearing: DRAG -> FALL (releasing the pet), FALL -> LAND
 * -> IDLE, LEAVE_HOME -> IDLE, and RECOVERY -> IDLE. Filtering those by
 * priority would stop the pet from ever falling or leaving Home.
 */
export const PRODUCT_STATE_PRIORITY: Readonly<
  Record<ProductStateName, number>
> = {
  BOOTING: -1,
  IDLE: 0,
  WALK: 0,
  GO_HOME: 1,
  REST: 1,
  LEAVE_HOME: 1,
  LOOK: 2,
  HAPPY: 3,
  FALL: 4,
  LAND: 4,
  DRAG: 5,
};

export function compareProductStatePriority(
  left: ProductStateName,
  right: ProductStateName,
): number {
  return PRODUCT_STATE_PRIORITY[left] - PRODUCT_STATE_PRIORITY[right];
}

export function canPreemptProductState(
  requested: ProductStateName,
  current: ProductStateName,
): boolean {
  return compareProductStatePriority(requested, current) > 0;
}

export function assertNever(value: never): never {
  throw new Error(`LineDog Product FSM received an unsupported value: ${String(value)}.`);
}

export function createProductFsmState(
  type: ProductStateName,
  generation = 0,
): ProductFsmState {
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error("LineDog Product FSM generation must be a non-negative integer.");
  }

  switch (type) {
    case "BOOTING":
      return { type, generation, timerOwner: type };
    case "IDLE":
      return { type, generation, timerOwner: type };
    case "WALK":
      return { type, generation, timerOwner: type };
    case "LOOK":
      return { type, generation, timerOwner: type };
    case "HAPPY":
      return { type, generation, timerOwner: type };
    case "DRAG":
      return { type, generation, timerOwner: type };
    case "FALL":
      return { type, generation, timerOwner: type };
    case "LAND":
      return { type, generation, timerOwner: type };
    case "GO_HOME":
      return { type, generation, timerOwner: type };
    case "REST":
      return { type, generation, timerOwner: type };
    case "LEAVE_HOME":
      return { type, generation, timerOwner: type };
    default:
      return assertNever(type);
  }
}

function transitionTarget(event: ProductFsmEvent): ProductStateName {
  switch (event.type) {
    case "BOOT_COMPLETE":
      return "IDLE";
    case "RESET_TO_IDLE":
      return "IDLE";
    case "START_WALK":
      return "WALK";
    case "ENTER_LOOK":
      return "LOOK";
    case "START_HAPPY":
      return "HAPPY";
    case "FINISH_HAPPY":
      return event.next;
    case "START_DRAG":
      return "DRAG";
    case "RELEASE_DRAG":
      return event.next;
    case "FALL_CONTACT":
      return "LAND";
    case "FINISH_LAND":
      return event.next;
    case "HOME_CYCLE_STEP":
      return event.next;
    case "RUNTIME_SYNC":
      return event.next;
    default:
      return assertNever(event);
  }
}

function sameStateEventAllowed(event: ProductFsmEvent): boolean {
  switch (event.type) {
    case "RESET_TO_IDLE":
    case "HOME_CYCLE_STEP":
    case "RUNTIME_SYNC":
      return true;
    case "BOOT_COMPLETE":
    case "START_WALK":
    case "ENTER_LOOK":
    case "START_HAPPY":
    case "FINISH_HAPPY":
    case "START_DRAG":
    case "RELEASE_DRAG":
    case "FALL_CONTACT":
    case "FINISH_LAND":
      return false;
    default:
      return assertNever(event);
  }
}

/**
 * This graph describes the product-level behavior contract. Route phases and
 * animation layers remain separate facts; they do not create extra behavior
 * states or bypass this transition boundary.
 */
export function isLegalProductTransition(
  from: ProductStateName,
  to: ProductStateName,
  event: ProductFsmEvent,
): boolean {
  if (from === to) {
    return sameStateEventAllowed(event);
  }

  // Loss of an actual Home support surface uses the existing gravity path.
  // It can also interrupt an in-home Happy feedback; no second FSM is involved.
  if (event.type === "RUNTIME_SYNC" && (to === "FALL" || to === "LAND") &&
      (from === "GO_HOME" || from === "REST" || from === "LEAVE_HOME" || from === "HAPPY")) {
    return true;
  }

  switch (from) {
    case "BOOTING":
      return event.type === "BOOT_COMPLETE" && to === "IDLE";
    case "IDLE":
      return (
        (event.type === "START_WALK" && to === "WALK") ||
        (event.type === "ENTER_LOOK" && to === "LOOK") ||
        (event.type === "START_HAPPY" && to === "HAPPY") ||
        (event.type === "START_DRAG" && to === "DRAG") ||
        (event.type === "HOME_CYCLE_STEP" &&
          (to === "GO_HOME" || to === "LEAVE_HOME" || to === "LAND")) ||
        (event.type === "RUNTIME_SYNC" &&
          (to === "WALK" ||
            to === "LOOK" ||
            to === "HAPPY" ||
            to === "DRAG" ||
            to === "GO_HOME" ||
            to === "LEAVE_HOME" ||
            to === "LAND"))
      );
    case "WALK":
      return (
        (event.type === "RESET_TO_IDLE" && to === "IDLE") ||
        (event.type === "ENTER_LOOK" && to === "LOOK") ||
        (event.type === "START_HAPPY" && to === "HAPPY") ||
        (event.type === "START_DRAG" && to === "DRAG") ||
        (event.type === "HOME_CYCLE_STEP" &&
          (to === "GO_HOME" || to === "LEAVE_HOME")) ||
        (event.type === "RUNTIME_SYNC" &&
          (to === "IDLE" ||
            to === "LOOK" ||
            to === "HAPPY" ||
            to === "DRAG" ||
            to === "GO_HOME" ||
            to === "LEAVE_HOME"))
      );
    case "LOOK":
      return (
        (event.type === "RESET_TO_IDLE" && to === "IDLE") ||
        (event.type === "START_HAPPY" && to === "HAPPY") ||
        (event.type === "START_DRAG" && to === "DRAG") ||
        (event.type === "RUNTIME_SYNC" &&
          (to === "IDLE" || to === "HAPPY" || to === "DRAG"))
      );
    case "HAPPY":
      return (
        (event.type === "FINISH_HAPPY" &&
          (to === "IDLE" || to === "LOOK" || to === "REST")) ||
        (event.type === "START_DRAG" && to === "DRAG") ||
        (event.type === "RUNTIME_SYNC" &&
          (to === "IDLE" || to === "LOOK" || to === "REST" || to === "DRAG"))
      );
    case "DRAG":
      return (
        (event.type === "RELEASE_DRAG" &&
          (to === "IDLE" || to === "FALL" || to === "LAND")) ||
        (event.type === "FALL_CONTACT" && to === "LAND") ||
        (event.type === "RUNTIME_SYNC" &&
          (to === "IDLE" || to === "FALL" || to === "LAND"))
      );
    case "FALL":
      return (
        (event.type === "FALL_CONTACT" && to === "LAND") ||
        (event.type === "START_DRAG" && to === "DRAG") ||
        (event.type === "RESET_TO_IDLE" && to === "IDLE") ||
        (event.type === "RUNTIME_SYNC" &&
          (to === "IDLE" || to === "LAND" || to === "DRAG"))
      );
    case "LAND":
      return (
        (event.type === "FINISH_LAND" && (to === "IDLE" || to === "REST")) ||
        (event.type === "START_DRAG" && to === "DRAG") ||
        (event.type === "RUNTIME_SYNC" &&
          (to === "IDLE" || to === "REST" || to === "DRAG"))
      );
    case "GO_HOME":
      return (
        (event.type === "HOME_CYCLE_STEP" &&
          (to === "GO_HOME" || to === "LAND" || to === "REST")) ||
        (event.type === "START_DRAG" && to === "DRAG") ||
        (event.type === "START_HAPPY" && to === "HAPPY") ||
        (event.type === "RESET_TO_IDLE" && to === "IDLE") ||
        (event.type === "RUNTIME_SYNC" &&
          (to === "IDLE" || to === "LAND" || to === "REST" || to === "DRAG" || to === "HAPPY"))
      );
    case "REST":
      return (
        (event.type === "HOME_CYCLE_STEP" && to === "LEAVE_HOME") ||
        (event.type === "START_HAPPY" && to === "HAPPY") ||
        (event.type === "START_DRAG" && to === "DRAG") ||
        (event.type === "RESET_TO_IDLE" && to === "IDLE") ||
        (event.type === "RUNTIME_SYNC" &&
          (to === "IDLE" || to === "LEAVE_HOME" || to === "HAPPY" || to === "DRAG"))
      );
    case "LEAVE_HOME":
      return (
        (event.type === "HOME_CYCLE_STEP" && to === "IDLE") ||
        (event.type === "START_DRAG" && to === "DRAG") ||
        (event.type === "START_HAPPY" && to === "HAPPY") ||
        (event.type === "RESET_TO_IDLE" && to === "IDLE") ||
        (event.type === "RUNTIME_SYNC" &&
          (to === "IDLE" || to === "DRAG" || to === "HAPPY"))
      );
    default:
      return assertNever(from);
  }
}

export class IllegalProductTransitionError extends Error {
  readonly from: ProductStateName;
  readonly to: ProductStateName;
  readonly eventType: ProductFsmEvent["type"];

  constructor(
    from: ProductStateName,
    to: ProductStateName,
    eventType: ProductFsmEvent["type"],
  ) {
    super(`LineDog Product FSM rejected ${from} -> ${to} for ${eventType}.`);
    this.name = "IllegalProductTransitionError";
    this.from = from;
    this.to = to;
    this.eventType = eventType;
  }
}

export function transitionProductState(
  state: ProductFsmState,
  event: ProductFsmEvent,
): ProductFsmState {
  const nextType = transitionTarget(event);
  if (!isLegalProductTransition(state.type, nextType, event)) {
    throw new IllegalProductTransitionError(state.type, nextType, event.type);
  }

  return nextType === state.type
    ? state
    : createProductFsmState(nextType, state.generation + 1);
}

export class ProductStateMachine {
  private currentState: ProductFsmState = createProductFsmState("BOOTING");

  get state(): ProductFsmState {
    return this.currentState;
  }

  transition(event: ProductFsmEvent): ProductFsmState {
    this.currentState = transitionProductState(this.currentState, event);
    return this.currentState;
  }

  transitionTo(
    next: ProductStateName,
    reason: ProductTransitionReason = "runtime-sync",
  ): ProductFsmState {
    if (this.currentState.type === "BOOTING" && next === "IDLE") {
      return this.transition({ type: "BOOT_COMPLETE" });
    }

    return this.transition({ type: "RUNTIME_SYNC", next, reason });
  }

  isCurrent(ticket: ProductStateTicket): boolean {
    return (
      ticket.type === this.currentState.type &&
      ticket.generation === this.currentState.generation
    );
  }
}
