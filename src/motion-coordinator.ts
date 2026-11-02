import type { WindowTopLeftLogical } from "./native-motion";

export type MotionOwner =
  | "AUTONOMOUS"
  | "INPUT_AVOIDANCE"
  | "FALL"
  | "DRAG"
  | "RECOVERY";

const motionLeaseBrand: unique symbol = Symbol("MotionLease");

export type MotionLease = Readonly<{
  epoch: number;
  owner: MotionOwner;
  readonly [motionLeaseBrand]: true;
}>;

export type MotionCommand = Readonly<{
  epoch: number;
  owner: MotionOwner;
  windowTopLeft: WindowTopLeftLogical;
}>;

export type MotionCommandWriter = (command: MotionCommand) => Promise<void>;

export type MotionWriteRejection = Readonly<{
  command: MotionCommand;
  error: unknown;
  isCurrentEpoch: boolean;
  isStaleEpoch: boolean;
}>;

export type MotionRejectionHandler = (rejection: MotionWriteRejection) => void;

const MOTION_OWNERS: readonly MotionOwner[] = [
  "AUTONOMOUS",
  "INPUT_AVOIDANCE",
  "FALL",
  "DRAG",
  "RECOVERY",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMotionOwner(value: unknown): value is MotionOwner {
  return typeof value === "string" && MOTION_OWNERS.includes(value as MotionOwner);
}

function isWindowTopLeftLogical(value: unknown): value is WindowTopLeftLogical {
  return (
    isRecord(value) &&
    value.space === "WINDOW_TOP_LEFT_LOGICAL" &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y)
  );
}

function copyWindowTopLeft(
  windowTopLeft: WindowTopLeftLogical,
): WindowTopLeftLogical {
  return Object.freeze({
    space: "WINDOW_TOP_LEFT_LOGICAL" as const,
    x: windowTopLeft.x,
    y: windowTopLeft.y,
  });
}

/**
 * Serializes all pet-window motion commands. The injected writer is the only
 * lower-level boundary; this coordinator neither imports nor calls Native APIs.
 */
export class MotionCoordinator {
  private epoch = 0;
  private activeLease: MotionLease | undefined;
  private authoritativeWindowTopLeft: WindowTopLeftLogical | undefined;
  private queuedCommand: MotionCommand | undefined;
  private inFlightCommand: MotionCommand | undefined;
  private disposed = false;
  private drainWaiters: Array<() => void> = [];

  constructor(
    private readonly writer: MotionCommandWriter,
    private readonly onRejected: MotionRejectionHandler = () => undefined,
  ) {}

  invalidateAndAcquire(
    owner: MotionOwner,
    authoritativeWindowTopLeft: WindowTopLeftLogical,
  ): MotionLease {
    if (this.disposed) {
      throw new Error("MotionCoordinator has been disposed.");
    }
    if (!isMotionOwner(owner) || !isWindowTopLeftLogical(authoritativeWindowTopLeft)) {
      throw new TypeError("Motion coordination requires a finite logical window top-left.");
    }

    this.epoch += 1;
    const lease = Object.freeze({
      epoch: this.epoch,
      owner,
      [motionLeaseBrand]: true,
    }) as MotionLease;

    this.activeLease = lease;
    this.authoritativeWindowTopLeft = copyWindowTopLeft(authoritativeWindowTopLeft);
    this.queuedCommand = undefined;
    this.enqueueAuthoritativePosition();

    return lease;
  }

  request(lease: MotionLease, windowTopLeft: WindowTopLeftLogical): void {
    if (
      this.disposed ||
      !this.isCurrentLease(lease) ||
      !isWindowTopLeftLogical(windowTopLeft)
    ) {
      return;
    }

    this.authoritativeWindowTopLeft = copyWindowTopLeft(windowTopLeft);
    this.enqueueAuthoritativePosition();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.epoch += 1;
    this.activeLease = undefined;
    this.authoritativeWindowTopLeft = undefined;
    this.queuedCommand = undefined;
  }

  /** Invalidate queued motion and wait for the one native write already sent. */
  async quiesce(): Promise<void> {
    this.epoch += 1;
    this.activeLease = undefined;
    this.authoritativeWindowTopLeft = undefined;
    this.queuedCommand = undefined;
    if (this.inFlightCommand) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
  }

  private isCurrentLease(lease: MotionLease): boolean {
    return (
      lease === this.activeLease &&
      lease.epoch === this.epoch &&
      lease.owner === this.activeLease?.owner
    );
  }

  private enqueueAuthoritativePosition(): void {
    if (!this.activeLease || !this.authoritativeWindowTopLeft) {
      return;
    }

    this.queuedCommand = Object.freeze({
      epoch: this.activeLease.epoch,
      owner: this.activeLease.owner,
      windowTopLeft: copyWindowTopLeft(this.authoritativeWindowTopLeft),
    });
    this.pump();
  }

  private pump(): void {
    if (this.disposed || this.inFlightCommand || !this.queuedCommand) {
      return;
    }

    const command = this.queuedCommand;
    this.queuedCommand = undefined;
    this.inFlightCommand = command;

    try {
      Promise.resolve(this.writer(command)).then(
        () => this.complete(command, false),
        (error: unknown) => this.complete(command, true, error),
      );
    } catch (error) {
      this.complete(command, true, error);
    }
  }

  private complete(
    command: MotionCommand,
    failed: boolean,
    error: unknown = undefined,
  ): void {
    if (this.inFlightCommand !== command) {
      return;
    }

    this.inFlightCommand = undefined;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
    const isCurrentEpoch =
      !this.disposed &&
      this.activeLease !== undefined &&
      command.epoch === this.activeLease.epoch;

    if (failed && !this.disposed) {
      try {
        this.onRejected({
          command,
          error,
          isCurrentEpoch,
          isStaleEpoch: !isCurrentEpoch,
        });
      } catch (observerError) {
        // A rejection observer cannot gain a writer retry path from this core,
        // but swallowing it silently would hide a broken recovery path.
        console.error(
          "[LineDog Motion Coordinator] rejection observer threw.",
          observerError,
        );
      }
    }

    if (this.disposed) {
      return;
    }

    if (
      command.epoch !== this.epoch &&
      !this.queuedCommand &&
      !this.inFlightCommand
    ) {
      this.enqueueAuthoritativePosition();
    }

    this.pump();
  }
}
