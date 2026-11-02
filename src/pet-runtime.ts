import {
  AnimationTimeline,
  systemTimelineClock,
  type TimelineClock,
  type TimelineFrameEvent,
} from "./animation-timeline";
import type {
  FocusedInputFact,
  LogicalRect,
} from "./input-avoidance";
import type {
  LogicalPoint,
  LogicalWorkArea,
  MotionSnapshot,
  PetMotionPort,
} from "./native-motion";
import type { WindowTopLeftLogical } from "./native-motion";
import {
  HOME_CYCLE_SPEED_LOGICAL_PX_PER_SECOND,
  HOME_CYCLE_TICK_MS,
  HOME_JUMP_DURATION_MS,
  HOME_JUMP_MAX_DISTANCE_LOGICAL,
  HOME_JUMP_WATCHDOG_MARGIN_MS,
  HOME_WAKE_HOLD_MS,
  HOME_AWAKE_DURATION_MS,
  HOME_INTERACTION_QUIET_MS,
  computeHomeLandingSurface,
  HOME_CHARACTER_FOOT_CENTER_LOGICAL_X,
  type HomeCyclePhase,
  type HomeLifecycleEvent,
  computeHomeEntryPoint,
  computeHomeJumpPoint,
  computeHomeJumpBounds,
  computeHomeRestPoint,
  crossesHomeLandingSurface,
  sampleHomeRoundTrips,
  computeHomeWalkRoute,
  resolveHomeSurface,
  type HomeSurfaceRect,
  HOME_APPROACH_DISTANCE_LOGICAL,
  sampleHomeRestDurationMsForRevision,
} from "./home-cycle";
import {
  MotionCoordinator,
  type MotionLease,
  type MotionOwner,
  type MotionWriteRejection,
} from "./motion-coordinator";
import type {
  DefaultRuntimeResources,
} from "./pet-manifest";
import {
  RUNTIME_VIEWPORT_SIZE,
  preloadRuntimeFrames,
  type ImageLoader,
} from "./sprite-renderer";
import {
  ProductStateMachine,
  assertNever,
  type ProductStateTicket,
  type ProductStateName,
} from "./product-fsm";
import {
  FALL_MOTION_TICK_MS,
  FALL_WORK_AREA_REFRESH_INTERVAL_MS,
  PET_BEHAVIOR_CONFIG,
  TURN_FACING_MIDPOINT_FRAME_INDEX,
  WALK_MOTION_TICK_MS,
  asWindowTopLeftLogical,
  chooseAutonomousAction,
  chooseFacing,
  clampFallPosition,
  clampFallPhysicsDeltaMs,
  RUNTIME_FOOT_BASELINE_LOGICAL_PX,
  clampToWorkArea,
  clampWindowToWorkArea,
  clampWorkAreaX,
  workAreaXRange,
  cloneWorkArea,
  distanceFromPetCenter,
  getGroundWindowTopY,
  integrateFallPhysicsStep,
  LOGICAL_EPSILON,
  isFiniteLogicalRect,
  isFiniteLogicalWorkArea,
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
  type Facing,
} from "./pet-behavior-core";

// 纯函数与冻结配置（几何、物理、采样）位于 pet-behavior-core.ts（无副作用、
// 可独立单测）；此处重导出以保持既有公共 API 不变。本文件保留有状态的编排逻辑。
export {
  DIRECT_INTERACTION_STOP_MAX_MS,
  FALL_MOTION_TICK_MS,
  FALL_WORK_AREA_REFRESH_INTERVAL_MS,
  IDLE_OR_PAUSE_WEIGHT,
  MAX_FALL_PHYSICS_DELTA_MS,
  PET_BEHAVIOR_CONFIG,
  RUNTIME_FOOT_BASELINE_LOGICAL_PX,
  TURN_FACING_MIDPOINT_FRAME_INDEX,
  WALK_MOTION_TICK_MS,
  chooseAutonomousAction,
  chooseFacing,
  clampFallPhysicsDeltaMs,
  getGroundWindowTopY,
  integrateFallPhysicsStep,
  sampleBlinkDelayMs,
  sampleIdleDurationMs,
  samplePauseDurationMs,
  sampleWalkDurationMs,
  sampleWalkSpeedLogicalPxPerSecond,
  shouldScheduleDoubleBlink,
} from "./pet-behavior-core";
export type { FallPhysicsStep } from "./pet-behavior-core";

export type PetBehaviorState = ProductStateName;

export type PetAnimationLayer = "BASE" | "BLINK";
export type PetVisualTransition = "NONE" | "TURN";
export type ParachutePhase = "NONE" | "OPENING" | "GLIDING" | "CLOSING";
export type PointerInteractionState = "NONE" | "ARMED" | "DRAG";
export type { AutonomousAction, Facing } from "./pet-behavior-core";

/**
 * Upper bound on the "no safe side" warning de-duplication set. It exists only
 * to suppress a repeat warning within one focus session, so keeping more ids
 * than this has no value and would grow for the whole process lifetime.
 */
const WARNED_FOCUS_SESSION_LIMIT = 256;

export interface PetRuntimeState {
  readonly autonomyPaused?: boolean;
  readonly restoreStatus?: "idle" | "busy" | "failed";
  readonly readiness: "loading" | "ready" | "failed";
  readonly behavior: PetBehaviorState;
  readonly productStateGeneration: number;
  readonly animationLayer: PetAnimationLayer;
  readonly activeAnimationId: string;
  readonly facing: Facing;
  readonly visualTransition: PetVisualTransition;
  readonly turnTargetFacing?: Facing;
  readonly turnFrameMirrored?: boolean;
  readonly interaction: PointerInteractionState;
  readonly isDragging: boolean;
  readonly pointerNearby: boolean;
  readonly pointerLogicalPosition?: LogicalPoint;
  readonly currentMonitorId?: string;
  /**
   * The outer-window top-left in logical coordinates. It is a display value,
   * not a motion anchor: `currentWindowTopLeft()` only falls back to it when no
   * authoritative native readback exists yet.
   */
  readonly logicalPosition?: LogicalPoint;
  /** Current coordinator authority for the single runtime motion owner. */
  readonly motionOwner?: MotionOwner;
  readonly verticalVelocityLogicalPxPerSecond?: number;
  readonly groundTopY?: number;
  /** Local FALL/LAND effect, independent of the sole product FSM. */
  readonly parachutePhase: ParachutePhase;
  /** Canopy openness: 0 is hidden, 1 is fully open. */
  readonly parachuteProgress: number;
  readonly inputAvoidanceFactRevision?: number;
  readonly escapePlanId?: number;
  readonly homeCyclePhase?: HomeCyclePhase;
  readonly homeCycleRevision?: number;
  readonly homeRoundTripsTarget?: number;
  readonly homeRoundTripsCompleted?: number;
  readonly homeWalkTargetX?: number;
  readonly homeAwakeStartedAtMs?: number;
  readonly homeQuietUntilMs?: number;
  readonly homeRestDeadlineMs?: number;
  readonly homePending?: boolean;
}

/**
 * Structural comparison used to suppress no-op state broadcasts. It walks both
 * objects by key instead of listing fields, so a newly added state field is
 * covered without updating this helper.
 */
function sameStateValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      sameStateValue(left[key], right[key]),
  );
}

function sameRuntimeState(a: PetRuntimeState, b: PetRuntimeState): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = new Set<string>([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameStateValue(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

export interface InputAvoidanceWarning {
  readonly code: "INPUT_AVOIDANCE_NO_SAFE_SIDE";
  readonly focusSessionId: string;
}

/** A read-only projection of existing policy; never a second behavior state machine. */
export type PetRuntimeDiagnostic = Readonly<{
  state: PetBehaviorState;
  home_stage: HomeCycleStage | "NONE";
  wait_reason: "none" | "initializing" | "runtime_failed" | "restoring" | "restore_failed" |
    "interaction" | "pointer_nearby" | "user_paused" | "input_unknown" | "input_blocked" |
    "home_awake_window" | "home_quiet_window" | "home_motion_unconfirmed" |
    "home_action_finishing" | "home_sleep" | "home_wake_hold" | "autonomous_interval";
  paused: boolean;
  home_pending: boolean;
  input_unknown: boolean;
  input_blocked: boolean;
}>;

export interface PetRuntimeOptions {
  readonly clock?: TimelineClock;
  readonly random?: () => number;
  readonly homeRandom?: () => number;
  readonly motionPort?: PetMotionPort;
  /** Native/browser viewport owns coordinate conversion and serializes resizes. */
  readonly setParachuteExpanded?: (expanded: boolean) => Promise<boolean>;
  /** Synchronize the motion adapter only when Runtime adopts the coordinate space. */
  readonly onMotionSnapshotAccepted?: (snapshot: MotionSnapshot) => void;
  readonly onFrame?: (event: TimelineFrameEvent) => void;
  readonly onStateChange?: (state: Readonly<PetRuntimeState>) => void;
  readonly onDiagnostic?: (diagnostic: PetRuntimeDiagnostic) => void;
  readonly onInputAvoidanceWarning?: (
    warning: InputAvoidanceWarning,
  ) => void;
  readonly onHomeLifecycle?: (event: HomeLifecycleEvent) => void;
  /** Runtime accepts the interaction; consumers only present its local text. */
  readonly onInteractionResponse?: (response: PetInteractionResponse | null) => void;
  /** A valid release was merged/throttled; presentation may acknowledge without replaying an action. */
  readonly onInteractionAcknowledged?: () => void;
}

export interface PetInteractionResponse {
  readonly id: number;
  readonly kind: "hello" | "walk" | "home" | "wake" | "playful" | "gentle" | "settled" | "cooldown";
  readonly action: "look" | "blink" | "happy" | "home" | "wake" | "still";
  readonly durationMs: number;
}

const INTERACTION_RESPONSE_INTERVAL_MS = 5000;
const PLAYFUL_CLICK_WINDOW_MS = 2000;
type ClickContext = "hello" | "walk" | "home" | "wake" | "settled";
type ActiveInteractionResponse = {
  readonly event: PetInteractionResponse;
  readonly revision: number;
  readonly startedAtMs: number;
  completionPending: boolean;
  closingPending: boolean;
};

type InputEscapeWalk = {
  readonly planId: number;
  targetX: number;
  readonly outcome: "CLEAR" | "MINIMUM_OVERLAP";
};

type ActiveWalk = {
  homeArrivalPending?: boolean;
  readonly revision: number;
  readonly endsAtMs: number;
  readonly speedLogicalPxPerSecond: number;
  readonly facing: Facing;
  workArea: MotionSnapshot["workArea"];
  readonly inputEscape?: InputEscapeWalk;
  readonly motionLease?: MotionLease;
  position: LogicalPoint;
  lastStepAtMs: number;
};

type PendingWalk = {
  readonly revision: number;
  readonly durationMs: number;
  readonly speedLogicalPxPerSecond: number;
  readonly facing: Facing;
  readonly currentMonitorId: string;
  workArea: MotionSnapshot["workArea"];
  position: LogicalPoint;
  readonly inputEscape?: InputEscapeWalk;
};

type ActiveTurn = {
  readonly revision: number;
  readonly targetFacing: Facing;
  readonly frameMirrored: boolean;
  pendingWalk: PendingWalk;
  facingSwitched: boolean;
};

type ActiveEscapePlan = {
  readonly id: number;
  readonly direction: Facing;
  targetX: number;
  readonly outcome: "CLEAR" | "MINIMUM_OVERLAP";
  readonly factKind: Exclude<FocusedInputFact["kind"], "none" | "system-caret">;
  readonly monitorId: string;
  readonly monitorRevision: number;
};

type ActiveInputAvoidanceFact = FocusedInputFact &
  Readonly<{
    kind: "dynamic-line" | "text-focus-only";
    monitorId: string;
    monitorRevision: number;
    workArea: LogicalWorkArea;
    forbiddenRegion: LogicalRect;
  }>;

function isActiveInputAvoidanceFact(
  fact: FocusedInputFact,
): fact is ActiveInputAvoidanceFact {
  return (
    (fact.kind === "dynamic-line" || fact.kind === "text-focus-only") &&
    typeof fact.monitorId === "string" &&
    fact.monitorId.length > 0 &&
    Number.isSafeInteger(fact.monitorRevision) &&
    fact.workArea !== undefined &&
    isFiniteLogicalWorkArea(fact.workArea) &&
    fact.forbiddenRegion !== undefined &&
    isFiniteLogicalRect(fact.forbiddenRegion)
  );
}

type FallParachute = {
  eligible: boolean;
  pending: boolean;
  elapsedMs: number;
  openingStartVelocity: number;
  baseX: number;
  swaySuppressed: boolean;
  readonly landingTopY: number;
  readonly homeRange?: { left: number; right: number };
};

type ActiveFall = {
  revision: number;
  currentMonitorId: string;
  workArea: LogicalWorkArea;
  position: LogicalPoint;
  verticalVelocityLogicalPxPerSecond: number;
  lastStepAtMs: number;
  nextWorkAreaRefreshAtMs: number;
  parachute?: FallParachute;
  spriteHeldForParachute?: boolean;
  readonly motionLease?: MotionLease;
};

type HomeCycleStage =
  | "APPROACH"
  | "JUMP"
  | "LAND"
  | "HOME_IDLE"
  | "AWAKE"
  | "SLEEP"
  | "WAKE_HOLD"
  | "LEAVE_JUMP";

type HomeCycle = {
  revision: number;
  roundTripsTarget: number;
  roundTripsCompleted: number;
  route?: { nearX: number; farX: number };
  routeLeg: "LOCATE" | "OUT" | "BACK" | "ENTRY";
  entryPoint: WindowTopLeftLogical;
  restPoint: WindowTopLeftLogical;
  stage?: HomeCycleStage;
  phase?: HomeCyclePhase;
  restDeadlineMs?: number;
  pausedSleepRemainingMs?: number;
  awakeStartedAtMs?: number;
  quietUntilMs?: number;
  awakeAction?: "IDLE" | "BLINK" | "LOOK";
  awakeActionEndsAtMs?: number;
  /** A click keeps the existing seated Home artwork until the next sleep. */
  interactionPose?: boolean;
  phaseTimer?: unknown;
  workArea: LogicalWorkArea;
  currentMonitorId: string;
  position: LogicalPoint;
  lastStepAtMs: number;
  jumpStartedAtMs?: number;
  jumpStart?: LogicalPoint;
};

function avoidanceFactSignature(fact: FocusedInputFact): string {
  const region = fact.forbiddenRegion;
  const workArea = fact.workArea;

  return [
    fact.kind,
    fact.approximate ? "approximate" : "precise",
    fact.monitorId ?? "<none>",
    fact.monitorRevision,
    fact.focusSessionId ?? "<none>",
    region
      ? `${region.left}:${region.top}:${region.right}:${region.bottom}`
      : "<none>",
    workArea
      ? `${workArea.x}:${workArea.y}:${workArea.width}:${workArea.height}`
      : "<none>",
  ].join("|");
}

export class PetRuntime {
  private readonly clock: TimelineClock;
  private readonly timeline: AnimationTimeline;
  private readonly random: () => number;
  private readonly homeRandom: () => number;
  private confirmedMotion?: { epoch: number; position: LogicalPoint };
  private readonly onFrame: (event: TimelineFrameEvent) => void;
  private readonly onStateChange: (state: Readonly<PetRuntimeState>) => void;
  private readonly onDiagnostic: ((diagnostic: PetRuntimeDiagnostic) => void) | undefined;
  private diagnosticQueued = false;
  private diagnosticSignature = "";
  private readonly onInputAvoidanceWarning: (
    warning: InputAvoidanceWarning,
  ) => void;
  private readonly motionPort: PetMotionPort | undefined;
  private readonly setParachuteExpanded: PetRuntimeOptions["setParachuteExpanded"];
  private readonly onMotionSnapshotAccepted: PetRuntimeOptions["onMotionSnapshotAccepted"];
  private readonly onInteractionResponse: PetRuntimeOptions["onInteractionResponse"];
  private readonly onInteractionAcknowledged: PetRuntimeOptions["onInteractionAcknowledged"];
  private interactionResponse: ActiveInteractionResponse | undefined;
  private interactionResponseTimer: unknown | undefined;
  private nextInteractionResponseId = 0;
  private interactionPresentationVisible = false;
  private lastInteractionResponseAtMs = Number.NEGATIVE_INFINITY;
  private recentClickTimes: number[] = [];
  private clickBurstUpgraded = false;
  private playfulUpgradeEligible = false;
  private settledClickUntilMs = Number.NEGATIVE_INFINITY;
  private pendingPlayfulResponse = false;
  private nextHelloIsBlink = false;
  private armedClickContext: ClickContext | undefined;
  private reducedMotion = false;
  private parachuteRevision = 0;
  private parachuteViewportRequested = false;
  private parachuteViewportOperation = 0;
  private parachuteCollapseOperation: number | undefined;
  private parachuteCloseTimer: unknown | undefined;
  private parachuteLandingPending = false;
  private readonly motionCoordinator: MotionCoordinator | undefined;
  private readonly productStateMachine = new ProductStateMachine();
  private motionLease: MotionLease | undefined;
  private authoritativeWindowTopLeft: WindowTopLeftLogical | undefined;
  private currentWorkArea: LogicalWorkArea | undefined;
  private currentWindowScaleFactor: number | undefined;
  private homeCycle: HomeCycle | undefined;
  private homeSurface: HomeSurfaceRect | null = null;
  private homeGeometryKey = "";
  private lastHomeSnapshotRevision = -1;
  private blinkTimer: unknown | undefined;
  private autonomousTimer: unknown | undefined;
  private walkTimer: unknown | undefined;
  private fallTimer: unknown | undefined;
  private lookExitTimer: unknown | undefined;
  private behaviorRevision = 0;
  private activeWalk: ActiveWalk | undefined;
  private activeTurn: ActiveTurn | undefined;
  private activeFall: ActiveFall | undefined;
  private fallWorkAreaRefreshInFlight = false;
  private pointerGestureRevision = 0;
  private clickCancellationRevision = 0;
  private armedClickCancellationRevision = 0;
  private endingGesture: { gestureRevision: number; interaction: PointerInteractionState; revision: number; promise: Promise<boolean> } | undefined;
  private armedPreservedBehavior: PetBehaviorState | undefined;
  private happyCompletionPending = false;
  private landCompletionPending = false;
  private inputAvoidanceFact: FocusedInputFact | undefined;
  private inputAvoidanceSafetyUnknown = false;
  private lastInputAvoidanceRevision = 0;
  private activeEscapePlan: ActiveEscapePlan | undefined;
  private avoidanceEvaluationRevision = 0;
  private avoidanceResyncInFlight: Promise<MotionSnapshot | null> | undefined;
  private nextEscapePlanId = 0;
  private blockedAvoidanceSignature: string | undefined;
  private readonly warnedFocusSessionIds = new Set<string>();
  private disposed = false;
  private currentState: PetRuntimeState = {
    readiness: "loading",
    behavior: "BOOTING",
    productStateGeneration: 0,
    animationLayer: "BASE",
    activeAnimationId: "idle",
    facing: "Right",
    visualTransition: "NONE",
    interaction: "NONE",
    isDragging: false,
    pointerNearby: false,
    parachutePhase: "NONE",
    parachuteProgress: 0,
  };

  constructor(
    private readonly resources: DefaultRuntimeResources,
    options: PetRuntimeOptions = {},
  ) {
    this.clock = options.clock ?? systemTimelineClock;
    this.timeline = new AnimationTimeline(this.clock);
    this.random = options.random ?? Math.random;
    this.homeRandom = options.homeRandom ?? Math.random;
    this.onFrame = options.onFrame ?? (() => undefined);
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.onDiagnostic = options.onDiagnostic;
    this.onInputAvoidanceWarning =
      options.onInputAvoidanceWarning ?? (() => undefined);
    this.motionPort = options.motionPort;
    this.setParachuteExpanded = options.setParachuteExpanded;
    this.onMotionSnapshotAccepted = options.onMotionSnapshotAccepted;
    this.onInteractionResponse = options.onInteractionResponse;
    this.onInteractionAcknowledged = options.onInteractionAcknowledged;
    this.motionCoordinator = this.motionPort
      ? new MotionCoordinator(
          async (command) => {
            await this.motionPort!.writeWindowTopLeft(command.windowTopLeft);
            if (!this.disposed && command.epoch === this.motionLease?.epoch) {
              this.confirmedMotion = { epoch: command.epoch, position: command.windowTopLeft };
              this.confirmHomeWalkArrival();
              this.confirmParachuteLanding();
              this.scheduleDiagnostic();
            }
          },
          (rejection) => this.handleMotionRejection(rejection),
        )
      : undefined;
  }

  get state(): Readonly<PetRuntimeState> {
    return {
      ...this.currentState,
      logicalPosition: this.currentState.logicalPosition
        ? { ...this.currentState.logicalPosition }
        : undefined,
      pointerLogicalPosition: this.currentState.pointerLogicalPosition
        ? { ...this.currentState.pointerLogicalPosition }
        : undefined,
    };
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) {
      this.pendingPlayfulResponse = false;
      this.playfulUpgradeEligible = false;
    }
    const fall = this.activeFall;
    if (reduced && fall?.parachute) {
      // Freeze at the displayed x; returning to the original sway center would
      // jump sideways. A later preference change takes effect next release.
      fall.parachute.baseX = fall.position.x;
      fall.parachute.swaySuppressed = true;
    }
  }

  get canRestorePosition(): boolean {
    return !this.disposed && this.currentState.readiness === "ready" &&
      this.currentState.restoreStatus !== "busy" &&
      this.currentState.interaction === "NONE" && !this.currentState.isDragging &&
      this.currentState.visualTransition === "NONE" &&
      ["IDLE", "LOOK", "REST"].includes(this.currentState.behavior) &&
      (!this.homeCycle?.stage || ["AWAKE", "SLEEP"].includes(this.homeCycle.stage));
  }

  get diagnosticState(): PetRuntimeDiagnostic {
    const state = this.currentState;
    const cycle = this.homeCycle;
    const stage = cycle?.stage ?? "NONE";
    const inputBlocked = this.blockedAvoidanceSignature !== undefined ||
      (!this.inputAvoidanceSafetyUnknown && this.homeMovementBlocked());
    let reason: PetRuntimeDiagnostic["wait_reason"] = "none";
    if (state.readiness !== "ready") reason = state.readiness === "failed" ? "runtime_failed" : "initializing";
    else if (state.restoreStatus === "busy") reason = "restoring";
    else if (state.restoreStatus === "failed") reason = "restore_failed";
    else if (state.interaction !== "NONE" || state.isDragging || state.behavior === "HAPPY") reason = "interaction";
    else if (state.behavior === "LOOK") reason = "pointer_nearby";
    else if (stage === "AWAKE" && cycle) {
      const now = this.clock.now();
      const confirmed = this.confirmedMotion;
      if (cycle.awakeStartedAtMs !== undefined && now < cycle.awakeStartedAtMs + HOME_AWAKE_DURATION_MS) reason = "home_awake_window";
      else if (this.motionPort && (!confirmed || confirmed.epoch !== this.motionLease?.epoch ||
        !positionsMatch(confirmed.position.x, cycle.position.x) || !positionsMatch(confirmed.position.y, cycle.position.y))) reason = "home_motion_unconfirmed";
      else if (now < (cycle.quietUntilMs ?? 0)) reason = "home_quiet_window";
      else reason = "home_action_finishing";
    } else if (stage === "HOME_IDLE") reason = "home_action_finishing";
    else if (stage === "SLEEP") reason = state.autonomyPaused ? "user_paused" : "home_sleep";
    else if (stage === "WAKE_HOLD" || stage === "APPROACH" || (stage === "NONE" && state.behavior === "IDLE")) {
      if (state.autonomyPaused) reason = "user_paused";
      else if (this.inputAvoidanceSafetyUnknown) reason = "input_unknown";
      else if (inputBlocked) reason = "input_blocked";
      else if (stage === "WAKE_HOLD") reason = "home_wake_hold";
      else if (stage === "NONE") reason = "autonomous_interval";
    }
    return { state: state.behavior, home_stage: stage, wait_reason: reason,
      paused: !!state.autonomyPaused, home_pending: !!state.homePending,
      input_unknown: this.inputAvoidanceSafetyUnknown, input_blocked: inputBlocked };
  }

  private scheduleDiagnostic(): void {
    if (!this.onDiagnostic || this.disposed || this.diagnosticQueued) return;
    this.diagnosticQueued = true;
    // State broadcasts can precede the private fact/stage update. Observe only
    // after this synchronous policy operation has finished; add no polling timer.
    queueMicrotask(() => {
      this.diagnosticQueued = false;
      if (this.disposed) return;
      const diagnostic = this.diagnosticState;
      const signature = JSON.stringify(diagnostic);
      if (signature === this.diagnosticSignature) return;
      this.diagnosticSignature = signature;
      try { this.onDiagnostic?.(diagnostic); } catch { /* Diagnostics cannot interrupt behavior. */ }
    });
  }

  get canShowIdleBubble(): boolean {
    return !this.disposed && this.currentState.readiness === "ready" &&
      !this.currentState.autonomyPaused && this.currentState.restoreStatus !== "busy" && this.currentState.restoreStatus !== "failed" &&
      !this.currentState.pointerNearby && this.currentState.interaction === "NONE" &&
      this.currentState.visualTransition === "NONE" &&
      (this.currentState.behavior === "IDLE" ||
        (this.currentState.behavior === "REST" && this.homeCycle?.stage === "AWAKE"));
  }

  setAutonomyPaused(paused: boolean): void {
    if (this.disposed || this.currentState.readiness !== "ready" ||
        this.currentState.restoreStatus === "busy" || !!this.currentState.autonomyPaused === paused) return;
    this.updateState({ autonomyPaused: paused });
    const cycle = this.homeCycle;
    if (paused) {
      this.cancelInputEscapeMovement(true);
      this.avoidanceResyncInFlight = undefined;
      this.blockedAvoidanceSignature = undefined;
      this.clearAutonomousTimer();
      if (this.currentState.behavior === "IDLE" && !this.interactionResponse) {
        // A pending resync must stay obsolete even after a quick resume.
        this.behaviorRevision += 1;
        this.clearBlinkTimer();
        this.scheduleBlink();
      }
      if (cycle?.stage === "SLEEP") {
        cycle.pausedSleepRemainingMs = Math.max(0, (cycle.restDeadlineMs ?? this.clock.now()) - this.clock.now());
        cycle.restDeadlineMs = undefined;
        this.clearHomeCycleTimer();
        this.publishHomeCycleState();
      } else if (cycle?.stage === "APPROACH" || cycle?.stage === "WAKE_HOLD") {
        this.clearHomeCycleTimer();
        if (cycle.stage === "APPROACH") {
          cycle.revision += 1;
          this.timeline.stop();
          this.updateState({ visualTransition: "NONE", turnTargetFacing: undefined, turnFrameMirrored: undefined });
          this.showStationaryFrame();
          this.acquireMotion("AUTONOMOUS", cycle.position);
        }
      } else if (this.currentState.behavior === "WALK" || this.currentState.visualTransition === "TURN") {
        this.stopForDirectInteraction();
        this.resumeIdleBehavior();
      }
    } else if (cycle?.stage === "SLEEP" && cycle.pausedSleepRemainingMs !== undefined) {
      cycle.restDeadlineMs = this.clock.now() + cycle.pausedSleepRemainingMs;
      cycle.pausedSleepRemainingMs = undefined;
      this.publishHomeCycleState();
      this.scheduleHomeRestDeadline();
    } else if (cycle?.stage === "WAKE_HOLD") {
      this.scheduleHomeCyclePhase(HOME_WAKE_HOLD_MS, "REST", () => this.beginHomeLeaveJump());
    } else if (cycle?.stage === "APPROACH") {
      cycle.lastStepAtMs = this.clock.now();
      if (this.currentState.homePending) this.resumeHomeCycle();
      const facing = cycle.entryPoint.x >= cycle.position.x ? "Right" : "Left";
      if (this.currentState.facing !== facing) this.playHomeApproachTurn(facing);
      else this.playHomeApproachWalk();
    } else {
      this.scheduleIdleInterval();
    }
    if (!paused) this.scheduleInputAvoidanceEvaluation();
  }

  private showStationaryFrame(): void {
    const frame = this.resources.idle.frames[0];
    this.updateState({ activeAnimationId: this.resources.idle.animationId, animationLayer: "BASE" });
    if (frame) this.deliverFrame({ animationId: this.resources.idle.animationId, frameIndex: 0,
      frame, timestampMs: this.clock.now(), animationHitBox: this.resources.idle.hitBox });
  }

  /** The injected operation owns discrete native layout writes, never pet policy. */
  async restoreDefaultPosition(operation: () => Promise<MotionSnapshot>): Promise<boolean> {
    if (!this.canRestorePosition) return false;
    this.updateState({ restoreStatus: "busy" });
    this.behaviorRevision += 1;
    this.avoidanceEvaluationRevision += 1;
    this.resetActiveBehavior();
    this.clearHomeCycleTimer();
    this.homeCycle = undefined;
    this.motionLease = undefined;
    this.timeline.stop();
    this.updateState({ behavior: "IDLE", homePending: undefined, ...this.homeCycleStatePatch() });
    this.showStationaryFrame();
    await this.motionCoordinator?.quiesce();
    if (this.disposed) return false;
    try {
      const snapshot = await operation();
      if (this.disposed) return false;
      this.applyMotionSnapshot(snapshot);
      if (!this.homeCycle) this.initializeHomeCycle(snapshot);
      this.activeEscapePlan = undefined;
      this.blockedAvoidanceSignature = undefined;
      this.updateState({ restoreStatus: "idle", escapePlanId: undefined });
      this.acquireMotion("RECOVERY", snapshot.windowPosition);
      this.resumeIdleBehavior();
      return true;
    } catch {
      const snapshot = await this.motionPort?.resync().catch(() => null);
      if (this.disposed) return false;
      if (snapshot) this.applyMotionSnapshot(snapshot);
      this.updateState({ restoreStatus: "failed" });
      this.showStationaryFrame();
      this.scheduleBlink();
      return false;
    }
  }

  async initialize(loadImage: ImageLoader): Promise<void> {
    if (this.disposed || this.currentState.readiness === "ready") {
      return;
    }

    try {
      await preloadRuntimeFrames(this.resources, loadImage);
      if (this.disposed) {
        return;
      }

      this.updateState({ readiness: "ready" });
      const snapshot = await this.motionPort?.resync();
      if (this.disposed) {
        return;
      }

      if (snapshot) {
        this.applyMotionSnapshot(snapshot);
        this.acquireMotion("AUTONOMOUS", snapshot.windowPosition);
      }

      if (this.disposed) {
        return;
      }

      this.resumeIdleBehavior();
    } catch (error) {
      if (this.disposed) {
        return;
      }

      this.updateState({ readiness: "failed" });
      this.dispose();
      throw error;
    }
  }

  triggerBlink(): boolean {
    return this.playBlink(true);
  }

  private playBlink(allowDoubleBlink: boolean): boolean {
    if (
      this.disposed ||
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE" ||
      this.currentState.isDragging ||
      this.currentState.behavior !== "IDLE" ||
      this.currentState.visualTransition !== "NONE" ||
      this.currentState.animationLayer === "BLINK"
    ) {
      return false;
    }

    this.clearBlinkTimer();
    this.updateState({
      animationLayer: "BLINK",
      activeAnimationId: this.resources.blink.animationId,
    });
    this.timeline.play(this.resources.blink, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => {
        if (
          this.disposed ||
          this.currentState.animationLayer !== "BLINK" ||
          this.currentState.isDragging ||
          this.currentState.behavior !== "IDLE"
        ) {
          return;
        }

        if (allowDoubleBlink && shouldScheduleDoubleBlink(this.random)) {
          this.updateState({ animationLayer: "BASE" });
          this.playBlink(false);
          return;
        }

        this.playIdle();
        this.scheduleBlink();
      },
    });

    return true;
  }

  handleUserInteraction(): boolean {
    if (this.disposed) {
      return false;
    }

    if (
      this.currentState.behavior === "WALK" ||
      this.currentState.visualTransition === "TURN"
    ) {
      this.interruptAutonomousMovement();
      this.scheduleBlink();
      this.scheduleIdleInterval();
      return true;
    }

    if (
      this.currentState.animationLayer !== "BLINK" ||
      this.resources.blink.interruptPolicy !== "interruptible_by_user_interaction"
    ) {
      return false;
    }

    this.interruptAutonomousMovement();
    this.scheduleBlink();
    this.scheduleIdleInterval();
    return true;
  }

  beginDrag(): boolean {
    return (
      this.beginPointerGesture() && this.promotePointerGestureToDrag()
    );
  }

  async endDrag(): Promise<void> {
    await this.endPointerGesture({ triggerHappy: false });
  }

  /** Blur/hidden clears future click work without stealing FALL or an action's safe finish. */
  cancelPendingClickResponses(): void {
    this.clickCancellationRevision += 1;
    this.recentClickTimes = [];
    this.clickBurstUpgraded = false;
    this.playfulUpgradeEligible = false;
    this.pendingPlayfulResponse = false;
    if (this.interactionResponse) this.interactionResponse.closingPending = false;
    if (this.interactionPresentationVisible) {
      this.interactionPresentationVisible = false;
      this.onInteractionResponse?.(null);
    }
  }

  beginPointerGesture(): boolean {
    if (this.currentState.restoreStatus === "busy" || this.currentState.restoreStatus === "failed") return false;
    if (
      this.disposed ||
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE"
    ) {
      return false;
    }

    this.pointerGestureRevision += 1;
    this.armedClickCancellationRevision = this.clickCancellationRevision;
    const home = this.homeCycle;
    const homeMotion = home && ["JUMP", "LAND", "LEAVE_JUMP"].includes(home.stage ?? "");
    this.armedClickContext = this.currentState.behavior === "FALL" ||
      this.currentState.behavior === "LAND" || homeMotion ? undefined
      : home?.phase === "REST"
        ? home.stage === "SLEEP" || home.stage === "WAKE_HOLD" ? "wake" : "home"
        : this.currentState.behavior === "WALK" || this.currentState.visualTransition === "TURN" ||
          home?.stage === "APPROACH" ? "walk"
          : this.clock.now() <= this.settledClickUntilMs ? "settled" : "hello";
    this.cancelParachute();
    const preservesActiveBehavior =
      ((this.currentState.behavior === "IDLE" || this.currentState.behavior === "LOOK") &&
        this.currentState.visualTransition === "NONE") ||
      this.currentState.behavior === "HAPPY" ||
      this.currentState.behavior === "FALL" ||
      this.currentState.behavior === "LAND" || this.interactionResponse !== undefined ||
      home?.phase === "REST" || homeMotion;
    this.armedPreservedBehavior = preservesActiveBehavior ? this.currentState.behavior : undefined;

    if (!preservesActiveBehavior) {
      this.stopForDirectInteraction();
      if (this.homeCycle?.awakeStartedAtMs !== undefined) {
        // Arming a click keeps the dog at Home. A cancelled click must resume
        // REST directly rather than attempt an illegal IDLE -> REST transition.
        this.showHomeAwakeAnimation(this.resources.idle, true);
      } else {
        this.playIdle();
      }
    }

    this.updateState({
      interaction: "ARMED",
      isDragging: false,
    });
    return true;
  }

  canConfirmPointerClick(): boolean {
    return this.currentState.interaction === "ARMED" && this.armedClickContext !== undefined;
  }

  promotePointerGestureToDrag(): boolean {
    if (
      this.disposed ||
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "ARMED"
    ) {
      return false;
    }

    this.armedPreservedBehavior = undefined;
    this.armedClickContext = undefined;
    this.cancelInteractionResponse(true);
    this.stopForDirectInteraction();
    this.updateState({
      behavior: "DRAG",
      animationLayer: "BASE",
      activeAnimationId: this.resources.drag.animationId,
      interaction: "DRAG",
      isDragging: true,
      verticalVelocityLogicalPxPerSecond: undefined,
      groundTopY: undefined,
    });
    this.acquireMotion("DRAG", this.currentWindowTopLeft());
    // 固定现有完整首帧；素材姿态和桌面观感仍由用户验收。
    const stableDragFrame = this.resources.drag.frames[0];
    if (!stableDragFrame) {
      throw new Error("LineDog drag animation requires a stable first frame.");
    }
    this.deliverFrame({
      animationId: this.resources.drag.animationId,
      frameIndex: 0,
      frame: stableDragFrame,
      ...(this.resources.drag.hitBox === undefined
        ? {}
        : { animationHitBox: this.resources.drag.hitBox }),
      timestampMs: this.clock.now(),
    });
    return true;
  }

  movePointerDrag(
    position: LogicalPoint,
    currentMonitorId: string,
    workArea: MotionSnapshot["workArea"],
  ): boolean {
    if (this.disposed || this.currentState.interaction !== "DRAG") {
      return false;
    }

    const clampedPosition = clampWindowToWorkArea(position, workArea);
    if (this.homeCycle?.awakeStartedAtMs !== undefined &&
        !this.isHomeDragProjection(clampedPosition, currentMonitorId, workArea)) this.cancelHomeCycleForInteraction();
    this.currentWorkArea = cloneWorkArea(workArea);
    this.updateState({
      currentMonitorId,
      logicalPosition: clampedPosition,
    });
    this.requestMotion("DRAG", clampedPosition);
    return true;
  }

  endPointerGesture(options: {
    readonly triggerHappy: boolean;
    readonly isCurrent?: () => boolean;
  }): Promise<boolean> {
    const pending = this.endingGesture;
    if (pending && pending.gestureRevision === this.pointerGestureRevision && pending.interaction === this.currentState.interaction && pending.revision === this.behaviorRevision) {
      return pending.promise;
    }
    const interaction = this.currentState.interaction;
    const gestureRevision = this.pointerGestureRevision;
    const promise = this.completePointerGesture(options);
    const ending = { gestureRevision, interaction, revision: this.behaviorRevision, promise };
    this.endingGesture = ending;
    const clear = (): void => { if (this.endingGesture === ending) this.endingGesture = undefined; };
    void promise.then(clear, clear);
    return promise;
  }

  private async completePointerGesture(options: {
    readonly triggerHappy: boolean;
    readonly isCurrent?: () => boolean;
  }): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    const interaction = this.currentState.interaction;

    if (interaction === "NONE") {
      return false;
    }

    // Capture the start context before any async readback. A gesture that began
    // in the air or on LAND never becomes a play click when landing completes.
    const clickContext = this.armedClickContext;
    const clickCancellationRevision = this.armedClickCancellationRevision;

    const preservedBehavior =
      interaction === "ARMED" ? this.armedPreservedBehavior : undefined;
    const preservesActiveBehavior = preservedBehavior !== undefined;
    const releasesCaughtFall = preservedBehavior === "FALL";
    // A caught FALL is a new release even without crossing the drag threshold.
    // Retain its displayed pose, but invalidate the previous fall's async work.
    const interactionRevision = preservesActiveBehavior && !releasesCaughtFall
      ? this.behaviorRevision
      : this.behaviorRevision + 1;

    if (!preservesActiveBehavior || releasesCaughtFall) {
      this.behaviorRevision = interactionRevision;
    }

    if (!preservesActiveBehavior) {
      this.clearBehaviorTimers();
      this.activeWalk = undefined;
      this.activeFall = undefined;
    }

    // The pre-await reservation keeps an in-flight walk from moving the window
    // while we resync for the gesture end.
    if (interaction === "DRAG") {
      this.acquireMotion("FALL", this.currentWindowTopLeft());
    }

    // A stationary preserved click never moved the native window. Its release
    // can confirm immediately; caught falls and drags still require fresh geometry.
    const snapshot = preservesActiveBehavior && !releasesCaughtFall
      ? undefined
      : releasesCaughtFall
        ? await this.motionPort?.resync().catch(() => null)
        : await this.motionPort?.resync();
    const triggerHappy = options.triggerHappy &&
      clickCancellationRevision === this.clickCancellationRevision && options.isCurrent?.() !== false;

    if (
      this.disposed ||
      interactionRevision !== this.behaviorRevision ||
      this.currentState.interaction !== interaction
    ) {
      // A superseded gesture must not leave its reservation behind: the code
      // below never runs, so nobody would drive the reserved owner again.
      // 旧手势不得覆盖后续交互已取得的定位租约。
      return false;
    }

    if (interaction === "DRAG") {
      this.armedPreservedBehavior = undefined;
      this.updateState({ interaction: "NONE", isDragging: false });

      if (snapshot) {
        const cycle = this.homeCycle;
        if (cycle?.awakeStartedAtMs !== undefined &&
            this.isHomeDragProjection(snapshot.windowPosition, snapshot.currentMonitorId, snapshot.workArea)) {
          cycle.quietUntilMs = this.clock.now() + HOME_INTERACTION_QUIET_MS;
          this.startFall(snapshot, interactionRevision, true);
          return false;
        }
        this.cancelHomeCycleForInteraction();
        this.startFall(snapshot, interactionRevision, true);
        return false;
      }

      this.cancelHomeCycleForInteraction();
      this.resumeIdleBehavior();
      return false;
    }

    if (preservesActiveBehavior) {
      if (releasesCaughtFall && (!snapshot ||
          (snapshot.snapshotRevision !== undefined && snapshot.snapshotRevision < this.lastHomeSnapshotRevision))) {
        // A failed/obsolete geometry read is not permission to move from the
        // old fall coordinates. Unlock input and leave the existing restore
        // action available without issuing a guessed recovery position.
        this.avoidanceEvaluationRevision += 1;
        this.resetActiveBehavior();
        this.clearHomeCycleTimer();
        this.homeCycle = undefined;
        this.motionLease = undefined;
        this.armedPreservedBehavior = undefined;
        this.timeline.stop();
        this.updateState({ behavior: "IDLE", restoreStatus: "failed", interaction: "NONE", isDragging: false,
          verticalVelocityLogicalPxPerSecond: undefined, groundTopY: undefined,
          homePending: undefined, ...this.homeCycleStatePatch() });
        this.showStationaryFrame();
        await this.motionCoordinator?.quiesce();
        return false;
      }

      if (this.activeFall) {
        this.activeFall.revision = interactionRevision;
        this.activeFall.lastStepAtMs = this.clock.now();
        this.activeFall.nextWorkAreaRefreshAtMs =
          this.clock.now() + FALL_WORK_AREA_REFRESH_INTERVAL_MS;
      }

      if (snapshot && this.currentState.behavior === "FALL") {
        this.applyFallSnapshot(snapshot, interactionRevision);
      }

      this.updateState({ interaction: "NONE", isDragging: false });
      this.armedPreservedBehavior = undefined;
      this.armedClickContext = undefined;

      if (clickContext && triggerHappy) {
        const accepted = this.acceptInteractionClick(clickContext);
        if (this.interactionResponse?.completionPending) this.finishInteractionResponse(this.interactionResponse);
        // HAPPY and its internal LAND use their own deferred completion flag.
        // Drain it before retaining an active response, otherwise its stopped
        // timeline can never retire the response or reopen the cooldown window.
        if (this.currentState.behavior === "HAPPY" && this.happyCompletionPending) {
          this.finishHappy(interactionRevision);
        }
        if (accepted || this.interactionResponse) return accepted;
      } else if (!triggerHappy) {
        const hadResponse = this.interactionResponse !== undefined;
        this.cancelInteractionResponse(true, this.currentState.behavior === "HAPPY");
        if (preservedBehavior !== "FALL" && preservedBehavior !== "LAND" &&
            preservedBehavior !== "HAPPY" &&
            !["GO_HOME", "LEAVE_HOME"].includes(preservedBehavior)) {
          if (hadResponse) {
            this.timeline.stop();
            if (this.homeCycle?.phase === "REST") this.resumePreservedHome();
            else this.resumeIdleBehavior();
            return false;
          }
        }
      }

      if (this.currentState.behavior === "FALL") {
        const fall = this.activeFall;
        if (releasesCaughtFall && fall) {
          // Re-evaluate the actual remaining drop after applying the confirmed
          // snapshot (including Home). Keep spriteHeldForParachute so a high
          // re-release never flashes a restarted FALL frame under the canopy.
          fall.parachute = this.createFallParachute(fall.position, fall.workArea);
          this.tryOpenParachute(fall);
        }
        this.clearFallTimer();
        this.scheduleFallTick(interactionRevision);
      } else if (
        this.currentState.behavior === "LAND" &&
        this.landCompletionPending
      ) {
        this.finishLand(interactionRevision);
      } else if (
        this.currentState.behavior === "HAPPY" &&
        this.happyCompletionPending
      ) {
        this.finishHappy(interactionRevision);
      } else if (this.homeCycle?.phase === "REST") {
        this.resumePreservedHome();
      } else if (this.homeCycle?.stage === "LAND" && this.landCompletionPending) {
        this.landCompletionPending = false;
        this.beginHomeIdle();
      } else if (["JUMP", "LEAVE_JUMP"].includes(this.homeCycle?.stage ?? "")) {
        this.scheduleHomeCycleTick();
      } else if (this.currentState.behavior === "IDLE") {
        // A rejected click is observational: keep its frame and existing deadlines.
        // Only rearm timers that actually expired while the pointer was held.
        if (this.blinkTimer === undefined) this.scheduleBlink();
        if (this.autonomousTimer === undefined) this.scheduleIdleInterval();
      } else if (this.currentState.behavior === "LOOK" && !this.currentState.pointerNearby) {
        this.scheduleLookExit();
      }

      return false;
    }

    if (snapshot) {
      if (this.homeCycle?.awakeStartedAtMs !== undefined &&
          !this.isHomeDragProjection(snapshot.windowPosition, snapshot.currentMonitorId, snapshot.workArea)) {
        this.cancelHomeCycleForInteraction();
        this.updateState({ interaction: "NONE", isDragging: false });
        this.startFall(snapshot, interactionRevision);
        return false;
      }
      this.applyMotionSnapshot(snapshot);
    }
    if (this.homeCycle?.awakeStartedAtMs !== undefined) {
      this.homeCycle.quietUntilMs = this.clock.now() + HOME_INTERACTION_QUIET_MS;
    }

    this.updateState({ interaction: "NONE", isDragging: false });
    this.armedPreservedBehavior = undefined;
    this.armedClickContext = undefined;

    if (interaction === "ARMED" && triggerHappy && clickContext &&
        this.acceptInteractionClick(clickContext)) {
      return true;
    }

    if (!triggerHappy) this.cancelInteractionResponse(true);

    this.resumeIdleBehavior();
    return false;
  }

  handlePointerSample(point: LogicalPoint): void {
    if (this.currentState.restoreStatus === "busy" || this.currentState.restoreStatus === "failed") return;
    if (this.disposed) {
      return;
    }

    const wasPointerNearby = this.currentState.pointerNearby;
    const distance = distanceFromPetCenter(point);
    const pointerNearby =
      distance <= PET_BEHAVIOR_CONFIG.look.enterRadiusLogicalPx
        ? true
        : distance >= PET_BEHAVIOR_CONFIG.look.exitRadiusLogicalPx
          ? false
          : this.currentState.pointerNearby;

    this.updateState({
      pointerNearby,
      pointerLogicalPosition: { ...point },
    });

    if (
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE" ||
      this.interactionResponse !== undefined ||
      this.currentState.behavior === "HAPPY" ||
      this.currentState.behavior === "DRAG"
    ) {
      return;
    }

    const home = this.homeCycle;
    if (home?.phase === "REST") {
      if (home.stage === "AWAKE" && home.awakeStartedAtMs !== undefined &&
          !home.interactionPose &&
          this.clock.now() < home.awakeStartedAtMs + HOME_AWAKE_DURATION_MS &&
          !wasPointerNearby && pointerNearby && home.awakeAction !== "LOOK") {
        home.awakeAction = "LOOK";
        home.awakeActionEndsAtMs = this.clock.now() + 1000;
        this.updateState({ facing: point.x < RUNTIME_VIEWPORT_SIZE / 2 ? "Left" : "Right" });
        this.showHomeAwakeAnimation(this.resources.lookMouse);
        this.scheduleHomeAwakeTick();
      }
      return;
    }

    if (this.currentState.behavior === "LOOK") {
      if (distance >= PET_BEHAVIOR_CONFIG.look.exitRadiusLogicalPx) {
        this.scheduleLookExit();
      } else {
        this.clearLookExitTimer();
      }
      return;
    }

    if (
      (this.currentState.behavior === "IDLE" ||
        this.currentState.behavior === "WALK") &&
      distance <= PET_BEHAVIOR_CONFIG.look.enterRadiusLogicalPx
    ) {
      this.startLook(point);
    }
  }

  triggerHappy(): boolean {
    if (this.currentState.restoreStatus === "busy" || this.currentState.restoreStatus === "failed") return false;
    if (
      this.disposed ||
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE" ||
      this.currentState.behavior === "HAPPY" ||
      this.currentState.behavior === "FALL" ||
      this.currentState.behavior === "LAND"
    ) {
      return false;
    }

    if (this.homeCycle?.phase === "REST") {
      return this.startInteractionResponse(this.homeCycle.stage === "SLEEP" ||
        this.homeCycle.stage === "WAKE_HOLD" ? "wake" : "home");
    }
    if (this.reducedMotion) return this.startInteractionResponse("gentle");

    this.stopForDirectInteraction();
    const revision = this.behaviorRevision;
    this.updateState({
      behavior: "HAPPY",
      animationLayer: "BASE",
      activeAnimationId: this.resources.happy.animationId,
    });
    const productState = this.captureProductStateTicket();
    this.timeline.play(this.resources.happy, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => {
        if (
          !this.isCurrentProductState(productState) ||
          revision !== this.behaviorRevision ||
          this.currentState.behavior !== "HAPPY" ||
          this.currentState.interaction === "DRAG"
        ) {
          return;
        }

        if (this.currentState.interaction === "ARMED") {
          this.happyCompletionPending = true;
          return;
        }

        this.finishHappy(revision);
      },
    });
    return true;
  }

  private acceptInteractionClick(context: ClickContext): boolean {
    if (this.disposed || this.currentState.interaction !== "NONE" ||
        ["DRAG", "FALL", "LAND"].includes(this.currentState.behavior)) return false;
    const accepted = this.tryAcceptInteractionClick(context);
    if (!accepted) {
      this.interactionPresentationVisible = true;
      this.onInteractionAcknowledged?.();
    }
    return accepted;
  }

  private tryAcceptInteractionClick(context: ClickContext): boolean {
    if (this.currentState.interaction !== "NONE" || this.currentState.behavior === "FALL" ||
        this.currentState.behavior === "LAND") return false;
    const now = this.clock.now();
    const previous = this.recentClickTimes.at(-1);
    // Cooldown belongs to the last accepted response, not the most recent tap.
    // Continuous tapping cannot keep the burst latch closed forever.
    const responseWindowElapsed = !this.interactionResponse &&
      now - this.lastInteractionResponseAtMs >= INTERACTION_RESPONSE_INTERVAL_MS;
    if (previous === undefined || now - previous > PLAYFUL_CLICK_WINDOW_MS || responseWindowElapsed) {
      this.recentClickTimes = [];
      this.clickBurstUpgraded = false;
      this.playfulUpgradeEligible = false;
    }
    this.recentClickTimes = this.recentClickTimes.filter(time => now - time <= PLAYFUL_CLICK_WINDOW_MS);
    this.recentClickTimes.push(now);
    if (this.recentClickTimes.length > 3) this.recentClickTimes.shift();

    if (context === "wake" && !this.interactionResponse) return this.startInteractionResponse("wake");
    if (context === "settled" && !this.interactionResponse) return this.startInteractionResponse("settled");
    if (context === "home" || context === "wake" || this.reducedMotion) {
      if (this.interactionResponse || now - this.lastInteractionResponseAtMs < INTERACTION_RESPONSE_INTERVAL_MS) return false;
      return this.startInteractionResponse(this.reducedMotion && context === "hello" ? "gentle" : context);
    }
    // A fourth release in the same burst qualifies a static closing phase.
    // Attach it to the accepted action, never to a timer extended by clicks.
    if (this.clickBurstUpgraded && this.interactionResponse &&
        (this.pendingPlayfulResponse || this.interactionResponse.event.kind === "playful")) {
      this.interactionResponse.closingPending = true;
    }
    if (this.recentClickTimes.length >= 3 && !this.clickBurstUpgraded && this.playfulUpgradeEligible) {
      this.clickBurstUpgraded = true;
      this.playfulUpgradeEligible = false;
      if (this.interactionResponse) {
        // One upgrade slot for the entire burst. Repeated clicks neither
        // restart frames nor extend this response or its one successor.
        if (this.interactionResponse.event.action !== "happy") this.pendingPlayfulResponse = true;
        return false;
      }
      if (this.currentState.behavior !== "HAPPY") return this.startInteractionResponse("playful");
    }
    if (this.interactionResponse || this.currentState.behavior === "HAPPY" ||
        this.clickBurstUpgraded || now - this.lastInteractionResponseAtMs < INTERACTION_RESPONSE_INTERVAL_MS) return false;
    return this.startInteractionResponse(context);
  }

  private startInteractionResponse(kind: PetInteractionResponse["kind"], closingPending = false): boolean {
    if (this.disposed || this.currentState.readiness !== "ready" || this.interactionResponse ||
        this.currentState.interaction !== "NONE" || ["DRAG", "FALL", "LAND"].includes(this.currentState.behavior)) return false;
    const atHome = this.homeCycle?.phase === "REST";
    const action: PetInteractionResponse["action"] = atHome ? kind === "wake" ? "wake" : "home"
      : this.reducedMotion || kind === "gentle" || kind === "cooldown" ? "still" : kind === "playful" ? "happy"
        : kind === "walk" || !this.nextHelloIsBlink ? "look" : "blink";
    if (action === "happy") {
      if (!this.triggerHappy()) return false;
    } else {
      this.stopForDirectInteraction();
      if (atHome && this.homeCycle) {
        this.homeCycle.interactionPose = true;
        this.showHomeAwakeAnimation(this.resources.homeIdle, true);
      } else if (action === "look") {
        this.updateState({ behavior: "LOOK", animationLayer: "BASE", activeAnimationId: this.resources.lookMouse.animationId });
        this.timeline.play(this.resources.lookMouse, { onFrame: event => this.deliverFrame(event), onComplete: () => undefined });
      } else if (action === "blink") {
        this.updateState({ behavior: "IDLE", animationLayer: "BLINK", activeAnimationId: this.resources.blink.animationId });
        this.timeline.play(this.resources.blink, { onFrame: event => this.deliverFrame(event), onComplete: () => undefined });
      } else {
        this.playIdle();
      }
    }
    if (kind === "hello") this.nextHelloIsBlink = !this.nextHelloIsBlink;
    this.playfulUpgradeEligible = !this.reducedMotion && !atHome &&
      (kind === "hello" || kind === "walk" || kind === "settled");
    this.settledClickUntilMs = Number.NEGATIVE_INFINITY;
    const happyDuration = this.resources.happy.frameDurationsMs.reduce((total, duration) => total + duration, 0) +
      (this.resources.happy.frames.at(-1)?.contactGeometry.kind === "AIRBORNE"
        ? this.resources.land.frameDurationsMs.reduce((total, duration) => total + duration, 0) : 0);
    const event: PetInteractionResponse = {
      id: ++this.nextInteractionResponseId,
      kind: atHome ? kind === "wake" ? "wake" : "home"
        : action === "still" && kind !== "settled" && kind !== "cooldown" ? "gentle" : kind,
      action, durationMs: atHome ? 2000 : action === "happy" ? Math.max(1500, happyDuration) : 1600,
    };
    const response: ActiveInteractionResponse = { event, revision: this.behaviorRevision,
      startedAtMs: this.clock.now(), completionPending: false, closingPending };
    this.interactionResponse = response;
    this.lastInteractionResponseAtMs = response.startedAtMs;
    this.interactionPresentationVisible = true;
    this.onInteractionResponse?.(event);
    if (this.interactionResponse !== response || this.disposed) return true;
    // HAPPY owns its complete animation and landing. The timer only holds
    // shorter gestures, and never cuts an airborne Happy pose short.
    if (action !== "happy") this.scheduleInteractionResponseEnd(response, event.durationMs);
    return true;
  }

  private scheduleInteractionResponseEnd(response: ActiveInteractionResponse, delayMs: number): void {
    const timer = this.clock.setTimeout(() => {
      if (this.interactionResponseTimer !== timer || this.interactionResponse !== response ||
          response.revision !== this.behaviorRevision || this.disposed) return;
      this.interactionResponseTimer = undefined;
      this.finishInteractionResponse(response);
    }, delayMs);
    this.interactionResponseTimer = timer;
  }

  private finishInteractionResponse(response: ActiveInteractionResponse): void {
    if (this.interactionResponse !== response || response.revision !== this.behaviorRevision || this.disposed) return;
    if (this.currentState.interaction === "ARMED") {
      response.completionPending = true;
      return;
    }
    if (this.currentState.interaction !== "NONE") return;
    const remaining = response.startedAtMs + response.event.durationMs - this.clock.now();
    if (remaining > 0) { this.scheduleInteractionResponseEnd(response, remaining); return; }
    this.interactionResponse = undefined;
    this.interactionResponseTimer = undefined;
    const playful = this.pendingPlayfulResponse;
    this.pendingPlayfulResponse = false;
    if (playful && !this.reducedMotion && !this.hasActiveHomeCycle()) {
      this.startInteractionResponse("playful", response.closingPending);
      return;
    }
    if (response.event.kind === "playful" && response.closingPending && !this.hasActiveHomeCycle()) {
      // HAPPY has completed its existing landing. One stationary finish is
      // bounded even when clicking continues, with no further queued action.
      this.startInteractionResponse("cooldown");
      return;
    }
    if (this.homeCycle?.awakeStartedAtMs !== undefined) {
      this.homeCycle.quietUntilMs = this.clock.now() + HOME_INTERACTION_QUIET_MS;
    }
    const pointer = this.currentState.pointerLogicalPosition;
    if (!this.hasActiveHomeCycle() && this.currentState.pointerNearby && pointer) {
      // A nearby pointer already owns LOOK. Do not insert a one-poll IDLE pose
      // or replay the same look frames when its greeting caption finishes.
      if (this.currentState.behavior !== "LOOK" ||
          this.currentState.activeAnimationId !== this.resources.lookMouse.animationId) this.startLook(pointer);
      return;
    }
    this.resumeIdleBehavior();
  }

  private cancelInteractionResponse(resetClicks = false, allowHappyToFinish = false): void {
    const hadResponse = this.interactionResponse !== undefined;
    if (this.interactionResponse) this.interactionResponse.closingPending = false;
    if (!allowHappyToFinish || this.interactionResponse?.event.action !== "happy") {
      if (this.interactionResponseTimer !== undefined) this.clock.clearTimeout(this.interactionResponseTimer);
      this.interactionResponseTimer = undefined;
      this.interactionResponse = undefined;
    }
    this.pendingPlayfulResponse = false;
    if (resetClicks) {
      this.recentClickTimes = [];
      this.clickBurstUpgraded = false;
      this.playfulUpgradeEligible = false;
    }
    if (this.interactionPresentationVisible && (hadResponse || resetClicks)) {
      this.interactionPresentationVisible = false;
      this.onInteractionResponse?.(null);
    }
  }

  private resumePreservedHome(): void {
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== "REST") return;
    if (cycle.stage === "AWAKE") {
      if (this.interactionResponse) return;
      this.resumeHomeAwake();
    } else if (cycle.stage === "SLEEP") this.scheduleHomeRestDeadline();
    else if (cycle.stage === "WAKE_HOLD") {
      this.scheduleHomeCyclePhase(HOME_WAKE_HOLD_MS, "REST", () => this.beginHomeLeaveJump());
    }
  }

  handleInputAvoidanceFact(fact: FocusedInputFact): void {
    if (this.currentState.restoreStatus === "busy" || this.currentState.restoreStatus === "failed") return;
    if (this.disposed) {
      return;
    }

    if (
      !Number.isSafeInteger(fact.revision) ||
      fact.revision <= this.lastInputAvoidanceRevision
    ) {
      return;
    }
    this.lastInputAvoidanceRevision = fact.revision;

    const previousSignature = this.inputAvoidanceFact
      ? avoidanceFactSignature(this.inputAvoidanceFact)
      : undefined;
    this.updateState({ inputAvoidanceFactRevision: fact.revision });

    if (!isActiveInputAvoidanceFact(fact)) {
      const wasUnknown = this.inputAvoidanceSafetyUnknown;
      const safetyUnknown = fact.kind !== "none" || fact.approximate;
      this.inputAvoidanceSafetyUnknown = safetyUnknown;
      this.inputAvoidanceFact = undefined;
      this.blockedAvoidanceSignature = undefined;
      this.cancelInputEscapeMovement(true);
      if (safetyUnknown) {
        this.pauseHomeCycleForAvoidance();
        return;
      }
      this.resumeHomeCycle();
      if (wasUnknown) this.scheduleIdleInterval();
      return;
    }

    this.inputAvoidanceSafetyUnknown = false;
    this.inputAvoidanceFact = fact;
    const nextSignature = avoidanceFactSignature(fact);
    if (previousSignature !== nextSignature) {
      this.blockedAvoidanceSignature = undefined;
    }
    if (this.hasActiveHomeCycle()) {
      if (this.homeMovementBlocked()) {
        this.pauseHomeCycleForAvoidance();
      } else {
        this.resumeHomeCycle();
      }
    }
    this.scheduleInputAvoidanceEvaluation();
  }

  /** Reuses coarse desktop sampling; never treats a default placement as a live window. */
  handleDesktopSnapshot(snapshot: MotionSnapshot): void {
    if (this.disposed || this.currentState.restoreStatus === "busy" || this.currentState.restoreStatus === "failed") return;
    const activeHome = this.hasActiveHomeCycle();
    if (!this.updateHomeGeometry(snapshot)) return;
    this.cancelParachute();
    if (this.currentState.behavior === "LAND" && this.currentState.interaction === "NONE") {
      // Rebase a completed/closing landing through the existing LAND path.
      // LAND cannot transition back to FALL, and a cancelled close must not
      // strand an animation completion that was waiting for the canopy.
      this.behaviorRevision += 1;
      this.onMotionSnapshotAccepted?.(snapshot);
      this.currentWindowScaleFactor = snapshot.windowScaleFactor;
      this.enterLand(snapshot.windowPosition, snapshot.currentMonitorId, snapshot.workArea, this.behaviorRevision);
      return;
    }
    if (this.activeFall && this.currentState.interaction === "NONE") {
      this.applyFallSnapshot(snapshot, this.activeFall.revision);
      return;
    }
    if (activeHome && this.currentState.interaction === "NONE") {
      this.cancelInteractionResponse(true);
      this.behaviorRevision += 1;
      this.startFall(snapshot, this.behaviorRevision);
    } else if (this.currentState.interaction === "NONE" &&
        (this.activeWalk || this.activeTurn) && !this.activeEscapePlan) {
      this.stopForDirectInteraction();
      this.resumeIdleBehavior();
    }
  }

  private updateHomeGeometry(snapshot: MotionSnapshot): boolean {
    if (snapshot.snapshotRevision !== undefined) {
      if (snapshot.snapshotRevision <= this.lastHomeSnapshotRevision) return false;
      this.lastHomeSnapshotRevision = snapshot.snapshotRevision;
    }
    const surface = resolveHomeSurface(snapshot);
    const key = JSON.stringify([snapshot.currentMonitorId, snapshot.windowScaleFactor, snapshot.workArea, surface]);
    if (key === this.homeGeometryKey) return false;
    const roundTripsTarget = this.homeCycle?.roundTripsTarget;
    this.homeGeometryKey = key;
    this.homeSurface = surface;
    this.clearHomeCycleTimer();
    this.homeCycle = undefined;
    this.updateState({ homePending: undefined, ...this.homeCycleStatePatch() });
    if (surface) this.initializeHomeCycle(snapshot, roundTripsTarget);
    return true;
  }

  async updateGroundWorkArea(workArea: LogicalWorkArea): Promise<boolean> {
    if (!isFiniteLogicalWorkArea(workArea) || !this.canRebaseGroundPosition()) {
      return false;
    }

    const ownedPosition = this.getGroundOwnedPosition();
    if (ownedPosition) {
      this.rebaseGroundPosition(workArea, ownedPosition);
      return true;
    }

    const snapshot = await this.motionPort?.resync();
    if (
      !snapshot ||
      !this.canRebaseGroundPosition() ||
      !isFiniteLogicalWorkArea(snapshot.workArea)
    ) {
      return false;
    }

    this.rebaseGroundPosition(workArea, {
      position: snapshot.windowPosition,
      currentMonitorId: snapshot.currentMonitorId,
    });
    return true;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.cancelInteractionResponse(true);
    this.cancelParachute();
    this.disposed = true;
    this.behaviorRevision += 1;
    this.avoidanceEvaluationRevision += 1;
    this.clearBlinkTimer();
    this.clearAutonomousTimer();
    this.clearWalkTimer();
    this.clearFallTimer();
    this.clearHomeCycleTimer();
    this.clearLookExitTimer();
    this.activeWalk = undefined;
    this.activeTurn = undefined;
    this.activeFall = undefined;
    this.armedPreservedBehavior = undefined;
    this.happyCompletionPending = false;
    this.landCompletionPending = false;
    this.inputAvoidanceFact = undefined;
    this.inputAvoidanceSafetyUnknown = false;
    this.activeEscapePlan = undefined;
    this.avoidanceResyncInFlight = undefined;
    this.blockedAvoidanceSignature = undefined;
    this.warnedFocusSessionIds.clear();
    this.timeline.stop();
    this.motionCoordinator?.dispose();
    this.motionPort?.dispose?.();
    this.motionLease = undefined;
    this.authoritativeWindowTopLeft = undefined;
    this.currentWorkArea = undefined;
    this.homeCycle = undefined;
  }

  /** The Runtime owns frame delivery so release logic observes the rendered frame. */
  private deliverFrame(event: TimelineFrameEvent): void {
    if (this.disposed) {
      return;
    }

    this.onFrame(event);
  }

  private initializeHomeCycle(snapshot: MotionSnapshot, roundTripsTarget?: number): void {
    const entryPoint = computeHomeEntryPoint(snapshot.workArea, this.homeSurface);
    const restPoint = computeHomeRestPoint(snapshot.workArea, this.homeSurface);
    if (!entryPoint || !restPoint) {
      return;
    }

    this.homeCycle = {
      revision: 1,
      roundTripsTarget: roundTripsTarget ?? sampleHomeRoundTrips(this.homeRandom),
      roundTripsCompleted: 0,
      route: computeHomeWalkRoute(snapshot.workArea, this.homeSurface),
      routeLeg: "LOCATE",
      entryPoint,
      restPoint,
      workArea: cloneWorkArea(snapshot.workArea),
      currentMonitorId: snapshot.currentMonitorId,
      position: { ...snapshot.windowPosition },
      lastStepAtMs: this.clock.now(),
    };
    this.publishHomeCycleState();
  }

  private beginHomeCycle(): boolean {
    if (this.currentState.autonomyPaused) return false;
    const cycle = this.homeCycle;
    if (
      !cycle ||
      cycle.phase !== undefined ||
      cycle.roundTripsCompleted < cycle.roundTripsTarget ||
      cycle.routeLeg !== "ENTRY" ||
      this.currentState.behavior !== "WALK" ||
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE" ||
      this.currentState.isDragging
    ) {
      return false;
    }

    const workArea = this.currentWorkArea ?? cycle.workArea;
    const entryPoint = computeHomeEntryPoint(workArea, this.homeSurface);
    const restPoint = computeHomeRestPoint(workArea, this.homeSurface);
    const confirmed = this.confirmedMotion;
    const currentPosition = confirmed?.position;
    if (!entryPoint || !restPoint || !currentPosition ||
        confirmed?.epoch !== this.motionLease?.epoch ||
        Math.abs(currentPosition.x - entryPoint.x) > HOME_APPROACH_DISTANCE_LOGICAL ||
        !positionsMatch(currentPosition.y, getGroundWindowTopY(workArea)) ||
        this.homePathBlocked(currentPosition, entryPoint)) {
      return false;
    }

    const position = clampToWorkArea(currentPosition, workArea);
    cycle.revision += 1;
    cycle.phase = "GO_HOME";
    cycle.stage = "APPROACH";
    cycle.restDeadlineMs = undefined;
    cycle.jumpStartedAtMs = undefined;
    cycle.jumpStart = undefined;
    cycle.entryPoint = entryPoint;
    cycle.restPoint = restPoint;
    cycle.workArea = cloneWorkArea(workArea);
    cycle.currentMonitorId = this.currentState.currentMonitorId ?? cycle.currentMonitorId;
    cycle.position = { ...position };
    cycle.lastStepAtMs = this.clock.now();

    this.resetActiveBehavior();
    this.timeline.stop();
    const targetFacing: Facing = entryPoint.x >= position.x ? "Right" : "Left";
    this.updateState({
      behavior: "GO_HOME",
      animationLayer: "BASE",
      activeAnimationId: this.resources.walk.animationId,
      visualTransition: "NONE",
      turnTargetFacing: undefined,
      turnFrameMirrored: undefined,
      currentMonitorId: cycle.currentMonitorId,
      logicalPosition: { ...position },
      homePending: undefined,
      ...this.homeCycleStatePatch(),
    });
    this.acquireMotion("AUTONOMOUS", position);
    if (this.currentState.facing !== targetFacing) {
      this.playHomeApproachTurn(targetFacing);
    } else {
      this.playHomeApproachWalk();
    }
    return true;
  }

  private playHomeApproachTurn(targetFacing: Facing): void {
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== "GO_HOME" || cycle.stage !== "APPROACH") {
      return;
    }
    const revision = cycle.revision;
    const productState = this.captureProductStateTicket();
    const midpointFrame = Math.floor(this.resources.turn.frames.length / 2);
    this.updateState({
      activeAnimationId: this.resources.turn.animationId,
      visualTransition: "TURN",
      turnTargetFacing: targetFacing,
      turnFrameMirrored: this.currentState.facing === "Left",
    });
    this.timeline.play(this.resources.turn, {
      onFrame: (event) => {
        if (event.frameIndex >= midpointFrame && this.currentState.facing !== targetFacing) {
          this.updateState({ facing: targetFacing });
        }
        this.deliverFrame(event);
      },
      onComplete: () => {
        if (
          this.homeCycle !== cycle ||
          cycle.revision !== revision ||
          cycle.stage !== "APPROACH" ||
          !this.isCurrentProductState(productState)
        ) {
          return;
        }
        this.updateState({
          facing: targetFacing,
          visualTransition: "NONE",
          turnTargetFacing: undefined,
          turnFrameMirrored: undefined,
        });
        this.playHomeApproachWalk();
      },
    });
  }

  private playHomeApproachWalk(): void {
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== "GO_HOME" || cycle.stage !== "APPROACH") {
      return;
    }
    cycle.lastStepAtMs = this.clock.now();
    this.updateState({
      activeAnimationId: this.resources.walk.animationId,
      visualTransition: "NONE",
      turnTargetFacing: undefined,
      turnFrameMirrored: undefined,
    });
    this.timeline.play(this.resources.walk, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => undefined,
    });
    this.scheduleHomeCycleTick();
  }

  private advanceHomeCycle(): void {
    const cycle = this.homeCycle;
    if (this.currentState.autonomyPaused && cycle?.stage === "APPROACH") return;
    if (
      !cycle ||
      (cycle.phase !== "GO_HOME" && cycle.phase !== "FADE_IN") ||
      (this.currentState.behavior !== "GO_HOME" &&
        this.currentState.behavior !== "LEAVE_HOME") ||
      this.currentState.interaction !== "NONE" ||
      this.currentState.isDragging
    ) {
      return;
    }

    if (this.currentState.homePending || this.homeMovementBlocked()) {
      this.pauseHomeCycleForAvoidance();
      return;
    }

    if (cycle.stage === "APPROACH") {

      const nowMs = this.clock.now();
      const elapsedMs = Math.max(0, nowMs - cycle.lastStepAtMs);
      const distance = cycle.entryPoint.x - cycle.position.x;
      const step = Math.min(
        Math.abs(distance),
        (HOME_CYCLE_SPEED_LOGICAL_PX_PER_SECOND * elapsedMs) / 1_000,
      );
      cycle.position = {
        x: cycle.position.x + Math.sign(distance) * step,
        y: cycle.position.y,
      };
      cycle.lastStepAtMs = nowMs;
      this.publishHomePosition(cycle);

      if (Math.abs(cycle.entryPoint.x - cycle.position.x) <= LOGICAL_EPSILON) {
        this.beginHomeJump();
        return;
      }
      this.scheduleHomeCycleTick();
      return;
    }

    if (cycle.stage === "JUMP" && cycle.jumpStart && cycle.jumpStartedAtMs !== undefined) {
      const elapsedMs = this.clock.now() - cycle.jumpStartedAtMs;
      // 看门狗：进度异常停滞时强制落地，绝不把狗留在半空。
      const progress = elapsedMs > HOME_JUMP_DURATION_MS + HOME_JUMP_WATCHDOG_MARGIN_MS
        ? 1
        : Math.min(1, Math.max(0, elapsedMs / HOME_JUMP_DURATION_MS));
      cycle.lastStepAtMs = this.clock.now();
      cycle.position = computeHomeJumpPoint(cycle.jumpStart, cycle.restPoint, progress);
      this.publishHomePosition(cycle);
      if (progress >= 1) {
        this.beginHomeLand();
        return;
      }
      this.scheduleHomeCycleTick();
      return;
    }

    if (
      cycle.stage === "LEAVE_JUMP" &&
      cycle.jumpStart &&
      cycle.jumpStartedAtMs !== undefined
    ) {
      const elapsedMs = this.clock.now() - cycle.jumpStartedAtMs;
      // 看门狗：同上，离窝跳跃同样不允许无限滞空。
      const progress = elapsedMs > HOME_JUMP_DURATION_MS + HOME_JUMP_WATCHDOG_MARGIN_MS
        ? 1
        : Math.min(1, Math.max(0, elapsedMs / HOME_JUMP_DURATION_MS));
      cycle.lastStepAtMs = this.clock.now();
      cycle.position = computeHomeJumpPoint(cycle.jumpStart, cycle.entryPoint, progress);
      this.publishHomePosition(cycle);
      if (progress >= 1) {
        this.finishHomeLeaveJump();
        return;
      }
      this.scheduleHomeCycleTick();
    }
  }

  private publishHomePosition(cycle: HomeCycle): void {
    this.updateState({
      currentMonitorId: cycle.currentMonitorId,
      logicalPosition: { ...cycle.position },
      ...this.homeCycleStatePatch(),
    });
    this.requestMotion("AUTONOMOUS", cycle.position);
  }

  private beginHomeJump(): void {
    if (this.currentState.autonomyPaused) return;
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== "GO_HOME" || cycle.stage !== "APPROACH") {
      return;
    }
    const distance = Math.hypot(
      cycle.restPoint.x - cycle.position.x,
      cycle.restPoint.y - cycle.position.y,
    );
    if (distance > HOME_JUMP_MAX_DISTANCE_LOGICAL) {
      this.cancelHomeCycleForInteraction();
      this.resumeIdleBehavior();
      return;
    }
    if (this.homePathBlocked(cycle.position, cycle.restPoint, true)) {
      this.pauseHomeCycleForAvoidance();
      return;
    }
    cycle.stage = "JUMP";
    cycle.jumpStart = { ...cycle.position };
    cycle.jumpStartedAtMs = this.clock.now();
    cycle.lastStepAtMs = cycle.jumpStartedAtMs;
    this.timeline.stop();
    this.updateState({ activeAnimationId: this.resources.jumpAir.animationId });
    this.timeline.play(this.resources.jumpAir, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => undefined,
    });
    this.scheduleHomeCycleTick();
  }

  private beginHomeLand(): void {
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== "GO_HOME" || cycle.stage !== "JUMP") {
      return;
    }
    this.clearHomeCycleTimer();
    cycle.stage = "LAND";
    cycle.position = { x: cycle.restPoint.x, y: cycle.restPoint.y };
    cycle.restDeadlineMs = undefined;
    this.publishHomePosition(cycle);
    this.timeline.stop();
    this.updateState({ activeAnimationId: this.resources.homeLand.animationId });
    const revision = cycle.revision;
    const productState = this.captureProductStateTicket();
    this.timeline.play(this.resources.homeLand, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => {
        if (
          this.homeCycle !== cycle ||
          cycle.revision !== revision ||
          cycle.stage !== "LAND" ||
          !this.isCurrentProductState(productState)
        ) {
          return;
        }
        this.beginHomeIdle();
      },
    });
  }

  private beginHomeIdle(): void {
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== "GO_HOME" || cycle.stage !== "LAND") {
      return;
    }
    if (this.currentState.interaction !== "NONE" || this.currentState.parachutePhase !== "NONE") {
      this.landCompletionPending = true;
      return;
    }
    const confirmed = this.confirmedMotion;
    if (this.motionPort && (!confirmed || confirmed.epoch !== this.motionLease?.epoch ||
        !positionsMatch(confirmed.position.x, cycle.position.x) || !positionsMatch(confirmed.position.y, cycle.position.y))) {
      this.scheduleHomeCyclePhase(20, "GO_HOME", () => this.beginHomeIdle());
      return;
    }
    cycle.phase = "REST";
    cycle.awakeStartedAtMs ??= this.clock.now();
    if (cycle.quietUntilMs !== undefined) cycle.quietUntilMs = Math.max(cycle.quietUntilMs,
      this.clock.now() + HOME_INTERACTION_QUIET_MS);
    this.resumeHomeAwake();
  }

  private beginHomeSleep(): void {
    const cycle = this.homeCycle;
    if (!cycle || cycle.stage !== "AWAKE" || this.currentState.interaction !== "NONE") return;
    this.clearHomeCycleTimer();
    cycle.stage = "HOME_IDLE";
    this.updateState({
      behavior: "REST",
      activeAnimationId: this.resources.homeIdle.animationId,
      ...this.homeCycleStatePatch(),
    });
    const revision = cycle.revision;
    const productState = this.captureProductStateTicket();
    this.timeline.play(this.resources.homeIdle, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => {
        if (
          this.homeCycle !== cycle ||
          cycle.revision !== revision ||
          cycle.stage !== "HOME_IDLE" ||
          !this.isCurrentProductState(productState)
        ) {
          return;
        }
        cycle.stage = "SLEEP";
        cycle.restDeadlineMs = this.clock.now() + sampleHomeRestDurationMsForRevision(cycle.revision);
        if (this.currentState.autonomyPaused) {
          cycle.pausedSleepRemainingMs = cycle.restDeadlineMs - this.clock.now();
          cycle.restDeadlineMs = undefined;
        }
        this.publishHomeCycleState();
        this.scheduleHomeRestDeadline();
        this.timeline.stop();
        this.updateState({ activeAnimationId: this.resources.sleep.animationId });
        const sleepFrame = this.resources.sleep.frames[0];
        if (sleepFrame) {
          this.deliverFrame({
            animationId: this.resources.sleep.animationId,
            frameIndex: 0,
            frame: sleepFrame,
            ...(this.resources.sleep.hitBox === undefined
              ? {}
              : { animationHitBox: this.resources.sleep.hitBox }),
            timestampMs: this.clock.now(),
          });
        }
      },
    });
  }

  private resumeHomeAwake(): void {
    const cycle = this.homeCycle;
    if (!cycle || cycle.awakeStartedAtMs === undefined || this.currentState.interaction !== "NONE") return;
    cycle.phase = "REST";
    cycle.stage = "AWAKE";
    cycle.pausedSleepRemainingMs = undefined;
    cycle.restDeadlineMs = undefined;
    cycle.awakeAction = "IDLE";
    cycle.awakeActionEndsAtMs = this.clock.now() + samplePauseDurationMs(this.random);
    this.showHomeAwakeAnimation(cycle.interactionPose ? this.resources.homeIdle : this.resources.idle, true);
    this.acquireMotion("AUTONOMOUS", cycle.position);
    this.scheduleHomeAwakeTick();
  }

  private showHomeAwakeAnimation(animation: DefaultRuntimeResources["idle"], stable = false): void {
    this.timeline.stop();
    this.updateState({ behavior: "REST", animationLayer: "BASE", activeAnimationId: animation.animationId,
      visualTransition: "NONE", verticalVelocityLogicalPxPerSecond: undefined,
      groundTopY: this.homeCycle?.restPoint.y, ...this.homeCycleStatePatch() });
    if (stable) {
      const frame = animation.frames[0];
      if (frame) this.deliverFrame({ animationId: animation.animationId, frameIndex: 0, frame,
        ...(animation.hitBox ? { animationHitBox: animation.hitBox } : {}), timestampMs: this.clock.now() });
    } else {
      this.timeline.play(animation, { onFrame: event => this.deliverFrame(event), onComplete: () => undefined });
    }
  }

  private scheduleHomeAwakeTick(): void {
    this.scheduleDiagnostic();
    const cycle = this.homeCycle;
    if (!cycle || cycle.stage !== "AWAKE" || this.currentState.behavior !== "REST" ||
        this.currentState.interaction !== "NONE") return;
    this.scheduleHomeCyclePhase(100, "REST", () => this.advanceHomeAwake());
  }

  private advanceHomeAwake(): void {
    const cycle = this.homeCycle;
    if (!cycle || cycle.stage !== "AWAKE" || this.currentState.behavior !== "REST" ||
        this.currentState.interaction !== "NONE" || cycle.awakeStartedAtMs === undefined) return;
    const now = this.clock.now();
    const previousAction = cycle.awakeAction;
    const due = now >= cycle.awakeStartedAtMs + HOME_AWAKE_DURATION_MS;
    const finished = now >= (cycle.awakeActionEndsAtMs ?? now);
    // 动作先收尾，静止光标不延长截止时间，也不在截止后继续选取活动。
    const confirmed = this.confirmedMotion;
    const settled = !this.motionPort || (confirmed !== undefined && confirmed.epoch === this.motionLease?.epoch &&
      positionsMatch(confirmed.position.x, cycle.position.x) &&
      positionsMatch(confirmed.position.y, cycle.position.y));
    if ((finished || cycle.awakeAction === "IDLE") && due && settled && now >= (cycle.quietUntilMs ?? 0)) {
      this.beginHomeSleep();
      return;
    }
    if (finished) {
      cycle.awakeAction = "IDLE";
      cycle.awakeActionEndsAtMs = now + samplePauseDurationMs(this.random);
      this.showHomeAwakeAnimation(cycle.interactionPose ? this.resources.homeIdle : this.resources.idle, true);
      if (!due && previousAction === "IDLE" && !cycle.interactionPose) {
        cycle.awakeAction = "BLINK";
        cycle.awakeActionEndsAtMs = now + this.resources.blink.frameDurationsMs.reduce((a, b) => a + b, 0);
        this.showHomeAwakeAnimation(this.resources.blink);
      }
    }
    this.scheduleHomeAwakeTick();
  }

  private isHomeDragProjection(position: LogicalPoint, monitor: string, area: LogicalWorkArea): boolean {
    const cycle = this.homeCycle;
    if (!cycle || monitor !== cycle.currentMonitorId || area.x !== cycle.workArea.x ||
        area.y !== cycle.workArea.y || area.width !== cycle.workArea.width || area.height !== cycle.workArea.height) return false;
    const surface = computeHomeLandingSurface(area, this.homeSurface);
    const x = position.x + HOME_CHARACTER_FOOT_CENTER_LOGICAL_X;
    return !!surface && Number.isFinite(position.y) && x >= surface.leftX && x <= surface.rightX &&
      position.y <= cycle.restPoint.y + 1;
  }

  private scheduleHomeRestDeadline(): void {
    if (this.currentState.autonomyPaused) return;
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== "REST" || cycle.restDeadlineMs === undefined) {
      return;
    }
    this.scheduleHomeCyclePhase(
      Math.max(0, cycle.restDeadlineMs - this.clock.now()),
      "REST",
      () => this.finishHomeRest(),
    );
  }

  private finishHomeRest(): void {
    if (this.currentState.autonomyPaused) return;
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== "REST" || cycle.stage !== "SLEEP" ||
        this.currentState.interaction !== "NONE") {
      return;
    }

    this.clearHomeCycleTimer();
    cycle.stage = "WAKE_HOLD";
    this.timeline.stop();
    this.updateState({ activeAnimationId: this.resources.homeIdle.animationId });
    const wakeFrame = this.resources.homeIdle.frames.at(-1);
    if (wakeFrame) {
      this.deliverFrame({
        animationId: this.resources.homeIdle.animationId,
        frameIndex: this.resources.homeIdle.frames.length - 1,
        frame: wakeFrame,
        ...(this.resources.homeIdle.hitBox === undefined
          ? {}
          : { animationHitBox: this.resources.homeIdle.hitBox }),
        timestampMs: this.clock.now(),
      });
    }
    this.scheduleHomeCyclePhase(HOME_WAKE_HOLD_MS, "REST", () =>
      this.beginHomeLeaveJump(),
    );
  }

  private beginHomeLeaveJump(): void {
    if (this.currentState.autonomyPaused) return;
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== "REST" || cycle.stage !== "WAKE_HOLD") {
      return;
    }

    this.clearHomeCycleTimer();
    const workArea = this.currentWorkArea ?? cycle.workArea;
    const entryPoint = computeHomeEntryPoint(workArea, this.homeSurface);
    const restPoint = computeHomeRestPoint(workArea, this.homeSurface);
    if (entryPoint && restPoint) {
      cycle.entryPoint = entryPoint;
      cycle.restPoint = restPoint;
      cycle.workArea = cloneWorkArea(workArea);
      cycle.currentMonitorId =
        this.currentState.currentMonitorId ?? cycle.currentMonitorId;
    }
    if (this.homePathBlocked(cycle.position, cycle.entryPoint, true)) {
      this.pauseHomeCycleForAvoidance();
      return;
    }
    cycle.phase = "FADE_IN";
    cycle.stage = "LEAVE_JUMP";
    cycle.jumpStart = { ...cycle.position };
    cycle.jumpStartedAtMs = this.clock.now();
    cycle.lastStepAtMs = cycle.jumpStartedAtMs;
    this.timeline.stop();
    this.updateState({
      behavior: "LEAVE_HOME",
      facing: "Left",
      activeAnimationId: this.resources.jumpAir.animationId,
      logicalPosition: { ...cycle.position },
      homePending: undefined,
      ...this.homeCycleStatePatch(),
    });
    this.timeline.play(this.resources.jumpAir, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => undefined,
    });
    this.acquireMotion("AUTONOMOUS", cycle.position);
    this.scheduleHomeCycleTick();
  }

  private finishHomeLeaveJump(): void {
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== "FADE_IN" || cycle.stage !== "LEAVE_JUMP") {
      return;
    }

    this.clearHomeCycleTimer();
    cycle.phase = undefined;
    cycle.stage = undefined;
    cycle.awakeStartedAtMs = undefined;
    cycle.quietUntilMs = undefined;
    cycle.restDeadlineMs = undefined;
    cycle.jumpStartedAtMs = undefined;
    cycle.jumpStart = undefined;
    cycle.revision += 1;
    this.resetHomeRoute(true);
    cycle.position = { x: cycle.entryPoint.x, y: cycle.entryPoint.y };
    this.publishHomePosition(cycle);
    this.updateState({
      behavior: "IDLE",
      animationLayer: "BASE",
      activeAnimationId: this.resources.idle.animationId,
      logicalPosition: { ...cycle.position },
      homePending: undefined,
      ...this.homeCycleStatePatch(),
    });
    this.playIdle();
    this.acquireMotion("AUTONOMOUS", cycle.position);
    this.scheduleBlink();
    this.scheduleIdleInterval();
  }

  private scheduleHomeCycleTick(): void {
    const cycle = this.homeCycle;
    if (!cycle || (cycle.phase !== "GO_HOME" && cycle.phase !== "FADE_IN")) {
      return;
    }

    this.clearHomeCycleTimer();
    const revision = cycle.revision;
    const productState = this.captureProductStateTicket();
    const timer = this.clock.setTimeout(() => {
      if (
        cycle.phaseTimer !== timer ||
        this.homeCycle !== cycle ||
        cycle.revision !== revision ||
        !this.isCurrentProductState(productState)
      ) {
        return;
      }
      cycle.phaseTimer = undefined;
      this.advanceHomeCycle();
    }, HOME_CYCLE_TICK_MS);
    cycle.phaseTimer = timer;
  }

  private scheduleHomeCyclePhase(
    delayMs: number,
    expectedPhase: HomeCyclePhase,
    callback: () => void,
  ): void {
    const cycle = this.homeCycle;
    if (!cycle || cycle.phase !== expectedPhase) {
      return;
    }

    this.clearHomeCycleTimer();
    const revision = cycle.revision;
    const productState = this.captureProductStateTicket();
    const timer = this.clock.setTimeout(() => {
      if (
        cycle.phaseTimer !== timer ||
        this.homeCycle !== cycle ||
        cycle.revision !== revision ||
        cycle.phase !== expectedPhase ||
        this.currentState.interaction !== "NONE" ||
        this.disposed ||
        !this.isCurrentProductState(productState)
      ) {
        return;
      }
      cycle.phaseTimer = undefined;
      callback();
    }, Math.max(0, delayMs));
    cycle.phaseTimer = timer;
  }

  private pauseHomeCycleForAvoidance(): void {
    const cycle = this.homeCycle;
    if (!cycle || this.currentState.homePending ||
        !["APPROACH", "JUMP", "LEAVE_JUMP", "WAKE_HOLD"].includes(cycle.stage ?? "")) {
      return;
    }
    // 已起飞的跳跃不允许暂停：半空冻结在视觉上就是"卡死"，且比飞完更糟。
    // 起跳前的包络预检（beginHomeJump / beginHomeLeaveJump）已经把过关。
    if (cycle.stage === "JUMP" || cycle.stage === "LEAVE_JUMP") {
      return;
    }
    this.clearHomeCycleTimer();
    // 跳跃保留最后已发布帧的时间，恢复时不累计尚未运动的墙钟时间。
    if (cycle.stage === "APPROACH") cycle.lastStepAtMs = this.clock.now();
    this.updateState({ homePending: true, ...this.homeCycleStatePatch() });
    if (cycle.stage !== "WAKE_HOLD") this.acquireMotion("AUTONOMOUS", cycle.position);
  }

  private resumeHomeCycle(): void {
    if (this.currentState.autonomyPaused) return;
    const cycle = this.homeCycle;
    if (
      !cycle ||
      !this.currentState.homePending ||
      this.currentState.interaction !== "NONE" ||
      this.currentState.isDragging ||
      this.homeMovementBlocked()
    ) {
      return;
    }
    if ((cycle.stage === "JUMP" || cycle.stage === "LEAVE_JUMP") &&
        cycle.jumpStartedAtMs !== undefined) {
      cycle.jumpStartedAtMs += this.clock.now() - cycle.lastStepAtMs;
    }
    cycle.lastStepAtMs = this.clock.now();
    this.updateState({ homePending: undefined, ...this.homeCycleStatePatch() });
    if (cycle.stage === "WAKE_HOLD") {
      this.beginHomeLeaveJump();
    } else {
      this.scheduleHomeCycleTick();
    }
  }

  private homeMovementBlocked(): boolean {
    const cycle = this.homeCycle;
    if (!cycle?.phase) return false;
    if (cycle.stage === "APPROACH") {
      return this.homePathBlocked(cycle.position, cycle.entryPoint) ||
        (positionsMatch(cycle.position.x, cycle.entryPoint.x) &&
          this.homePathBlocked(cycle.position, cycle.restPoint, true));
    }
    // 起飞后的跳跃视为已提交：预检通过即允许飞完，中途冻结绝不恢复性暂停。
    if (cycle.stage === "JUMP" || cycle.stage === "LEAVE_JUMP") {
      return false;
    }
    if (cycle.stage === "WAKE_HOLD") {
      return this.homePathBlocked(cycle.position, cycle.entryPoint, true);
    }
    return false;
  }

  private cancelHomeCycleForInteraction(): void {
    const cycle = this.homeCycle;
    if (
      !cycle ||
      (cycle.phase === undefined && !this.currentState.homePending)
    ) {
      return;
    }

    this.clearHomeCycleTimer();
    cycle.phase = undefined;
    cycle.stage = undefined;
    cycle.awakeStartedAtMs = undefined;
    cycle.quietUntilMs = undefined;
    cycle.restDeadlineMs = undefined;
    cycle.jumpStartedAtMs = undefined;
    cycle.jumpStart = undefined;
    cycle.revision += 1;
    this.resetHomeRoute();
    this.updateState({
      homePending: undefined,
      ...this.homeCycleStatePatch(),
    });
  }

  private homePathBlocked(
    position: LogicalPoint | undefined,
    target: WindowTopLeftLogical,
    jump = false,
  ): boolean {
    if (this.inputAvoidanceSafetyUnknown) {
      return true;
    }

    const fact = this.inputAvoidanceFact;
    if (!position || !fact || !isActiveInputAvoidanceFact(fact)) {
      return false;
    }

    if (jump) {
      const bounds = computeHomeJumpBounds(position, target);
      const region = fact.forbiddenRegion;
      return bounds.left < region.right && bounds.right > region.left &&
        bounds.top < region.bottom && bounds.bottom > region.top;
    }

    const expandedLeft = fact.forbiddenRegion.left - RUNTIME_VIEWPORT_SIZE;
    const expandedRight = fact.forbiddenRegion.right;
    const expandedTop = fact.forbiddenRegion.top - RUNTIME_VIEWPORT_SIZE;
    const expandedBottom = fact.forbiddenRegion.bottom;
    const groundY = position.y;
    const pathMinX = Math.min(position.x, target.x);
    const pathMaxX = Math.max(position.x, target.x);
    return (
      groundY > expandedTop &&
      groundY < expandedBottom &&
      pathMaxX > expandedLeft &&
      pathMinX < expandedRight
    );
  }

  private resetHomeRoute(resample = false, keepCompleted = false): void {
    const cycle = this.homeCycle;
    if (!cycle) return;
    if (resample) cycle.roundTripsTarget = sampleHomeRoundTrips(this.homeRandom);
    if (!keepCompleted) cycle.roundTripsCompleted = 0;
    cycle.route = computeHomeWalkRoute(cycle.workArea, this.homeSurface);
    cycle.routeLeg = "LOCATE";
    this.publishHomeCycleState();
  }

  private homeWalkTargetX(): number | undefined {
    const cycle = this.homeCycle;
    if (!cycle?.route || cycle.phase) return undefined;
    switch (cycle.routeLeg) {
      case "LOCATE": return cycle.route.nearX;
      case "OUT": return cycle.route.farX;
      case "BACK": return cycle.route.nearX;
      case "ENTRY": return cycle.entryPoint.x - HOME_APPROACH_DISTANCE_LOGICAL;
    }
  }

  private confirmHomeWalkArrival(): void {
    const walk = this.activeWalk;
    const cycle = this.homeCycle;
    const confirmed = this.confirmedMotion;
    const targetX = this.homeWalkTargetX();
    if (!walk || walk.inputEscape || !cycle || targetX === undefined ||
        !walk.homeArrivalPending || this.disposed ||
        walk.revision !== this.behaviorRevision ||
        walk.motionLease !== this.motionLease ||
        confirmed?.epoch !== walk.motionLease?.epoch || !confirmed ||
        this.currentState.behavior !== "WALK" ||
        this.currentState.interaction !== "NONE" ||
        !positionsMatch(confirmed.position.x, targetX) ||
        !positionsMatch(confirmed.position.y, getGroundWindowTopY(walk.workArea))) return;
    if (cycle.routeLeg === "ENTRY") {
      if (this.beginHomeCycle()) return;
    } else if (cycle.routeLeg === "LOCATE") {
      cycle.routeLeg = cycle.roundTripsCompleted >= cycle.roundTripsTarget ? "ENTRY" : "OUT";
    } else if (cycle.routeLeg === "OUT") {
      cycle.routeLeg = "BACK";
    } else {
      cycle.roundTripsCompleted += 1;
      cycle.routeLeg = cycle.roundTripsCompleted >= cycle.roundTripsTarget ? "ENTRY" : "OUT";
    }
    this.publishHomeCycleState();
    this.finishWalk(walk.revision);
  }

  private homeCycleStatePatch(): Partial<PetRuntimeState> {
    const cycle = this.homeCycle;
    return {
      homeCyclePhase: cycle?.phase,
      homeCycleRevision: cycle?.revision,
      homeRoundTripsTarget: cycle?.roundTripsTarget,
      homeRoundTripsCompleted: cycle?.roundTripsCompleted,
      homeWalkTargetX: this.homeWalkTargetX(),
      homeAwakeStartedAtMs: cycle?.awakeStartedAtMs,
      homeQuietUntilMs: cycle?.quietUntilMs,
      homeRestDeadlineMs: cycle?.restDeadlineMs,
    };
  }

  private publishHomeCycleState(): void {
    this.updateState({ ...this.homeCycleStatePatch() });
  }

  private clearHomeCycleTimer(): void {
    const timer = this.homeCycle?.phaseTimer;
    if (timer !== undefined) {
      this.clock.clearTimeout(timer);
      this.homeCycle!.phaseTimer = undefined;
    }
  }

  private hasActiveHomeCycle(): boolean {
    return this.homeCycle?.phase !== undefined;
  }

  private updateState(update: Partial<PetRuntimeState>): void {
    if (this.disposed) {
      return;
    }

    this.scheduleDiagnostic();

    const requestedBehavior = update.behavior;
    if (requestedBehavior !== this.currentState.behavior &&
        (requestedBehavior === "DRAG" || requestedBehavior === "FALL" || requestedBehavior === "LAND")) {
      this.settledClickUntilMs = Number.NEGATIVE_INFINITY;
      this.cancelInteractionResponse(true);
    }
    if (requestedBehavior === "WALK") this.settledClickUntilMs = Number.NEGATIVE_INFINITY;
    if (
      requestedBehavior !== undefined &&
      requestedBehavior !== this.productStateMachine.state.type
    ) {
      const previous = this.productStateMachine.state;
      this.productStateMachine.transitionTo(requestedBehavior);
      this.handleProductStateExit(previous.type);
    }

    const next: PetRuntimeState = {
      ...this.currentState,
      ...update,
      behavior: this.productStateMachine.state.type,
      productStateGeneration: this.productStateMachine.state.generation,
    };

    // Pointer sampling and the walk tick call this ~30 times per second with
    // mostly unchanged values; broadcasting anyway would push every consumer
    // into a redundant DOM write on each call.
    if (sameRuntimeState(this.currentState, next)) {
      return;
    }

    this.currentState = next;
    this.onStateChange(this.state);
  }

  /**
   * Each product state owns its timer family. Leaving a state invalidates
   * that state's pending callback and clears the runtime's active motion lease
   * handle before the next state is projected. A next-state entry path must
   * acquire a fresh lease before it requests motion again.
   */
  private handleProductStateExit(state: ProductStateName): void {
    if (this.interactionResponse) this.cancelInteractionResponse(true);
    this.motionLease = undefined;
    switch (state) {
      case "BOOTING":
        return;
      case "IDLE":
        this.clearBlinkTimer();
        this.clearAutonomousTimer();
        return;
      case "WALK":
        this.clearWalkTimer();
        this.activeWalk = undefined;
        return;
      case "LOOK":
        this.clearLookExitTimer();
        return;
      case "HAPPY":
        this.happyCompletionPending = false;
        return;
      case "DRAG":
        return;
      case "FALL":
        this.clearFallTimer();
        this.activeFall = undefined;
        return;
      case "LAND":
        this.landCompletionPending = false;
        return;
      case "GO_HOME":
      case "REST":
      case "LEAVE_HOME":
        return;
      default:
        return assertNever(state);
    }
  }

  private captureProductStateTicket(): ProductStateTicket {
    const { type, generation } = this.productStateMachine.state;
    return { type, generation };
  }

  private isCurrentProductState(ticket: ProductStateTicket): boolean {
    return this.productStateMachine.isCurrent(ticket);
  }

  /**
   * A deferred callback is stale when either half of its ticket changed. The
   * product-state ticket covers FSM transitions; the revision covers Runtime
   * behavior restarts that leave the state name untouched.
   */
  private isStale(ticket: ProductStateTicket, revision: number): boolean {
    return (
      !this.isCurrentProductState(ticket) || revision !== this.behaviorRevision
    );
  }

  private currentWindowTopLeft(): LogicalPoint | undefined {
    if (this.authoritativeWindowTopLeft) {
      return {
        x: this.authoritativeWindowTopLeft.x,
        y: this.authoritativeWindowTopLeft.y,
      };
    }

    return this.currentState.logicalPosition
      ? { ...this.currentState.logicalPosition }
      : undefined;
  }

  /**
   * Every behavioral ownership transition enters through this one acquisition
   * point. The coordinator immediately schedules the supplied authoritative
   * top-left, so an owner never needs a pointer move before it has authority.
   *
   * Note the side effect: taking ownership as DRAG, FALL, INPUT_AVOIDANCE or
   * RECOVERY also discards the in-progress Home route, because those owners
   * move the pet somewhere the route no longer describes.
   */
  private acquireMotion(
    owner: MotionOwner,
    position: LogicalPoint | WindowTopLeftLogical | undefined,
  ): MotionLease | undefined {
    if (this.disposed || !this.motionCoordinator || !position) {
      return undefined;
    }

    const topLeft = asWindowTopLeftLogical(position);
    if (!topLeft) {
      return undefined;
    }
    if (owner === "DRAG" || owner === "FALL" || owner === "INPUT_AVOIDANCE" || owner === "RECOVERY") {
      this.resetHomeRoute(false, true);
    }

    this.authoritativeWindowTopLeft = topLeft;
    const lease = this.motionCoordinator.invalidateAndAcquire(owner, topLeft);
    this.motionLease = lease;
    this.updateState({ motionOwner: owner });
    return lease;
  }

  /** Sends a top-left update through the active lease, never directly native. */
  private requestMotion(owner: MotionOwner, position: LogicalPoint): void {
    if (this.disposed || !this.motionCoordinator) {
      return;
    }

    const topLeft = asWindowTopLeftLogical(position);
    if (!topLeft) {
      return;
    }

    if (!this.motionLease || this.motionLease.owner !== owner) {
      this.acquireMotion(owner, topLeft);
      return;
    }

    this.authoritativeWindowTopLeft = topLeft;
    this.motionCoordinator.request(this.motionLease, topLeft);
  }

  private requestMotionForCurrentOwner(position: LogicalPoint): void {
    if (this.motionLease) {
      this.requestMotion(this.motionLease.owner, position);
    } else {
      this.acquireMotion("AUTONOMOUS", position);
    }
  }

  /**
   * A failed current write cannot leave the failed owner active. We stop its
   * behavior timers and reassert only the last authoritative top-left under a
   * RECOVERY epoch. A failed RECOVERY write deliberately has no retry path.
   */
  private handleMotionRejection(rejection: MotionWriteRejection): void {
    if (this.disposed || !rejection.isCurrentEpoch) return;
    if (this.motionLease?.owner === "RECOVERY") {
      if (this.currentState.behavior === "LAND" && this.currentState.parachutePhase !== "NONE") {
        // A rejected landing is not evidence of ground contact. Stop at the
        // last accepted position and expose the existing restore action, rather
        // than waiting forever for confirmation or retrying RECOVERY in a loop.
        const position = this.confirmedMotion?.position;
        this.behaviorRevision += 1;
        this.resetActiveBehavior();
        this.clearHomeCycleTimer();
        this.homeCycle = undefined;
        this.timeline.stop();
        this.updateState({ behavior: "IDLE", restoreStatus: "failed", interaction: "NONE", isDragging: false,
          logicalPosition: position, verticalVelocityLogicalPxPerSecond: undefined, groundTopY: undefined,
          homePending: undefined, ...this.homeCycleStatePatch() });
        this.showStationaryFrame();
      }
      return;
    }

    const home = this.homeCycle;
    // A position-write failure is not a wake gesture. Preserve the current
    // resting phase, animation and deadlines while reasserting its same anchor.
    // RECOVERY failures still stop at the guard above; no retry loop is added.
    if (home?.phase === "REST" &&
        ["AWAKE", "HOME_IDLE", "SLEEP", "WAKE_HOLD"].includes(home.stage ?? "") &&
        this.currentState.behavior === "REST" &&
        this.currentState.interaction === "NONE" && !this.currentState.isDragging) {
      this.acquireMotion("RECOVERY", home.position);
      return;
    }
    const position = home?.awakeStartedAtMs !== undefined
      ? { ...home.position }
      : this.authoritativeWindowTopLeft ?? rejection.command.windowTopLeft;
    this.behaviorRevision += 1;
    this.avoidanceEvaluationRevision += 1;
    this.resetActiveBehavior();
    this.activeEscapePlan = undefined;
    this.armedPreservedBehavior = undefined;
    this.happyCompletionPending = false;
    this.landCompletionPending = false;
    this.fallWorkAreaRefreshInFlight = false;
    this.blockedAvoidanceSignature = undefined;
    if (home?.awakeStartedAtMs !== undefined) {
      this.clearHomeCycleTimer();
      home.revision += 1;
      home.stage = "AWAKE";
      home.restDeadlineMs = undefined;
      home.quietUntilMs = this.clock.now() + HOME_INTERACTION_QUIET_MS;
      this.timeline.stop();
      this.updateState({ behavior: "REST", interaction: "NONE", isDragging: false,
        homePending: undefined, logicalPosition: position });
      this.resumeHomeAwake();
      this.acquireMotion("RECOVERY", position);
      return;
    }
    this.cancelHomeCycleForInteraction();
    this.timeline.stop();
    this.updateState({
      behavior: "IDLE",
      animationLayer: "BASE",
      activeAnimationId: this.resources.idle.animationId,
      interaction: "NONE",
      isDragging: false,
      visualTransition: "NONE",
      turnTargetFacing: undefined,
      turnFrameMirrored: undefined,
      escapePlanId: undefined,
      logicalPosition: { x: position.x, y: position.y },
      verticalVelocityLogicalPxPerSecond: undefined,
      groundTopY: undefined,
    });
    this.acquireMotion("RECOVERY", position);
    // Without this the recovery epoch would leave no pending timer at all.
    this.resumeIdleBehavior();
  }

  private canRebaseGroundPosition(): boolean {
    return (
      !this.disposed &&
      this.currentState.readiness === "ready" &&
      this.currentState.interaction === "NONE" &&
      !this.currentState.isDragging &&
      !this.hasActiveHomeCycle() &&
      (this.currentState.behavior === "IDLE" ||
        this.currentState.behavior === "WALK" ||
        this.currentState.behavior === "LOOK" ||
        this.currentState.behavior === "HAPPY")
    );
  }

  private getGroundOwnedPosition():
    | Readonly<{ position: LogicalPoint; currentMonitorId?: string }>
    | undefined {
    if (this.activeWalk) {
      return {
        position: { ...this.activeWalk.position },
        currentMonitorId: this.currentState.currentMonitorId,
      };
    }

    if (this.activeTurn) {
      return {
        position: { ...this.activeTurn.pendingWalk.position },
        currentMonitorId: this.activeTurn.pendingWalk.currentMonitorId,
      };
    }

    if (this.currentState.logicalPosition) {
      return {
        position: { ...this.currentState.logicalPosition },
        currentMonitorId: this.currentState.currentMonitorId,
      };
    }

    return undefined;
  }

  private rebaseGroundPosition(
    workArea: LogicalWorkArea,
    owner: Readonly<{ position: LogicalPoint; currentMonitorId?: string }>,
  ): void {
    const nextWorkArea = cloneWorkArea(workArea);
    if (this.homeCycle) {
      const old = this.homeCycle.workArea;
      if (old.x !== workArea.x || old.y !== workArea.y || old.width !== workArea.width || old.height !== workArea.height) {
        // This caller has only WorkArea facts; wait for an actual Home readback.
        this.clearHomeCycleTimer();
        this.homeSurface = null;
        this.homeGeometryKey = "";
        this.homeCycle = undefined;
        this.publishHomeCycleState();
        if (this.activeWalk && !this.activeWalk.inputEscape) this.finishWalk(this.activeWalk.revision);
        if (this.activeTurn && !this.activeTurn.pendingWalk.inputEscape) {
          this.activeTurn = undefined;
          this.behaviorRevision += 1;
          this.resumeIdleBehavior();
        }
      }
    }
    this.currentWorkArea = cloneWorkArea(nextWorkArea);
    const position = clampToWorkArea(owner.position, nextWorkArea);

    if (this.activeWalk) {
      this.activeWalk.workArea = cloneWorkArea(nextWorkArea);
      this.activeWalk.position = { ...position };
    }

    if (this.activeTurn) {
      this.activeTurn.pendingWalk = {
        ...this.activeTurn.pendingWalk,
        workArea: cloneWorkArea(nextWorkArea),
        position: { ...position },
      };
    }

    if (this.activeEscapePlan) {
      this.updateActiveEscapeTarget(
        this.activeEscapePlan,
        clampWorkAreaX(this.activeEscapePlan.targetX, nextWorkArea),
      );
    }

    const inputAvoidanceFact = this.inputAvoidanceFact;
    if (inputAvoidanceFact && inputAvoidanceFact.kind !== "none") {
      this.inputAvoidanceFact = {
        ...inputAvoidanceFact,
        workArea: cloneWorkArea(nextWorkArea),
      };
      this.blockedAvoidanceSignature = undefined;
      this.scheduleInputAvoidanceEvaluation();
    }

    this.updateState({
      currentMonitorId: owner.currentMonitorId,
      logicalPosition: position,
    });
    this.requestMotionForCurrentOwner(position);
  }

  /**
   * Restores the idle behavior chain after any interruption. Every path that
   * clears the autonomous timers or stops the timeline must end with this
   * sequence: without it the runtime has no pending timer and the pet stays
   * frozen until the next user interaction.
   */
  private resumeIdleBehavior(): void {
    if (this.homeCycle?.awakeStartedAtMs !== undefined) {
      this.resumeHomeAwake();
      return;
    }
    this.playIdle();
    this.scheduleBlink();
    this.scheduleIdleInterval();
  }

  private playIdle(): void {
    if (this.disposed) {
      return;
    }

    this.updateState({
      behavior: "IDLE",
      animationLayer: "BASE",
      activeAnimationId: this.resources.idle.animationId,
      visualTransition: "NONE",
      turnTargetFacing: undefined,
      turnFrameMirrored: undefined,
      verticalVelocityLogicalPxPerSecond: undefined,
      groundTopY: undefined,
    });
    this.timeline.stop();
    const stableIdleFrame = this.resources.idle.frames[0];
    if (!stableIdleFrame) {
      throw new Error("LineDog idle animation requires a stable first frame.");
    }
    this.deliverFrame({
      animationId: this.resources.idle.animationId,
      frameIndex: 0,
      frame: stableIdleFrame,
      ...(this.resources.idle.hitBox === undefined
        ? {}
        : { animationHitBox: this.resources.idle.hitBox }),
      timestampMs: this.clock.now(),
    });
    this.scheduleInputAvoidanceEvaluation();
  }

  private finishHappy(revision: number): void {
    if (
      revision !== this.behaviorRevision ||
      this.currentState.behavior !== "HAPPY" ||
      this.currentState.interaction !== "NONE"
    ) {
      return;
    }

    this.happyCompletionPending = false;
    const finalHappyFrame = this.resources.happy.frames.at(-1);
    if (this.currentState.activeAnimationId === this.resources.happy.animationId &&
        finalHappyFrame?.contactGeometry.kind === "AIRBORNE") {
      this.updateState({ activeAnimationId: this.resources.land.animationId });
      const ticket = this.captureProductStateTicket();
      this.timeline.play(this.resources.land, {
        onFrame: (event) => this.deliverFrame(event),
        onComplete: () => {
          if (!this.isCurrentProductState(ticket) || revision !== this.behaviorRevision ||
              this.currentState.behavior !== "HAPPY") return;
          if (this.currentState.interaction === "ARMED") this.happyCompletionPending = true;
          else this.finishHappy(revision);
        },
      });
      return;
    }
    if (this.interactionResponse?.event.action === "happy") {
      this.finishInteractionResponse(this.interactionResponse);
      return;
    }
    if (this.homeCycle?.awakeStartedAtMs !== undefined) {
      this.homeCycle.quietUntilMs = this.clock.now() + HOME_INTERACTION_QUIET_MS;
      this.resumeHomeAwake();
      return;
    }
    const pointer = this.currentState.pointerLogicalPosition;
    if (this.currentState.pointerNearby && pointer) {
      this.startLook(pointer);
      return;
    }

    this.resumeIdleBehavior();
  }

  private scheduleBlink(): void {
    this.clearBlinkTimer();

    if (
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE" ||
      this.interactionResponse !== undefined ||
      this.currentState.isDragging ||
      this.currentState.behavior !== "IDLE" ||
      this.currentState.visualTransition !== "NONE" ||
      this.currentState.animationLayer !== "BASE"
    ) {
      return;
    }

    const productState = this.captureProductStateTicket();
    const revision = this.behaviorRevision;
    this.blinkTimer = this.clock.setTimeout(() => {
      this.blinkTimer = undefined;
      if (
        !this.isCurrentProductState(productState) ||
        revision !== this.behaviorRevision
      ) {
        return;
      }
      this.triggerBlink();
    }, sampleBlinkDelayMs(this.random));
  }

  private scheduleIdleInterval(): void {
    this.clearAutonomousTimer();

    if (!this.canScheduleAutonomousAction()) {
      return;
    }

    const productState = this.captureProductStateTicket();
    const revision = this.behaviorRevision;
    this.autonomousTimer = this.clock.setTimeout(() => {
      this.autonomousTimer = undefined;
      if (
        !this.isCurrentProductState(productState) ||
        revision !== this.behaviorRevision ||
        !this.canScheduleAutonomousAction()
      ) {
        return;
      }

      this.chooseNextAutonomousAction();
    }, sampleIdleDurationMs(this.random));
  }

  private chooseNextAutonomousAction(): void {
    if (!this.canScheduleAutonomousAction()) {
      return;
    }

    if (chooseAutonomousAction(this.random) === "PAUSE") {
      const productState = this.captureProductStateTicket();
      const revision = this.behaviorRevision;
      this.autonomousTimer = this.clock.setTimeout(() => {
        this.autonomousTimer = undefined;
        if (
          !this.isCurrentProductState(productState) ||
          revision !== this.behaviorRevision ||
          !this.canScheduleAutonomousAction()
        ) {
          return;
        }

        this.chooseNextAutonomousAction();
      }, samplePauseDurationMs(this.random));
      return;
    }

    const revision = this.behaviorRevision + 1;
    this.behaviorRevision = revision;
    const durationMs = sampleWalkDurationMs(this.random);
    const speedLogicalPxPerSecond = sampleWalkSpeedLogicalPxPerSecond(this.random);
    const facing = chooseFacing(this.random);
    const productState = this.captureProductStateTicket();
    void this.startWalk(
      revision,
      durationMs,
      speedLogicalPxPerSecond,
      facing,
      productState,
    );
  }

  private async startWalk(
    revision: number,
    durationMs: number,
    speedLogicalPxPerSecond: number,
    facing: Facing,
    productState: ProductStateTicket,
  ): Promise<void> {
    if (!this.motionPort) {
      if (
        this.isCurrentProductState(productState) &&
        revision === this.behaviorRevision
      ) {
        this.scheduleIdleInterval();
      }
      return;
    }

    const snapshot = await this.motionPort.resync();

    if (
      !snapshot ||
      !this.isCurrentProductState(productState) ||
      revision !== this.behaviorRevision ||
      !this.canScheduleAutonomousAction()
    ) {
      if (
        this.isCurrentProductState(productState) &&
        revision === this.behaviorRevision &&
        this.canScheduleAutonomousAction()
      ) {
        this.scheduleIdleInterval();
      }
      return;
    }

    const previous = this.currentWindowTopLeft();
    const coordinateContextChanged =
      this.currentState.currentMonitorId !== snapshot.currentMonitorId ||
      this.currentWindowScaleFactor !== snapshot.windowScaleFactor;
    // dpi 0.1.2 将 logical * scale 四舍五入到整数物理像素，负半值远离零。
    // 仅原生回读的外移判定允许半物理像素误差，不放宽路线端点确认。
    // A zero or non-finite scale factor would make the tolerance infinite and
    // silently disable the external-move check, so fall back to the strictest
    // comparison instead.
    const scaleFactor = snapshot.windowScaleFactor;
    const readbackTolerance =
      Number.isFinite(scaleFactor) && scaleFactor > 0
        ? 0.5 / scaleFactor + LOGICAL_EPSILON
        : LOGICAL_EPSILON;
    const externallyMoved = previous !== undefined && (
      Math.abs(previous.x - snapshot.windowPosition.x) > readbackTolerance ||
      Math.abs(previous.y - snapshot.windowPosition.y) > readbackTolerance
    );
    this.applyMotionSnapshot(snapshot);
    if (coordinateContextChanged || externallyMoved) {
      this.resetHomeRoute(false, true);
    }
    const initialPosition = clampToWorkArea(snapshot.windowPosition, snapshot.workArea);
    const targetX = this.homeWalkTargetX();
    if (targetX !== undefined) facing = targetX >= initialPosition.x ? "Right" : "Left";
    const pendingWalk: PendingWalk = {
      revision,
      durationMs,
      speedLogicalPxPerSecond,
      facing,
      currentMonitorId: snapshot.currentMonitorId,
      workArea: snapshot.workArea,
      position: initialPosition,
    };

    if (facing !== this.currentState.facing) {
      this.startTurn(pendingWalk);
      return;
    }

    this.startPreparedWalk(pendingWalk);
  }

  private startPreparedWalk(pendingWalk: PendingWalk): void {
    if (
      this.disposed ||
      pendingWalk.revision !== this.behaviorRevision ||
      this.currentState.interaction !== "NONE" ||
      this.currentState.isDragging ||
      (pendingWalk.inputEscape !== undefined &&
        pendingWalk.inputEscape.planId !== this.activeEscapePlan?.id)
    ) {
      return;
    }

    this.clearBlinkTimer();
    this.timeline.stop();
    const motionOwner: MotionOwner = pendingWalk.inputEscape
      ? "INPUT_AVOIDANCE"
      : "AUTONOMOUS";
    this.updateState({
      behavior: "WALK",
      animationLayer: "BASE",
      activeAnimationId: this.resources.walk.animationId,
      facing: pendingWalk.facing,
      visualTransition: "NONE",
      turnTargetFacing: undefined,
      turnFrameMirrored: undefined,
      currentMonitorId: pendingWalk.currentMonitorId,
      logicalPosition: pendingWalk.position,
      escapePlanId: pendingWalk.inputEscape?.planId,
    });
    const existingMotionLease =
      this.motionLease?.owner === motionOwner ? this.motionLease : undefined;
    const motionLease =
      existingMotionLease ?? this.acquireMotion(motionOwner, pendingWalk.position);
    this.activeWalk = {
      revision: pendingWalk.revision,
      endsAtMs: pendingWalk.inputEscape
        ? Number.POSITIVE_INFINITY
        : this.clock.now() + pendingWalk.durationMs,
      speedLogicalPxPerSecond: pendingWalk.speedLogicalPxPerSecond,
      facing: pendingWalk.facing,
      workArea: pendingWalk.workArea,
      inputEscape: pendingWalk.inputEscape,
      motionLease,
      position: pendingWalk.position,
      lastStepAtMs: this.clock.now(),
    };
    this.timeline.play(this.resources.walk, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => undefined,
    });
    if (existingMotionLease) {
      this.requestMotion(motionOwner, pendingWalk.position);
    }
    this.scheduleWalkTick(pendingWalk.revision);
  }

  private startTurn(pendingWalk: PendingWalk): void {
    const turn = this.resources.turn;

    if (!turn) {
      this.startPreparedWalk(pendingWalk);
      return;
    }

    if (pendingWalk.facing === this.currentState.facing) {
      this.startPreparedWalk(pendingWalk);
      return;
    }

    this.clearBlinkTimer();
    this.timeline.stop();
    this.activeTurn = {
      revision: pendingWalk.revision,
      targetFacing: pendingWalk.facing,
      frameMirrored:
        this.currentState.facing === "Left" && pendingWalk.facing === "Right",
      pendingWalk,
      facingSwitched: false,
    };
    this.updateState({
      behavior: "IDLE",
      animationLayer: "BASE",
      activeAnimationId: turn.animationId,
      visualTransition: "TURN",
      turnTargetFacing: pendingWalk.facing,
      turnFrameMirrored: this.activeTurn.frameMirrored,
      currentMonitorId: pendingWalk.currentMonitorId,
      logicalPosition: pendingWalk.position,
    });
    this.timeline.play(turn, {
      onFrame: (event) => {
        const activeTurn = this.activeTurn;

        if (
          !activeTurn ||
          activeTurn.revision !== pendingWalk.revision ||
          pendingWalk.revision !== this.behaviorRevision ||
          this.currentState.visualTransition !== "TURN"
        ) {
          return;
        }

        if (
          !activeTurn.facingSwitched &&
          event.frameIndex >= TURN_FACING_MIDPOINT_FRAME_INDEX
        ) {
          activeTurn.facingSwitched = true;
          this.updateState({ facing: activeTurn.targetFacing });
        }

        this.deliverFrame(event);
      },
      onComplete: () => {
        const activeTurn = this.activeTurn;

        if (
          !activeTurn ||
          activeTurn.revision !== pendingWalk.revision ||
          pendingWalk.revision !== this.behaviorRevision ||
          this.currentState.visualTransition !== "TURN" ||
          this.currentState.interaction !== "NONE"
        ) {
          return;
        }

        this.activeTurn = undefined;
        this.startPreparedWalk(activeTurn.pendingWalk);
      },
    });
  }

  private scheduleWalkTick(revision: number): void {
    const activeWalk = this.activeWalk;

    if (!activeWalk || activeWalk.revision !== revision) {
      return;
    }

    const remainingMs = Math.max(0, activeWalk.endsAtMs - this.clock.now());
    const productState = this.captureProductStateTicket();
    this.walkTimer = this.clock.setTimeout(() => {
      this.walkTimer = undefined;
      if (this.isStale(productState, revision)) {
        return;
      }
      this.advanceWalk(revision);
    }, Math.min(WALK_MOTION_TICK_MS, remainingMs));
  }

  private advanceWalk(revision: number): void {
    const activeWalk = this.activeWalk;

    if (
      !activeWalk ||
      activeWalk.revision !== revision ||
      revision !== this.behaviorRevision ||
      this.currentState.interaction !== "NONE" ||
      this.currentState.isDragging ||
      this.currentState.behavior !== "WALK"
    ) {
      return;
    }

    const currentTimeMs = activeWalk.inputEscape
      ? this.clock.now()
      : Math.min(this.clock.now(), activeWalk.endsAtMs);
    const elapsedMs = Math.max(0, currentTimeMs - activeWalk.lastStepAtMs);
    const direction = activeWalk.facing === "Right" ? 1 : -1;
    const unconstrainedX =
      activeWalk.position.x +
      (direction * activeWalk.speedLogicalPxPerSecond * elapsedMs) / 1_000;
    const targetX = activeWalk.inputEscape?.targetX ?? this.homeWalkTargetX();
    const proposedX = targetX !== undefined
      ? activeWalk.facing === "Right"
        ? Math.min(unconstrainedX, targetX)
        : Math.max(unconstrainedX, targetX)
      : unconstrainedX;
    const nextPosition = clampToWorkArea(
      { x: proposedX, y: activeWalk.position.y },
      activeWalk.workArea,
    );
    const hitBoundary = Math.abs(nextPosition.x - proposedX) > LOGICAL_EPSILON;

    if (!activeWalk.inputEscape && this.homePathBlocked(activeWalk.position, {
      space: "WINDOW_TOP_LEFT_LOGICAL", ...nextPosition,
    })) {
      this.finishWalk(revision);
      return;
    }
    activeWalk.homeArrivalPending = !activeWalk.inputEscape && !hitBoundary &&
      targetX !== undefined && positionsMatch(nextPosition.x, targetX);
    activeWalk.position = nextPosition;
    activeWalk.lastStepAtMs = currentTimeMs;
    this.updateState({ logicalPosition: nextPosition });
    this.requestMotion(
      activeWalk.inputEscape ? "INPUT_AVOIDANCE" : "AUTONOMOUS",
      nextPosition,
    );

    if (activeWalk.inputEscape) {
      if (
        hitBoundary ||
        positionsMatch(nextPosition.x, activeWalk.inputEscape.targetX)
      ) {
        this.finishInputEscapeWalk(revision);
        return;
      }

      this.scheduleWalkTick(revision);
      return;
    }

    if (activeWalk.homeArrivalPending) return;

    if (hitBoundary || this.clock.now() >= activeWalk.endsAtMs) {
      this.finishWalk(revision);
      return;
    }

    this.scheduleWalkTick(revision);
  }

  private finishWalk(revision: number): void {
    if (
      !this.activeWalk ||
      this.activeWalk.revision !== revision ||
      revision !== this.behaviorRevision
    ) {
      return;
    }

    this.clearWalkTimer();
    this.activeWalk = undefined;
    this.resumeIdleBehavior();
  }

  private scheduleInputAvoidanceEvaluation(): void {
    if (this.disposed || this.currentState.autonomyPaused) {
      return;
    }

    const evaluationRevision = ++this.avoidanceEvaluationRevision;
    void Promise.resolve().then(() =>
      this.evaluateInputAvoidance(evaluationRevision),
    );
  }

  private async evaluateInputAvoidance(
    evaluationRevision: number,
  ): Promise<void> {
    if (this.currentState.restoreStatus === "busy" || this.currentState.restoreStatus === "failed") return;
    const fact = this.inputAvoidanceFact as
      | ActiveInputAvoidanceFact
      | undefined;
    if (
      !fact ||
      this.currentState.autonomyPaused ||
      evaluationRevision !== this.avoidanceEvaluationRevision ||
      this.disposed ||
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE" ||
      this.interactionResponse !== undefined || this.currentState.pointerNearby ||
      this.currentState.isDragging ||
      this.hasActiveHomeCycle() ||
      (this.currentState.behavior !== "IDLE" &&
        this.currentState.behavior !== "WALK")
    ) {
      return;
    }

    let position: LogicalPoint | undefined;
    let monitorId: string | undefined;
    let currentWalkSpeed: number | undefined;

    if (this.activeWalk) {
      position = this.activeWalk.position;
      monitorId = this.currentState.currentMonitorId;
      currentWalkSpeed = this.activeWalk.speedLogicalPxPerSecond;
    } else if (this.activeTurn) {
      position = this.activeTurn.pendingWalk.position;
      monitorId = this.activeTurn.pendingWalk.currentMonitorId;
      currentWalkSpeed = this.activeTurn.pendingWalk.speedLogicalPxPerSecond;
    } else if (
      this.currentState.logicalPosition &&
      this.currentState.currentMonitorId === fact.monitorId
    ) {
      position = this.currentState.logicalPosition;
      monitorId = this.currentState.currentMonitorId;
    }

    if (!position || monitorId !== fact.monitorId) {
      const snapshot = await this.readAvoidanceMotionSnapshot();
      if (
        !snapshot ||
        this.currentState.autonomyPaused ||
        evaluationRevision !== this.avoidanceEvaluationRevision ||
        this.inputAvoidanceFact !== fact ||
        this.disposed ||
        this.currentState.interaction !== "NONE" ||
        this.interactionResponse !== undefined || this.currentState.pointerNearby ||
        this.hasActiveHomeCycle() ||
        (this.currentState.behavior !== "IDLE" &&
          this.currentState.behavior !== "WALK") ||
        snapshot.currentMonitorId !== fact.monitorId
      ) {
        return;
      }

      position = snapshot.windowPosition;
      monitorId = snapshot.currentMonitorId;
    }

    const groundedPosition = clampToWorkArea(position, fact.workArea);
    this.updateState({
      currentMonitorId: monitorId,
      logicalPosition: groundedPosition,
    });
    this.evaluateInputAvoidanceAt(
      fact,
      groundedPosition,
      currentWalkSpeed,
    );
  }

  private async readAvoidanceMotionSnapshot(): Promise<MotionSnapshot | null> {
    if (!this.motionPort) {
      return null;
    }

    if (!this.avoidanceResyncInFlight) {
      let pending: Promise<MotionSnapshot | null>;
      try {
        pending = this.motionPort.resync().catch(() => null);
      } catch {
        pending = Promise.resolve(null);
      }
      this.avoidanceResyncInFlight = pending;
      void pending.finally(() => {
        if (this.avoidanceResyncInFlight === pending) {
          this.avoidanceResyncInFlight = undefined;
        }
      });
    }

    return this.avoidanceResyncInFlight;
  }

  private evaluateInputAvoidanceAt(
    fact: ActiveInputAvoidanceFact,
    position: LogicalPoint,
    currentWalkSpeed?: number,
  ): void {
    const signature = avoidanceFactSignature(fact);
    const petWindow = windowRectAt(position);

    if (!rectsOverlap(petWindow, fact.forbiddenRegion)) {
      this.blockedAvoidanceSignature = undefined;
      if (this.activeEscapePlan) {
        this.cancelInputEscapeMovement(true);
      }
      return;
    }

    if (
      this.blockedAvoidanceSignature === signature &&
      !this.activeEscapePlan
    ) {
      this.clearAutonomousTimer();
      return;
    }

    const { minimumX, maximumX } = workAreaXRange(fact.workArea);
    const leftTargetX = fact.forbiddenRegion.left - RUNTIME_VIEWPORT_SIZE;
    const rightTargetX = fact.forbiddenRegion.right;
    const leftFits = leftTargetX >= minimumX && leftTargetX <= maximumX;
    const rightFits = rightTargetX >= minimumX && rightTargetX <= maximumX;
    const activePlan = this.activeEscapePlan;
    const sameMaterialPlan =
      activePlan?.factKind === fact.kind &&
      activePlan.monitorId === fact.monitorId &&
      activePlan.monitorRevision === fact.monitorRevision;

    if (activePlan?.outcome === "CLEAR" && sameMaterialPlan) {
      const lockedTarget =
        activePlan.direction === "Left" ? leftTargetX : rightTargetX;
      const lockedSideFits =
        activePlan.direction === "Left" ? leftFits : rightFits;
      if (lockedSideFits) {
        this.updateActiveEscapeTarget(activePlan, lockedTarget);
        return;
      }
    }

    const clearingTargets: Array<Readonly<{
      direction: Facing;
      targetX: number;
    }>> = [];
    if (leftFits) {
      clearingTargets.push({ direction: "Left", targetX: leftTargetX });
    }
    if (rightFits) {
      clearingTargets.push({ direction: "Right", targetX: rightTargetX });
    }

    if (clearingTargets.length > 0) {
      const selected = clearingTargets.sort((left, right) => {
        const distanceDelta =
          Math.abs(left.targetX - position.x) -
          Math.abs(right.targetX - position.x);
        if (Math.abs(distanceDelta) > LOGICAL_EPSILON) {
          return distanceDelta;
        }

        return left.direction === "Left" ? -1 : 1;
      })[0];

      if (
        activePlan?.outcome === "CLEAR" &&
        sameMaterialPlan &&
        activePlan.direction === selected.direction
      ) {
        this.updateActiveEscapeTarget(activePlan, selected.targetX);
        return;
      }

      this.beginInputEscape(
        fact,
        position,
        selected.direction,
        selected.targetX,
        "CLEAR",
        currentWalkSpeed,
      );
      return;
    }

    const boundaryTargets = [
      { direction: "Left" as const, targetX: minimumX },
      { direction: "Right" as const, targetX: maximumX },
    ].sort((left, right) => {
      const leftOverlap = overlapArea(
        windowRectAt({ x: left.targetX, y: position.y }),
        fact.forbiddenRegion,
      );
      const rightOverlap = overlapArea(
        windowRectAt({ x: right.targetX, y: position.y }),
        fact.forbiddenRegion,
      );
      if (!positionsMatch(leftOverlap, rightOverlap)) {
        return leftOverlap - rightOverlap;
      }

      const distanceDelta =
        Math.abs(left.targetX - position.x) -
        Math.abs(right.targetX - position.x);
      if (Math.abs(distanceDelta) > LOGICAL_EPSILON) {
        return distanceDelta;
      }

      return left.direction === "Left" ? -1 : 1;
    });
    const selectedBoundary = boundaryTargets[0];
    this.warnNoSafeSide(fact.focusSessionId);

    if (
      activePlan?.outcome === "MINIMUM_OVERLAP" &&
      sameMaterialPlan &&
      activePlan.direction === selectedBoundary.direction &&
      positionsMatch(activePlan.targetX, selectedBoundary.targetX)
    ) {
      return;
    }

    if (positionsMatch(position.x, selectedBoundary.targetX)) {
      this.stopAtBlockedBoundary(fact, position);
      return;
    }

    // No side can clear the forbidden region. Keep the current authoritative
    // position instead of inventing a minimum-overlap route that is not safe.
    this.stopAtBlockedBoundary(fact, position);
  }

  private beginInputEscape(
    fact: ActiveInputAvoidanceFact,
    position: LogicalPoint,
    direction: Facing,
    targetX: number,
    outcome: InputEscapeWalk["outcome"],
    currentWalkSpeed?: number,
  ): void {
    if (this.currentState.autonomyPaused) return;
    this.cancelInteractionResponse(true);
    this.behaviorRevision += 1;
    const revision = this.behaviorRevision;
    this.clearAutonomousTimer();
    this.clearWalkTimer();
    this.clearBlinkTimer();
    this.activeWalk = undefined;
    this.activeTurn = undefined;
    this.timeline.stop();
    this.blockedAvoidanceSignature = undefined;

    const plan: ActiveEscapePlan = {
      id: ++this.nextEscapePlanId,
      direction,
      targetX,
      outcome,
      factKind: fact.kind,
      monitorId: fact.monitorId,
      monitorRevision: fact.monitorRevision,
    };
    this.activeEscapePlan = plan;
    const inputEscape: InputEscapeWalk = {
      planId: plan.id,
      targetX,
      outcome,
    };
    const pendingWalk: PendingWalk = {
      revision,
      durationMs: Number.POSITIVE_INFINITY,
      speedLogicalPxPerSecond:
        currentWalkSpeed ??
        PET_BEHAVIOR_CONFIG.walk.minSpeedLogicalPxPerSecond,
      facing: direction,
      currentMonitorId: fact.monitorId,
      workArea: fact.workArea,
      position,
      inputEscape,
    };
    this.acquireMotion("INPUT_AVOIDANCE", position);
    this.updateState({ escapePlanId: plan.id });

    if (direction !== this.currentState.facing) {
      this.startTurn(pendingWalk);
      return;
    }

    this.startPreparedWalk(pendingWalk);
  }

  private updateActiveEscapeTarget(
    plan: ActiveEscapePlan,
    targetX: number,
  ): void {
    plan.targetX = targetX;
    if (this.activeWalk?.inputEscape?.planId === plan.id) {
      this.activeWalk.inputEscape.targetX = targetX;
    }
    if (this.activeTurn?.pendingWalk.inputEscape?.planId === plan.id) {
      this.activeTurn.pendingWalk.inputEscape.targetX = targetX;
    }
  }

  private finishInputEscapeWalk(revision: number): void {
    const activeWalk = this.activeWalk;
    const plan = this.activeEscapePlan;
    if (
      !activeWalk?.inputEscape ||
      !plan ||
      activeWalk.revision !== revision ||
      activeWalk.inputEscape.planId !== plan.id ||
      revision !== this.behaviorRevision
    ) {
      return;
    }

    this.clearWalkTimer();
    this.activeWalk = undefined;
    this.activeEscapePlan = undefined;
    if (plan.outcome === "MINIMUM_OVERLAP" && this.inputAvoidanceFact) {
      this.blockedAvoidanceSignature = avoidanceFactSignature(
        this.inputAvoidanceFact,
      );
    } else {
      this.blockedAvoidanceSignature = undefined;
    }
    this.updateState({ escapePlanId: undefined });
    this.playIdle();
    this.acquireMotion("AUTONOMOUS", this.currentWindowTopLeft());
    this.scheduleBlink();
    this.scheduleIdleInterval();
  }

  private cancelInputEscapeMovement(returnToIdle: boolean): void {
    const hasInputEscapeMovement =
      this.activeEscapePlan !== undefined ||
      this.activeWalk?.inputEscape !== undefined ||
      this.activeTurn?.pendingWalk.inputEscape !== undefined;
    this.activeEscapePlan = undefined;
    this.avoidanceEvaluationRevision += 1;
    if (this.currentState.escapePlanId !== undefined) {
      this.updateState({ escapePlanId: undefined });
    }

    if (!hasInputEscapeMovement) {
      return;
    }

    this.cancelInteractionResponse(true);
    this.behaviorRevision += 1;
    this.clearAutonomousTimer();
    this.clearWalkTimer();
    this.clearBlinkTimer();
    this.activeWalk = undefined;
    this.activeTurn = undefined;
    this.timeline.stop();

    if (
      returnToIdle &&
      this.currentState.interaction === "NONE" &&
      (this.currentState.behavior === "IDLE" ||
        this.currentState.behavior === "WALK")
    ) {
      this.playIdle();
      this.acquireMotion("AUTONOMOUS", this.currentWindowTopLeft());
      this.scheduleBlink();
      this.scheduleIdleInterval();
    }
  }

  private stopAtBlockedBoundary(
    fact: ActiveInputAvoidanceFact,
    position: LogicalPoint,
  ): void {
    const signature = avoidanceFactSignature(fact);
    if (this.blockedAvoidanceSignature === signature) {
      this.clearAutonomousTimer();
      return;
    }

    const wasMoving =
      this.currentState.behavior === "WALK" ||
      this.currentState.visualTransition === "TURN";
    this.blockedAvoidanceSignature = signature;
    this.activeEscapePlan = undefined;
    this.clearAutonomousTimer();
    this.clearWalkTimer();
    this.activeWalk = undefined;
    this.activeTurn = undefined;
    this.acquireMotion("AUTONOMOUS", position);

    if (this.currentState.escapePlanId !== undefined) {
      this.updateState({ escapePlanId: undefined });
    }
    this.updateState({ logicalPosition: position });

    if (wasMoving) {
      this.cancelInteractionResponse(true);
      this.behaviorRevision += 1;
      this.timeline.stop();
      this.resumeIdleBehavior();
    }
  }

  private warnNoSafeSide(focusSessionId: string | undefined): void {
    if (!focusSessionId || this.warnedFocusSessionIds.has(focusSessionId)) {
      return;
    }

    // Bounded: a long session sees unbounded focus sessions otherwise, and the
    // set only ever needs to suppress a repeat warning for the current one.
    if (this.warnedFocusSessionIds.size >= WARNED_FOCUS_SESSION_LIMIT) {
      this.warnedFocusSessionIds.clear();
    }
    this.warnedFocusSessionIds.add(focusSessionId);
    this.onInputAvoidanceWarning({
      code: "INPUT_AVOIDANCE_NO_SAFE_SIDE",
      focusSessionId,
    });
  }

  /** Decide once per release, including a caught FALL, using an actual same-monitor Home. */
  private createFallParachute(position: LogicalPoint, workArea: LogicalWorkArea): FallParachute | undefined {
    if (!this.setParachuteExpanded) return undefined;
    const surface = computeHomeLandingSurface(workArea, this.homeSurface);
    const footX = position.x + HOME_CHARACTER_FOOT_CENTER_LOGICAL_X;
    const overHome = surface && footX >= surface.leftX && footX <= surface.rightX &&
      position.y + RUNTIME_FOOT_BASELINE_LOGICAL_PX <= surface.y;
    const landingTopY = overHome
      ? surface.y - RUNTIME_FOOT_BASELINE_LOGICAL_PX
      : getGroundWindowTopY(workArea);
    if (landingTopY - position.y < PET_BEHAVIOR_CONFIG.parachute.minimumDropLogicalPx) return undefined;
    return {
      eligible: true,
      pending: false,
      elapsedMs: 0,
      openingStartVelocity: 0,
      baseX: position.x,
      swaySuppressed: this.reducedMotion,
      landingTopY,
      homeRange: overHome ? {
        left: surface.leftX - HOME_CHARACTER_FOOT_CENTER_LOGICAL_X,
        right: surface.rightX - HOME_CHARACTER_FOOT_CENTER_LOGICAL_X,
      } : undefined,
    };
  }

  private tryOpenParachute(fall: ActiveFall): void {
    const parachute = fall.parachute;
    if (!parachute?.eligible || parachute.pending || !this.setParachuteExpanded ||
        this.currentState.interaction !== "NONE") return;
    const config = PET_BEHAVIOR_CONFIG.parachute;
    // The canonical dog remains 160x160. The temporary 80px canopy inset must
    // fit above it before the native window is expanded; falling may start first.
    if (fall.position.y < fall.workArea.y + config.viewportTopInsetLogicalPx) return;
    parachute.eligible = false;
    if (parachute.landingTopY - fall.position.y <= config.settleDistanceLogicalPx) return;
    parachute.pending = true;
    this.parachuteViewportRequested = true;
    this.parachuteViewportOperation += 1;
    const revision = ++this.parachuteRevision;
    void Promise.resolve().then(() => this.setParachuteExpanded!(true)).then((expanded) => {
      if (revision !== this.parachuteRevision || this.activeFall !== fall || this.disposed) return;
      parachute.pending = false;
      if (!expanded || this.currentState.behavior !== "FALL" || this.currentState.interaction !== "NONE" ||
          parachute.landingTopY - fall.position.y <= config.settleDistanceLogicalPx ||
          fall.position.y < fall.workArea.y + config.viewportTopInsetLogicalPx) {
        this.cancelParachute();
        return;
      }
      parachute.openingStartVelocity = fall.verticalVelocityLogicalPxPerSecond;
      parachute.elapsedMs = 0;
      // Keep the original FALL pose already on screen. Its short free-fall
      // loop flickers under a canopy; motion and canopy timing keep running.
      this.timeline.stop();
      fall.spriteHeldForParachute = true;
      this.updateState({ parachutePhase: "OPENING", parachuteProgress: 0 });
    }).catch(() => {
      if (revision === this.parachuteRevision && this.activeFall === fall) this.cancelParachute();
    });
  }

  private advanceFallPhysics(fall: ActiveFall, elapsedMs: number): void {
    const parachute = fall.parachute;
    const phase = this.currentState.parachutePhase;
    if (!parachute || (phase !== "OPENING" && phase !== "GLIDING")) {
      // Resume only when a cancelled canopy actually returns to free fall,
      // avoiding a stray FALL frame during re-grab, landing or disposal.
      if (fall.spriteHeldForParachute) {
        fall.spriteHeldForParachute = false;
        this.playFallAnimation();
      }
      const step = integrateFallPhysicsStep(fall.position.y, fall.verticalVelocityLogicalPxPerSecond, elapsedMs);
      fall.position = { x: fall.position.x, y: step.positionY };
      fall.verticalVelocityLogicalPxPerSecond = step.verticalVelocityLogicalPxPerSecond;
      return;
    }
    const config = PET_BEHAVIOR_CONFIG.parachute;
    const deltaMs = clampFallPhysicsDeltaMs(elapsedMs);
    parachute.elapsedMs += deltaMs;
    const progress = Math.min(1, parachute.elapsedMs / config.openingDurationMs);
    const easedProgress = progress * progress * (3 - 2 * progress);
    const gravityVelocity = Math.min(PET_BEHAVIOR_CONFIG.fall.maxSpeedLogicalPxPerSecond,
      parachute.openingStartVelocity + PET_BEHAVIOR_CONFIG.fall.gravityLogicalPxPerSecondSquared * parachute.elapsedMs / 1_000);
    const velocity = gravityVelocity * (1 - easedProgress) + config.glideSpeedLogicalPxPerSecond * easedProgress;
    const y = fall.position.y + (fall.verticalVelocityLogicalPxPerSecond + velocity) / 2 * deltaMs / 1_000;
    const remaining = Math.max(0, parachute.landingTopY - y);
    const swayEnvelope = Math.min(1, remaining / config.settleDistanceLogicalPx) * easedProgress;
    let x = parachute.baseX + (this.reducedMotion || parachute.swaySuppressed ? 0 : config.swayAmplitudeLogicalPx * swayEnvelope *
      Math.sin(parachute.elapsedMs / config.swayPeriodMs * Math.PI * 2));
    if (parachute.homeRange) x = Math.min(parachute.homeRange.right, Math.max(parachute.homeRange.left, x));
    fall.position = { x: clampWorkAreaX(x, fall.workArea), y };
    fall.verticalVelocityLogicalPxPerSecond = velocity;
    this.updateState({ parachutePhase: progress === 1 ? "GLIDING" : "OPENING", parachuteProgress: easedProgress });
  }

  /** Close only after the landing anchor has been accepted by the motion port. */
  private prepareParachuteLanding(): void {
    if (this.currentState.parachutePhase === "OPENING" || this.currentState.parachutePhase === "GLIDING") {
      this.parachuteLandingPending = true;
    } else this.cancelParachute();
  }

  private confirmParachuteLanding(): void {
    if (!this.parachuteLandingPending || this.currentState.behavior !== "LAND" ||
        this.currentState.interaction !== "NONE") return;
    const position = this.currentState.logicalPosition;
    const confirmed = this.confirmedMotion;
    if (this.motionPort && (!position || !confirmed || confirmed.epoch !== this.motionLease?.epoch ||
        !positionsMatch(confirmed.position.x, position.x) || !positionsMatch(confirmed.position.y, position.y))) return;
    this.parachuteLandingPending = false;
    const revision = this.parachuteRevision;
    const startedAt = this.clock.now();
    const initialProgress = this.currentState.parachuteProgress ?? 1;
    this.updateState({ parachutePhase: "CLOSING" });
    const tick = (): void => {
      this.parachuteCloseTimer = undefined;
      if (this.disposed || revision !== this.parachuteRevision) return;
      const progress = Math.min(1, (this.clock.now() - startedAt) / PET_BEHAVIOR_CONFIG.parachute.closingDurationMs);
      this.updateState({ parachuteProgress: initialProgress * (1 - progress) });
      if (progress < 1) {
        this.parachuteCloseTimer = this.clock.setTimeout(tick,
          Math.min(FALL_MOTION_TICK_MS, PET_BEHAVIOR_CONFIG.parachute.closingDurationMs - (this.clock.now() - startedAt)));
        return;
      }
      this.cancelParachute();
      if (this.landCompletionPending) this.finishLand(this.behaviorRevision);
    };
    this.parachuteCloseTimer = this.clock.setTimeout(tick, FALL_MOTION_TICK_MS);
  }

  private cancelParachute(): void {
    this.parachuteRevision += 1;
    if (this.parachuteCloseTimer !== undefined) this.clock.clearTimeout(this.parachuteCloseTimer);
    this.parachuteCloseTimer = undefined;
    this.parachuteLandingPending = false;
    if (this.activeFall) this.activeFall.parachute = undefined;
    this.updateState({ parachutePhase: "NONE", parachuteProgress: 0 });
    this.requestParachuteCollapse();
  }

  private requestParachuteCollapse(): void {
    if (!this.parachuteViewportRequested || !this.setParachuteExpanded ||
        this.parachuteCollapseOperation === this.parachuteViewportOperation) return;
    const operation = ++this.parachuteViewportOperation;
    this.parachuteCollapseOperation = operation;
    const collapse = async (): Promise<void> => {
      // One bounded retry handles a recoverable native resize failure. If both
      // attempts fail, keep the repair flag for the next interaction or restore.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (operation !== this.parachuteViewportOperation) return;
        const closed = await Promise.resolve().then(() => this.setParachuteExpanded!(false)).catch(() => false);
        if (operation !== this.parachuteViewportOperation) return;
        if (closed) {
          this.parachuteViewportRequested = false;
          break;
        }
      }
      if (this.parachuteCollapseOperation === operation) this.parachuteCollapseOperation = undefined;
    };
    void collapse();
  }

  private startFall(
    snapshot: MotionSnapshot,
    revision: number,
    releasedByDrag = false,
  ): void {
    this.cancelParachute();
    this.updateHomeGeometry(snapshot);
    this.onMotionSnapshotAccepted?.(snapshot);
    this.currentWindowScaleFactor = snapshot.windowScaleFactor;
    this.currentWorkArea = cloneWorkArea(snapshot.workArea);
    const position = clampFallPosition(snapshot.windowPosition, snapshot.workArea);
    const groundTopY = getGroundWindowTopY(snapshot.workArea);
    const motionLease = this.acquireMotion("FALL", position);

    this.clearAutonomousTimer();
    this.clearWalkTimer();
    this.clearFallTimer();
    this.clearBlinkTimer();
    this.clearLookExitTimer();
    this.activeWalk = undefined;
    this.timeline.stop();
    this.activeFall = {
      revision,
      currentMonitorId: snapshot.currentMonitorId,
      workArea: snapshot.workArea,
      position,
      verticalVelocityLogicalPxPerSecond: 0,
      lastStepAtMs: this.clock.now(),
      nextWorkAreaRefreshAtMs:
        this.clock.now() + FALL_WORK_AREA_REFRESH_INTERVAL_MS,
      parachute: releasedByDrag ? this.createFallParachute(position, snapshot.workArea) : undefined,
      motionLease,
    };

    if (position.y >= groundTopY) {
      this.enterLand(position, snapshot.currentMonitorId, snapshot.workArea, revision);
      return;
    }

    this.updateState({
      behavior: "FALL",
      animationLayer: "BASE",
      activeAnimationId: this.resources.fall.animationId,
      facing: "Right",
      currentMonitorId: snapshot.currentMonitorId,
      logicalPosition: position,
      verticalVelocityLogicalPxPerSecond: 0,
      groundTopY,
    });
    this.playFallAnimation();
    this.requestMotion("FALL", position);
    this.tryOpenParachute(this.activeFall!);
    this.scheduleFallTick(revision);
  }

  private playFallAnimation(): void {
    this.timeline.play(this.resources.fall, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => undefined,
    });
  }

  private scheduleFallTick(revision: number): void {
    const activeFall = this.activeFall;

    if (!activeFall || activeFall.revision !== revision) {
      return;
    }

    const productState = this.captureProductStateTicket();
    this.fallTimer = this.clock.setTimeout(() => {
      this.fallTimer = undefined;
      if (!this.isCurrentProductState(productState)) {
        return;
      }
      this.advanceFall(revision);
    }, FALL_MOTION_TICK_MS);
  }

  private advanceFall(revision: number): void {
    const activeFall = this.activeFall;

    if (
      !activeFall ||
      activeFall.revision !== revision ||
      revision !== this.behaviorRevision ||
      this.currentState.behavior !== "FALL" ||
      this.currentState.interaction !== "NONE"
    ) {
      return;
    }

    const currentTimeMs = this.clock.now();
    const previousPosition = { ...activeFall.position };
    this.advanceFallPhysics(activeFall, currentTimeMs - activeFall.lastStepAtMs);
    activeFall.lastStepAtMs = currentTimeMs;
    this.tryOpenParachute(activeFall);

    if (
      crossesHomeLandingSurface(
        previousPosition,
        activeFall.position,
        activeFall.workArea,
        this.homeSurface,
      )
    ) {
      this.enterHomeFromFall(activeFall, revision);
      return;
    }

    const groundTopY = getGroundWindowTopY(activeFall.workArea);
    if (activeFall.position.y >= groundTopY) {
      this.enterLand(
        activeFall.position,
        activeFall.currentMonitorId,
        activeFall.workArea,
        revision,
      );
      return;
    }

    this.updateState({
      currentMonitorId: activeFall.currentMonitorId,
      logicalPosition: activeFall.position,
      verticalVelocityLogicalPxPerSecond:
        activeFall.verticalVelocityLogicalPxPerSecond,
      groundTopY,
    });
    this.requestMotion("FALL", activeFall.position);

    if (currentTimeMs >= activeFall.nextWorkAreaRefreshAtMs) {
      activeFall.nextWorkAreaRefreshAtMs =
        currentTimeMs + FALL_WORK_AREA_REFRESH_INTERVAL_MS;
      this.refreshFallWorkArea(revision);
    }

    this.scheduleFallTick(revision);
  }

  private refreshFallWorkArea(revision: number): void {
    const motionPort = this.motionPort;

    if (
      !motionPort?.readCurrentWorkArea ||
      this.fallWorkAreaRefreshInFlight
    ) {
      return;
    }

    this.fallWorkAreaRefreshInFlight = true;
    const productState = this.captureProductStateTicket();
    void motionPort
      .readCurrentWorkArea()
      .then(async (facts) => {
        const activeFall = this.activeFall;
        if (
          !facts ||
          !activeFall ||
          !this.isCurrentProductState(productState) ||
          activeFall.revision !== revision ||
          revision !== this.behaviorRevision ||
          this.currentState.behavior !== "FALL" ||
          // A held re-grab suspends motion. Its release resync will provide
          // fresh geometry; an older refresh must not move or land the pet.
          this.currentState.interaction !== "NONE"
        ) {
          return;
        }

        if (facts.windowScaleFactor !== undefined && this.currentWindowScaleFactor !== undefined &&
            Math.abs(facts.windowScaleFactor - this.currentWindowScaleFactor) > LOGICAL_EPSILON) {
          this.cancelParachute();
          const snapshot = await motionPort.resync();
          if (snapshot && this.activeFall === activeFall && this.isCurrentProductState(productState) &&
              revision === this.behaviorRevision && this.currentState.interaction === "NONE") {
            this.applyFallSnapshot(snapshot, revision);
          }
          return;
        }
        activeFall.currentMonitorId = facts.currentMonitorId;
        if (this.updateHomeGeometry({ ...facts,
          windowScaleFactor: facts.windowScaleFactor ?? this.currentWindowScaleFactor ?? 1,
          windowPosition: { space: "WINDOW_TOP_LEFT_LOGICAL", ...activeFall.position },
        })) this.cancelParachute();
        activeFall.workArea = facts.workArea;
        this.currentWorkArea = cloneWorkArea(facts.workArea);
        activeFall.position = clampFallPosition(activeFall.position, facts.workArea);
        const groundTopY = getGroundWindowTopY(facts.workArea);

        if (activeFall.position.y >= groundTopY) {
          this.enterLand(
            activeFall.position,
            facts.currentMonitorId,
            facts.workArea,
            revision,
          );
          return;
        }

        this.updateState({
          currentMonitorId: facts.currentMonitorId,
          logicalPosition: activeFall.position,
          verticalVelocityLogicalPxPerSecond:
            activeFall.verticalVelocityLogicalPxPerSecond,
          groundTopY,
        });
        this.requestMotion("FALL", activeFall.position);
      })
      .catch(() => undefined)
      .finally(() => {
        this.fallWorkAreaRefreshInFlight = false;
      });
  }

  private applyFallSnapshot(snapshot: MotionSnapshot, revision: number): void {
    const activeFall = this.activeFall;

    if (!activeFall || activeFall.revision !== revision ||
        (snapshot.snapshotRevision !== undefined && snapshot.snapshotRevision < this.lastHomeSnapshotRevision)) {
      return;
    }

    this.onMotionSnapshotAccepted?.(snapshot);
    this.currentWindowScaleFactor = snapshot.windowScaleFactor;
    this.updateHomeGeometry(snapshot);
    activeFall.currentMonitorId = snapshot.currentMonitorId;
    activeFall.workArea = snapshot.workArea;
    this.currentWorkArea = cloneWorkArea(snapshot.workArea);
    activeFall.position = clampFallPosition(
      snapshot.windowPosition,
      snapshot.workArea,
    );
    activeFall.lastStepAtMs = this.clock.now();
    const groundTopY = getGroundWindowTopY(snapshot.workArea);
    if (activeFall.position.y >= groundTopY) {
      this.enterLand(
        activeFall.position,
        snapshot.currentMonitorId,
        snapshot.workArea,
        revision,
      );
      return;
    }

    this.acquireMotion("FALL", activeFall.position);
    this.updateState({
      currentMonitorId: snapshot.currentMonitorId,
      logicalPosition: activeFall.position,
      verticalVelocityLogicalPxPerSecond:
        activeFall.verticalVelocityLogicalPxPerSecond,
      groundTopY,
    });
    this.requestMotion("FALL", activeFall.position);
  }

  private enterHomeFromFall(activeFall: ActiveFall, revision: number): void {
    const entryPoint = computeHomeEntryPoint(activeFall.workArea, this.homeSurface);
    const restPoint = computeHomeRestPoint(activeFall.workArea, this.homeSurface);
    if (!entryPoint || !restPoint) {
      return;
    }

    this.prepareParachuteLanding();
    this.clearFallTimer();
    this.activeFall = undefined;
    this.landCompletionPending = false;
    this.timeline.stop();
    this.currentWorkArea = cloneWorkArea(activeFall.workArea);

    const cycle = this.homeCycle ?? {
      revision: 1,
      roundTripsTarget: sampleHomeRoundTrips(this.homeRandom),
      roundTripsCompleted: 0,
      route: computeHomeWalkRoute(activeFall.workArea, this.homeSurface),
      routeLeg: "LOCATE" as const,
      entryPoint,
      restPoint,
      workArea: cloneWorkArea(activeFall.workArea),
      currentMonitorId: activeFall.currentMonitorId,
      position: { ...restPoint },
      lastStepAtMs: this.clock.now(),
    };
    this.homeCycle = cycle;
    this.clearHomeCycleTimer();
    cycle.revision += 1;
    cycle.phase = "GO_HOME";
    cycle.stage = "LAND";
    cycle.entryPoint = entryPoint;
    cycle.restPoint = restPoint;
    cycle.workArea = cloneWorkArea(activeFall.workArea);
    cycle.currentMonitorId = activeFall.currentMonitorId;
    cycle.position = { ...restPoint };
    cycle.lastStepAtMs = this.clock.now();
    cycle.jumpStartedAtMs = undefined;
    cycle.jumpStart = undefined;
    cycle.restDeadlineMs = undefined;

    this.updateState({
      behavior: "LAND",
      animationLayer: "BASE",
      activeAnimationId: this.resources.homeLand.animationId,
      facing: "Right",
      currentMonitorId: cycle.currentMonitorId,
      logicalPosition: { ...cycle.position },
      verticalVelocityLogicalPxPerSecond: 0,
      groundTopY: cycle.position.y,
      homePending: undefined,
      ...this.homeCycleStatePatch(),
    });
    this.acquireMotion("RECOVERY", cycle.position);
    this.confirmParachuteLanding();
    const productState = this.captureProductStateTicket();
    const cycleRevision = cycle.revision;
    this.timeline.play(this.resources.homeLand, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => {
        if (
          this.homeCycle !== cycle ||
          cycle.revision !== cycleRevision ||
          revision !== this.behaviorRevision ||
          cycle.stage !== "LAND" ||
          !this.isCurrentProductState(productState)
        ) {
          return;
        }
        this.beginHomeIdle();
      },
    });
  }

  private enterLand(
    position: LogicalPoint,
    currentMonitorId: string,
    workArea: LogicalWorkArea,
    revision: number,
  ): void {
    const landedPosition = {
      ...clampFallPosition(position, workArea),
      y: getGroundWindowTopY(workArea),
    };

    this.prepareParachuteLanding();
    this.clearFallTimer();
    this.activeFall = undefined;
    this.landCompletionPending = false;
    this.timeline.stop();
    this.currentWorkArea = cloneWorkArea(workArea);
    this.updateState({
      behavior: "LAND",
      animationLayer: "BASE",
      activeAnimationId: this.resources.land.animationId,
      facing: "Right",
      currentMonitorId,
      logicalPosition: landedPosition,
      verticalVelocityLogicalPxPerSecond: 0,
      groundTopY: landedPosition.y,
    });
    this.acquireMotion("RECOVERY", landedPosition);
    this.confirmParachuteLanding();
    const productState = this.captureProductStateTicket();
    this.timeline.play(this.resources.land, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => {
        if (
          !this.isCurrentProductState(productState) ||
          this.behaviorRevision !== revision ||
          this.currentState.behavior !== "LAND"
        ) {
          return;
        }

        if (this.currentState.interaction === "ARMED") {
          this.landCompletionPending = true;
          return;
        }

        this.finishLand(revision);
      },
    });
  }

  private finishLand(revision: number): void {
    if (
      this.behaviorRevision !== revision ||
      this.currentState.behavior !== "LAND" ||
      this.currentState.interaction !== "NONE"
    ) {
      return;
    }

    if (this.currentState.parachutePhase !== "NONE") {
      this.landCompletionPending = true;
      return;
    }
    this.landCompletionPending = false;
    if (this.homeCycle?.stage === "LAND") {
      this.beginHomeIdle();
      return;
    }
    this.settledClickUntilMs = this.clock.now() + INTERACTION_RESPONSE_INTERVAL_MS;
    this.playIdle();
    this.acquireMotion("AUTONOMOUS", this.currentWindowTopLeft());
    this.scheduleBlink();
    this.scheduleIdleInterval();
  }

  private startLook(point: LogicalPoint): void {
    if (
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE"
    ) {
      return;
    }

    this.stopForDirectInteraction();
    this.updateState({
      behavior: "LOOK",
      animationLayer: "BASE",
      activeAnimationId: this.resources.lookMouse.animationId,
      facing: point.x < RUNTIME_VIEWPORT_SIZE / 2 ? "Left" : "Right",
    });
    this.timeline.play(this.resources.lookMouse, {
      onFrame: (event) => this.deliverFrame(event),
      onComplete: () => undefined,
    });
  }

  private scheduleLookExit(): void {
    if (this.lookExitTimer !== undefined) {
      return;
    }

    const productState = this.captureProductStateTicket();
    const revision = this.behaviorRevision;
    this.lookExitTimer = this.clock.setTimeout(() => {
      this.lookExitTimer = undefined;
      if (
        !this.isCurrentProductState(productState) ||
        revision !== this.behaviorRevision ||
        this.currentState.behavior !== "LOOK" ||
        this.currentState.interaction !== "NONE" ||
        this.currentState.pointerNearby
      ) {
        return;
      }

      this.timeline.stop();
      this.resumeIdleBehavior();
    }, PET_BEHAVIOR_CONFIG.look.exitDelayMs);
  }

  private stopForDirectInteraction(): void {
    this.cancelInteractionResponse();
    this.cancelParachute();
    // 未确认的端点不能被交互接管后的坐标重申变成有效到达。
    if (this.activeWalk?.homeArrivalPending) this.resetHomeRoute(false, true);
    this.behaviorRevision += 1;
    this.avoidanceEvaluationRevision += 1;
    const cycle = this.homeCycle;
    if (cycle?.awakeStartedAtMs !== undefined && cycle.phase !== "FADE_IN") {
      this.clearHomeCycleTimer();
      this.updateState({ homePending: undefined });
      if (cycle.stage === "SLEEP" || cycle.stage === "WAKE_HOLD") cycle.awakeStartedAtMs = this.clock.now();
      cycle.revision += 1;
      cycle.stage = "AWAKE";
      cycle.restDeadlineMs = undefined;
      cycle.quietUntilMs = this.clock.now() + HOME_INTERACTION_QUIET_MS;
      this.publishHomeCycleState();
    } else this.cancelHomeCycleForInteraction();
    this.clearAutonomousTimer();
    this.clearWalkTimer();
    this.clearFallTimer();
    this.clearHomeCycleTimer();
    this.clearBlinkTimer();
    this.clearLookExitTimer();
    this.activeWalk = undefined;
    this.activeTurn = undefined;
    this.activeFall = undefined;
    this.activeEscapePlan = undefined;
    this.blockedAvoidanceSignature = undefined;
    this.fallWorkAreaRefreshInFlight = false;
    this.happyCompletionPending = false;
    this.landCompletionPending = false;
    if (this.currentState.escapePlanId !== undefined) {
      this.updateState({ escapePlanId: undefined });
    }
    if (this.currentState.visualTransition !== "NONE") {
      this.updateState({
        visualTransition: "NONE",
        turnTargetFacing: undefined,
        turnFrameMirrored: undefined,
      });
    }
    this.timeline.stop();
    const heldHome = this.homeCycle;
    if (heldHome?.awakeStartedAtMs !== undefined && this.currentState.behavior !== "DRAG" &&
        this.currentState.behavior !== "FALL") this.acquireMotion("AUTONOMOUS", heldHome.position);
    else this.acquireMotion("AUTONOMOUS", this.currentWindowTopLeft());
  }

  private interruptAutonomousMovement(): void {
    this.stopForDirectInteraction();
    this.playIdle();
  }

  private applyMotionSnapshot(snapshot: MotionSnapshot): void {
    this.updateHomeGeometry(snapshot);
    this.onMotionSnapshotAccepted?.(snapshot);
    this.currentWindowScaleFactor = snapshot.windowScaleFactor;
    this.authoritativeWindowTopLeft = {
      space: "WINDOW_TOP_LEFT_LOGICAL",
      x: snapshot.windowPosition.x,
      y: snapshot.windowPosition.y,
    };
    this.currentWorkArea = cloneWorkArea(snapshot.workArea);
    if (this.homeCycle) {
      const oldArea = this.homeCycle.workArea;
      const changed = oldArea.x !== snapshot.workArea.x || oldArea.y !== snapshot.workArea.y ||
        oldArea.width !== snapshot.workArea.width || oldArea.height !== snapshot.workArea.height;
      this.homeCycle.workArea = cloneWorkArea(snapshot.workArea);
      if (changed) this.resetHomeRoute();
      if (!this.homeCycle.stage || this.homeCycle.stage === "APPROACH") {
        const entryPoint = computeHomeEntryPoint(snapshot.workArea, this.homeSurface);
        const restPoint = computeHomeRestPoint(snapshot.workArea, this.homeSurface);
        if (entryPoint && restPoint) {
          this.homeCycle.entryPoint = entryPoint;
          this.homeCycle.restPoint = restPoint;
        }
      }
      this.homeCycle.currentMonitorId = snapshot.currentMonitorId;
    }
    this.updateState({
      currentMonitorId: snapshot.currentMonitorId,
      logicalPosition: { ...snapshot.windowPosition },
    });
  }

  private canScheduleAutonomousAction(): boolean {
    return (
      !this.currentState.autonomyPaused &&
      !this.inputAvoidanceSafetyUnknown &&
      this.currentState.restoreStatus !== "busy" && this.currentState.restoreStatus !== "failed" &&
      !this.disposed &&
      this.currentState.readiness === "ready" &&
      this.currentState.interaction === "NONE" &&
      this.interactionResponse === undefined &&
      !this.currentState.isDragging &&
      !this.hasActiveHomeCycle() &&
      !this.currentState.homePending &&
      this.currentState.behavior === "IDLE" &&
      this.currentState.visualTransition === "NONE" &&
      this.blockedAvoidanceSignature === undefined
    );
  }

  private clearBlinkTimer(): void {
    if (this.blinkTimer === undefined) {
      return;
    }

    this.clock.clearTimeout(this.blinkTimer);
    this.blinkTimer = undefined;
  }

  private clearAutonomousTimer(): void {
    if (this.autonomousTimer === undefined) {
      return;
    }

    this.clock.clearTimeout(this.autonomousTimer);
    this.autonomousTimer = undefined;
  }

  private clearWalkTimer(): void {
    if (this.walkTimer === undefined) {
      return;
    }

    this.clock.clearTimeout(this.walkTimer);
    this.walkTimer = undefined;
  }

  private clearFallTimer(): void {
    if (this.fallTimer === undefined) {
      return;
    }

    this.clock.clearTimeout(this.fallTimer);
    this.fallTimer = undefined;
  }

  private clearLookExitTimer(): void {
    if (this.lookExitTimer === undefined) {
      return;
    }

    this.clock.clearTimeout(this.lookExitTimer);
    this.lookExitTimer = undefined;
  }

  /**
   * Clears every behavior timer family at once. Each behavior owns one timer,
   * so ending any behavior must clear all of them: a surviving callback would
   * otherwise drive a behavior that has already been left behind.
   */
  private clearBehaviorTimers(): void {
    this.clearAutonomousTimer();
    this.clearWalkTimer();
    this.clearFallTimer();
    this.clearBlinkTimer();
    this.clearLookExitTimer();
  }

  /** Ends every active behavior object together with its timers. */
  private resetActiveBehavior(): void {
    this.cancelInteractionResponse(true);
    this.cancelParachute();
    this.clearBehaviorTimers();
    this.activeWalk = undefined;
    this.activeTurn = undefined;
    this.activeFall = undefined;
  }
}
