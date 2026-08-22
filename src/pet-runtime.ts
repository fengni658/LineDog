import {
  AnimationTimeline,
  systemTimelineClock,
  type TimelineClock,
  type TimelineFrameEvent,
} from "./animation-timeline";
import type {
  LogicalPoint,
  LogicalWorkArea,
  MotionSnapshot,
  PetMotionPort,
} from "./native-motion";
import type { DefaultRuntimeResources } from "./pet-manifest";
import {
  RUNTIME_VIEWPORT_SIZE,
  preloadRuntimeFrames,
  type ImageLoader,
} from "./sprite-renderer";

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
  fall: {
    gravityLogicalPxPerSecondSquared: 1_800,
    maxSpeedLogicalPxPerSecond: 1_200,
  },
  land: {
    durationMs: 250,
  },
} as const;

export const IDLE_OR_PAUSE_WEIGHT = 0.65;
export const DIRECT_INTERACTION_STOP_MAX_MS = 200;
export const WALK_MOTION_TICK_MS = 1000 / 30;
export const FALL_MOTION_TICK_MS = 1000 / 30;
export const MAX_FALL_PHYSICS_DELTA_MS = 100;
export const FALL_WORK_AREA_REFRESH_INTERVAL_MS = 250;
export const RUNTIME_FOOT_BASELINE_LOGICAL_PX = 140;
export const TURN_FACING_MIDPOINT_FRAME_INDEX = 2;

export type PetBehaviorState =
  | "IDLE"
  | "WALK"
  | "LOOK"
  | "HAPPY"
  | "DRAG"
  | "FALL"
  | "LAND";

export type PetAnimationLayer = "BASE" | "BLINK";
export type Facing = "Left" | "Right";
export type PetVisualTransition = "NONE" | "TURN";
export type AutonomousAction = "PAUSE" | "WALK";
export type PointerInteractionState = "NONE" | "ARMED" | "DRAG";

export interface PetRuntimeState {
  readonly readiness: "loading" | "ready" | "failed";
  readonly behavior: PetBehaviorState;
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
  readonly logicalPosition?: LogicalPoint;
  readonly verticalVelocityLogicalPxPerSecond?: number;
  readonly groundTopY?: number;
}

export interface PetRuntimeOptions {
  readonly clock?: TimelineClock;
  readonly random?: () => number;
  readonly motionPort?: PetMotionPort;
  readonly onFrame?: (event: TimelineFrameEvent) => void;
  readonly onStateChange?: (state: Readonly<PetRuntimeState>) => void;
}

type ActiveWalk = {
  readonly revision: number;
  readonly endsAtMs: number;
  readonly speedLogicalPxPerSecond: number;
  readonly facing: Facing;
  readonly workArea: MotionSnapshot["workArea"];
  position: LogicalPoint;
  lastStepAtMs: number;
};

type PendingWalk = {
  readonly revision: number;
  readonly durationMs: number;
  readonly speedLogicalPxPerSecond: number;
  readonly facing: Facing;
  readonly currentMonitorId: string;
  readonly workArea: MotionSnapshot["workArea"];
  readonly position: LogicalPoint;
};

type ActiveTurn = {
  readonly revision: number;
  readonly targetFacing: Facing;
  readonly frameMirrored: boolean;
  readonly pendingWalk: PendingWalk;
  facingSwitched: boolean;
};

type ActiveFall = {
  revision: number;
  currentMonitorId: string;
  workArea: LogicalWorkArea;
  position: LogicalPoint;
  verticalVelocityLogicalPxPerSecond: number;
  lastStepAtMs: number;
  nextWorkAreaRefreshAtMs: number;
};

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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function groundY(workArea: MotionSnapshot["workArea"]): number {
  return workArea.y + workArea.height - RUNTIME_VIEWPORT_SIZE;
}

export function getGroundWindowTopY(workArea: LogicalWorkArea): number {
  return workArea.y + workArea.height - RUNTIME_FOOT_BASELINE_LOGICAL_PX;
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

function clampToWorkArea(
  position: LogicalPoint,
  workArea: MotionSnapshot["workArea"],
): LogicalPoint {
  const minimumX = workArea.x;
  const maximumX = Math.max(
    minimumX,
    workArea.x + workArea.width - RUNTIME_VIEWPORT_SIZE,
  );

  return {
    x: clamp(position.x, minimumX, maximumX),
    y: groundY(workArea),
  };
}

function clampWindowToWorkArea(
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

function clampFallPosition(
  position: LogicalPoint,
  workArea: LogicalWorkArea,
): LogicalPoint {
  const minimumX = workArea.x;
  const maximumX = Math.max(
    minimumX,
    workArea.x + workArea.width - RUNTIME_VIEWPORT_SIZE,
  );

  return {
    x: clamp(position.x, minimumX, maximumX),
    y: position.y,
  };
}

function distanceFromPetCenter(point: LogicalPoint): number {
  return Math.hypot(point.x - RUNTIME_VIEWPORT_SIZE / 2, point.y - RUNTIME_VIEWPORT_SIZE / 2);
}

export class PetRuntime {
  private readonly clock: TimelineClock;
  private readonly timeline: AnimationTimeline;
  private readonly random: () => number;
  private readonly onFrame: (event: TimelineFrameEvent) => void;
  private readonly onStateChange: (state: Readonly<PetRuntimeState>) => void;
  private readonly motionPort: PetMotionPort | undefined;
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
  private armedPhysicalBehavior: "FALL" | "LAND" | undefined;
  private landCompletionPending = false;
  private currentState: PetRuntimeState = {
    readiness: "loading",
    behavior: "IDLE",
    animationLayer: "BASE",
    activeAnimationId: "idle",
    facing: "Right",
    visualTransition: "NONE",
    interaction: "NONE",
    isDragging: false,
    pointerNearby: false,
  };

  constructor(
    private readonly resources: DefaultRuntimeResources,
    options: PetRuntimeOptions = {},
  ) {
    this.clock = options.clock ?? systemTimelineClock;
    this.timeline = new AnimationTimeline(this.clock);
    this.random = options.random ?? Math.random;
    this.onFrame = options.onFrame ?? (() => undefined);
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.motionPort = options.motionPort;
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

  async initialize(loadImage: ImageLoader): Promise<void> {
    if (this.currentState.readiness === "ready") {
      return;
    }

    try {
      await preloadRuntimeFrames(this.resources, loadImage);
      this.updateState({ readiness: "ready" });
      this.playIdle();
      this.scheduleBlink();
      this.scheduleIdleInterval();
    } catch (error) {
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
      onFrame: this.onFrame,
      onComplete: () => {
        if (
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

  beginPointerGesture(): boolean {
    if (
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE"
    ) {
      return false;
    }

    const preservesPhysicalState =
      this.currentState.behavior === "FALL" ||
      this.currentState.behavior === "LAND";
    this.armedPhysicalBehavior =
      this.currentState.behavior === "FALL" ||
      this.currentState.behavior === "LAND"
        ? this.currentState.behavior
        : undefined;

    if (!preservesPhysicalState) {
      this.stopForDirectInteraction();
      this.playIdle();
    }

    this.updateState({
      interaction: "ARMED",
      isDragging: false,
    });
    return true;
  }

  promotePointerGestureToDrag(): boolean {
    if (
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "ARMED"
    ) {
      return false;
    }

    this.armedPhysicalBehavior = undefined;
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
    this.timeline.play(this.resources.drag, {
      onFrame: this.onFrame,
      onComplete: () => undefined,
    });
    return true;
  }

  movePointerDrag(
    position: LogicalPoint,
    currentMonitorId: string,
    workArea: MotionSnapshot["workArea"],
  ): boolean {
    if (this.currentState.interaction !== "DRAG") {
      return false;
    }

    const clampedPosition = clampWindowToWorkArea(position, workArea);
    this.updateState({
      currentMonitorId,
      logicalPosition: clampedPosition,
    });
    this.motionPort?.requestPosition(clampedPosition);
    return true;
  }

  async endPointerGesture(options: {
    readonly triggerHappy: boolean;
  }): Promise<boolean> {
    const interaction = this.currentState.interaction;

    if (interaction === "NONE") {
      return false;
    }

    const preservedPhysicalBehavior =
      interaction === "ARMED" ? this.armedPhysicalBehavior : undefined;
    const preservesPhysicalState = preservedPhysicalBehavior !== undefined;
    const interactionRevision = preservesPhysicalState
      ? this.behaviorRevision
      : this.behaviorRevision + 1;

    if (!preservesPhysicalState) {
      this.behaviorRevision = interactionRevision;
    }

    if (!preservesPhysicalState) {
      this.clearAutonomousTimer();
      this.clearWalkTimer();
      this.clearFallTimer();
      this.clearBlinkTimer();
      this.clearLookExitTimer();
      this.activeWalk = undefined;
      this.activeFall = undefined;
    }

    this.motionPort?.stop();

    const snapshot = await this.motionPort?.resync();

    if (
      interactionRevision !== this.behaviorRevision ||
      this.currentState.interaction !== interaction
    ) {
      return false;
    }

    if (interaction === "DRAG") {
      this.armedPhysicalBehavior = undefined;
      this.updateState({ interaction: "NONE", isDragging: false });

      if (snapshot) {
        this.startFall(snapshot, interactionRevision);
        return false;
      }

      this.playIdle();
      this.scheduleBlink();
      this.scheduleIdleInterval();
      return false;
    }

    if (preservesPhysicalState) {
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
      this.armedPhysicalBehavior = undefined;

      if (this.currentState.behavior === "FALL") {
        this.clearFallTimer();
        this.scheduleFallTick(interactionRevision);
      } else if (
        this.currentState.behavior === "LAND" &&
        this.landCompletionPending
      ) {
        this.finishLand(interactionRevision);
      }

      return false;
    }

    if (snapshot) {
      this.applyMotionSnapshot(snapshot);
    }

    this.updateState({ interaction: "NONE", isDragging: false });
    this.armedPhysicalBehavior = undefined;

    if (interaction === "ARMED" && options.triggerHappy) {
      return this.triggerHappy();
    }

    this.playIdle();
    this.scheduleBlink();
    this.scheduleIdleInterval();
    return false;
  }

  handlePointerSample(point: LogicalPoint): void {
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
      this.currentState.behavior === "HAPPY" ||
      this.currentState.behavior === "DRAG"
    ) {
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
    if (
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE" ||
      this.currentState.behavior === "HAPPY" ||
      this.currentState.behavior === "FALL" ||
      this.currentState.behavior === "LAND"
    ) {
      return false;
    }

    this.stopForDirectInteraction();
    this.updateState({
      behavior: "HAPPY",
      animationLayer: "BASE",
      activeAnimationId: this.resources.happy.animationId,
    });
    this.timeline.play(this.resources.happy, {
      onFrame: this.onFrame,
      onComplete: () => {
        if (
          this.currentState.behavior !== "HAPPY" ||
          this.currentState.interaction !== "NONE"
        ) {
          return;
        }

        const pointer = this.currentState.pointerLogicalPosition;
        if (this.currentState.pointerNearby && pointer) {
          this.startLook(pointer);
          return;
        }

        this.playIdle();
        this.scheduleBlink();
        this.scheduleIdleInterval();
      },
    });
    return true;
  }

  dispose(): void {
    this.behaviorRevision += 1;
    this.clearBlinkTimer();
    this.clearAutonomousTimer();
    this.clearWalkTimer();
    this.clearFallTimer();
    this.clearLookExitTimer();
    this.activeWalk = undefined;
    this.activeTurn = undefined;
    this.activeFall = undefined;
    this.armedPhysicalBehavior = undefined;
    this.landCompletionPending = false;
    this.timeline.stop();
    this.motionPort?.stop();
  }

  private updateState(update: Partial<PetRuntimeState>): void {
    this.currentState = { ...this.currentState, ...update };
    this.onStateChange(this.state);
  }

  private playIdle(): void {
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
    this.timeline.play(this.resources.idle, {
      onFrame: this.onFrame,
      onComplete: () => undefined,
    });
  }

  private scheduleBlink(): void {
    this.clearBlinkTimer();

    if (
      this.currentState.readiness !== "ready" ||
      this.currentState.interaction !== "NONE" ||
      this.currentState.isDragging ||
      this.currentState.behavior !== "IDLE" ||
      this.currentState.visualTransition !== "NONE" ||
      this.currentState.animationLayer !== "BASE"
    ) {
      return;
    }

    this.blinkTimer = this.clock.setTimeout(() => {
      this.blinkTimer = undefined;
      this.triggerBlink();
    }, sampleBlinkDelayMs(this.random));
  }

  private scheduleIdleInterval(): void {
    this.clearAutonomousTimer();

    if (!this.canScheduleAutonomousAction()) {
      return;
    }

    const revision = this.behaviorRevision;
    this.autonomousTimer = this.clock.setTimeout(() => {
      this.autonomousTimer = undefined;
      if (revision !== this.behaviorRevision || !this.canScheduleAutonomousAction()) {
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
      const revision = this.behaviorRevision;
      this.autonomousTimer = this.clock.setTimeout(() => {
        this.autonomousTimer = undefined;
        if (revision !== this.behaviorRevision || !this.canScheduleAutonomousAction()) {
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
    void this.startWalk(revision, durationMs, speedLogicalPxPerSecond, facing);
  }

  private async startWalk(
    revision: number,
    durationMs: number,
    speedLogicalPxPerSecond: number,
    facing: Facing,
  ): Promise<void> {
    if (!this.motionPort) {
      if (revision === this.behaviorRevision) {
        this.scheduleIdleInterval();
      }
      return;
    }

    const snapshot = await this.motionPort.resync();

    if (
      !snapshot ||
      revision !== this.behaviorRevision ||
      !this.canScheduleAutonomousAction()
    ) {
      if (revision === this.behaviorRevision && this.canScheduleAutonomousAction()) {
        this.scheduleIdleInterval();
      }
      return;
    }

    const initialPosition = clampToWorkArea(snapshot.windowPosition, snapshot.workArea);
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
      pendingWalk.revision !== this.behaviorRevision ||
      this.currentState.interaction !== "NONE" ||
      this.currentState.isDragging
    ) {
      return;
    }

    this.clearBlinkTimer();
    this.timeline.stop();
    this.activeWalk = {
      revision: pendingWalk.revision,
      endsAtMs: this.clock.now() + pendingWalk.durationMs,
      speedLogicalPxPerSecond: pendingWalk.speedLogicalPxPerSecond,
      facing: pendingWalk.facing,
      workArea: pendingWalk.workArea,
      position: pendingWalk.position,
      lastStepAtMs: this.clock.now(),
    };
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
    });
    this.timeline.play(this.resources.walk, {
      onFrame: this.onFrame,
      onComplete: () => undefined,
    });
    this.motionPort?.requestPosition(pendingWalk.position);
    this.scheduleWalkTick(pendingWalk.revision);
  }

  private startTurn(pendingWalk: PendingWalk): void {
    const turn = this.resources.turn;

    if (!turn) {
      this.playIdle();
      this.scheduleBlink();
      this.scheduleIdleInterval();
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

        this.onFrame(event);
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
    this.walkTimer = this.clock.setTimeout(() => {
      this.walkTimer = undefined;
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

    const currentTimeMs = Math.min(this.clock.now(), activeWalk.endsAtMs);
    const elapsedMs = Math.max(0, currentTimeMs - activeWalk.lastStepAtMs);
    const direction = activeWalk.facing === "Right" ? 1 : -1;
    const proposedX =
      activeWalk.position.x +
      (direction * activeWalk.speedLogicalPxPerSecond * elapsedMs) / 1_000;
    const nextPosition = clampToWorkArea(
      { x: proposedX, y: activeWalk.position.y },
      activeWalk.workArea,
    );
    const hitBoundary = Math.abs(nextPosition.x - proposedX) > 0.000_001;

    activeWalk.position = nextPosition;
    activeWalk.lastStepAtMs = currentTimeMs;
    this.updateState({ logicalPosition: nextPosition });
    this.motionPort?.requestPosition(nextPosition);

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
    this.playIdle();
    this.scheduleBlink();
    this.scheduleIdleInterval();
  }

  private startFall(snapshot: MotionSnapshot, revision: number): void {
    const position = clampFallPosition(snapshot.windowPosition, snapshot.workArea);
    const groundTopY = getGroundWindowTopY(snapshot.workArea);

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
    this.timeline.play(this.resources.fall, {
      onFrame: this.onFrame,
      onComplete: () => undefined,
    });
    this.motionPort?.requestPosition(position);
    this.scheduleFallTick(revision);
  }

  private scheduleFallTick(revision: number): void {
    const activeFall = this.activeFall;

    if (!activeFall || activeFall.revision !== revision) {
      return;
    }

    this.fallTimer = this.clock.setTimeout(() => {
      this.fallTimer = undefined;
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
    const step = integrateFallPhysicsStep(
      activeFall.position.y,
      activeFall.verticalVelocityLogicalPxPerSecond,
      currentTimeMs - activeFall.lastStepAtMs,
    );
    activeFall.position = {
      x: activeFall.position.x,
      y: step.positionY,
    };
    activeFall.verticalVelocityLogicalPxPerSecond =
      step.verticalVelocityLogicalPxPerSecond;
    activeFall.lastStepAtMs = currentTimeMs;

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
    this.motionPort?.requestPosition(activeFall.position);

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
    void motionPort
      .readCurrentWorkArea()
      .then((facts) => {
        const activeFall = this.activeFall;
        if (
          !facts ||
          !activeFall ||
          activeFall.revision !== revision ||
          revision !== this.behaviorRevision ||
          this.currentState.behavior !== "FALL"
        ) {
          return;
        }

        activeFall.currentMonitorId = facts.currentMonitorId;
        activeFall.workArea = facts.workArea;
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
        this.motionPort?.requestPosition(activeFall.position);
      })
      .catch(() => undefined)
      .finally(() => {
        this.fallWorkAreaRefreshInFlight = false;
      });
  }

  private applyFallSnapshot(snapshot: MotionSnapshot, revision: number): void {
    const activeFall = this.activeFall;

    if (!activeFall || activeFall.revision !== revision) {
      return;
    }

    activeFall.currentMonitorId = snapshot.currentMonitorId;
    activeFall.workArea = snapshot.workArea;
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

    this.updateState({
      currentMonitorId: snapshot.currentMonitorId,
      logicalPosition: activeFall.position,
      verticalVelocityLogicalPxPerSecond:
        activeFall.verticalVelocityLogicalPxPerSecond,
      groundTopY,
    });
    this.motionPort?.requestPosition(activeFall.position);
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

    this.clearFallTimer();
    this.activeFall = undefined;
    this.landCompletionPending = false;
    this.timeline.stop();
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
    this.motionPort?.requestPosition(landedPosition);
    this.timeline.play(this.resources.land, {
      onFrame: this.onFrame,
      onComplete: () => {
        if (
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

    this.landCompletionPending = false;
    this.playIdle();
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
      onFrame: this.onFrame,
      onComplete: () => undefined,
    });
  }

  private scheduleLookExit(): void {
    if (this.lookExitTimer !== undefined) {
      return;
    }

    const revision = this.behaviorRevision;
    this.lookExitTimer = this.clock.setTimeout(() => {
      this.lookExitTimer = undefined;
      if (
        revision !== this.behaviorRevision ||
        this.currentState.behavior !== "LOOK" ||
        this.currentState.interaction !== "NONE" ||
        this.currentState.pointerNearby
      ) {
        return;
      }

      this.timeline.stop();
      this.playIdle();
      this.scheduleBlink();
      this.scheduleIdleInterval();
    }, PET_BEHAVIOR_CONFIG.look.exitDelayMs);
  }

  private stopForDirectInteraction(): void {
    this.behaviorRevision += 1;
    this.clearAutonomousTimer();
    this.clearWalkTimer();
    this.clearFallTimer();
    this.clearBlinkTimer();
    this.clearLookExitTimer();
    this.activeWalk = undefined;
    this.activeTurn = undefined;
    this.activeFall = undefined;
    this.fallWorkAreaRefreshInFlight = false;
    this.landCompletionPending = false;
    if (this.currentState.visualTransition !== "NONE") {
      this.updateState({
        visualTransition: "NONE",
        turnTargetFacing: undefined,
        turnFrameMirrored: undefined,
      });
    }
    this.motionPort?.stop();
    this.timeline.stop();
  }

  private interruptAutonomousMovement(): void {
    this.stopForDirectInteraction();
    this.playIdle();
  }

  private applyMotionSnapshot(snapshot: MotionSnapshot): void {
    this.updateState({
      currentMonitorId: snapshot.currentMonitorId,
      logicalPosition: { ...snapshot.windowPosition },
    });
  }

  private canScheduleAutonomousAction(): boolean {
    return (
      this.currentState.readiness === "ready" &&
      this.currentState.interaction === "NONE" &&
      !this.currentState.isDragging &&
      this.currentState.behavior === "IDLE" &&
      this.currentState.visualTransition === "NONE"
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
}
