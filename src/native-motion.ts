import {
  systemTimelineClock,
  type TimelineClock,
} from "./animation-timeline";

export const WINDOW_POSITION_COMMAND_INTERVAL_MS = 1000 / 30;

export type LogicalPoint = Readonly<{ x: number; y: number }>;
export type PhysicalPoint = Readonly<{ x: number; y: number }>;
export type PhysicalSize = Readonly<{ width: number; height: number }>;
export type LogicalWorkArea = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export interface NativeMonitorFacts {
  readonly name: string | null;
  readonly scaleFactor: number;
  readonly workArea: Readonly<{
    position: PhysicalPoint;
    size: PhysicalSize;
  }>;
}

export interface MotionSnapshot {
  readonly currentMonitorId: string;
  readonly workArea: LogicalWorkArea;
  readonly windowPosition: LogicalPoint;
}

export interface CurrentWorkAreaSnapshot {
  readonly currentMonitorId: string;
  readonly workArea: LogicalWorkArea;
}

export interface PetMotionPort {
  resync(): Promise<MotionSnapshot | null>;
  readCurrentWorkArea?(): Promise<CurrentWorkAreaSnapshot | null>;
  requestPosition(position: LogicalPoint): void;
  stop(): void;
}

export interface NativeWindowMotionApi {
  currentMonitor(): Promise<NativeMonitorFacts | null>;
  outerPosition(): Promise<PhysicalPoint>;
  scaleFactor(): Promise<number>;
  setPosition(position: LogicalPoint): Promise<void>;
}

export type NativeMotionErrorReporter = (
  operation: string,
  error: unknown,
) => void;

export interface NativeWindowMotionAdapterOptions {
  readonly clock?: TimelineClock;
  readonly reportError?: NativeMotionErrorReporter;
}

function assertValidScaleFactor(scaleFactor: number, label: string): void {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new Error(`${label} must be a finite value greater than zero.`);
  }
}

function assertFinitePosition(position: LogicalPoint): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new Error("LineDog window position must use finite logical coordinates.");
  }
}

export function physicalToLogicalPoint(
  point: PhysicalPoint,
  scaleFactor: number,
): LogicalPoint {
  assertValidScaleFactor(scaleFactor, "The scale factor");

  return {
    x: point.x / scaleFactor,
    y: point.y / scaleFactor,
  };
}

export function physicalToLogicalWorkArea(
  monitor: NativeMonitorFacts,
): LogicalWorkArea {
  assertValidScaleFactor(monitor.scaleFactor, "The monitor scale factor");

  return {
    x: monitor.workArea.position.x / monitor.scaleFactor,
    y: monitor.workArea.position.y / monitor.scaleFactor,
    width: monitor.workArea.size.width / monitor.scaleFactor,
    height: monitor.workArea.size.height / monitor.scaleFactor,
  };
}

export function createMotionSnapshot(
  monitor: NativeMonitorFacts,
  windowOuterPosition: PhysicalPoint,
  windowScaleFactor: number,
): MotionSnapshot {
  const currentWorkArea = createCurrentWorkAreaSnapshot(monitor);
  const windowPosition = physicalToLogicalPoint(
    windowOuterPosition,
    windowScaleFactor,
  );

  return {
    ...currentWorkArea,
    windowPosition,
  };
}

export function createCurrentWorkAreaSnapshot(
  monitor: NativeMonitorFacts,
): CurrentWorkAreaSnapshot {
  return {
    currentMonitorId:
      monitor.name ??
      `${monitor.workArea.position.x}:${monitor.workArea.position.y}:${monitor.workArea.size.width}:${monitor.workArea.size.height}`,
    workArea: physicalToLogicalWorkArea(monitor),
  };
}

function createOnceMotionErrorReporter(): NativeMotionErrorReporter {
  const reportedOperations = new Set<string>();

  return (operation, error) => {
    if (reportedOperations.has(operation)) {
      return;
    }

    reportedOperations.add(operation);
    console.warn(`[LineDog Native Motion] ${operation} failed.`, error);
  };
}

export class NativeWindowMotionAdapter implements PetMotionPort {
  private readonly clock: TimelineClock;
  private readonly reportError: NativeMotionErrorReporter;
  private pendingPosition: LogicalPoint | undefined;
  private writeTimer: unknown | undefined;
  private inFlightWrite: Promise<void> | undefined;
  private lastWriteAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly nativeWindow: NativeWindowMotionApi,
    options: NativeWindowMotionAdapterOptions = {},
  ) {
    this.clock = options.clock ?? systemTimelineClock;
    this.reportError = options.reportError ?? createOnceMotionErrorReporter();
  }

  async resync(): Promise<MotionSnapshot | null> {
    this.stop();

    if (this.inFlightWrite) {
      await this.inFlightWrite;
    }

    try {
      const [monitor, windowOuterPosition, windowScaleFactor] = await Promise.all([
        this.nativeWindow.currentMonitor(),
        this.nativeWindow.outerPosition(),
        this.nativeWindow.scaleFactor(),
      ]);

      if (!monitor) {
        this.reportError(
          "current monitor",
          new Error("LineDog could not identify the current monitor."),
        );
        return null;
      }

      return createMotionSnapshot(monitor, windowOuterPosition, windowScaleFactor);
    } catch (error) {
      this.reportError("window motion synchronization", error);
      return null;
    }
  }

  async readCurrentWorkArea(): Promise<CurrentWorkAreaSnapshot | null> {
    try {
      const monitor = await this.nativeWindow.currentMonitor();

      if (!monitor) {
        this.reportError(
          "current monitor",
          new Error("LineDog could not identify the current monitor."),
        );
        return null;
      }

      return createCurrentWorkAreaSnapshot(monitor);
    } catch (error) {
      this.reportError("current monitor facts", error);
      return null;
    }
  }

  requestPosition(position: LogicalPoint): void {
    try {
      assertFinitePosition(position);
    } catch (error) {
      this.reportError("window position request", error);
      return;
    }

    this.pendingPosition = { ...position };
    this.scheduleWrite();
  }

  stop(): void {
    this.pendingPosition = undefined;

    if (this.writeTimer !== undefined) {
      this.clock.clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
  }

  dispose(): void {
    this.stop();
  }

  private scheduleWrite(): void {
    if (
      this.pendingPosition === undefined ||
      this.inFlightWrite !== undefined ||
      this.writeTimer !== undefined
    ) {
      return;
    }

    const elapsedSincePreviousWrite = this.clock.now() - this.lastWriteAtMs;
    const delayMs = Math.max(
      0,
      WINDOW_POSITION_COMMAND_INTERVAL_MS - elapsedSincePreviousWrite,
    );

    this.writeTimer = this.clock.setTimeout(() => {
      this.writeTimer = undefined;
      void this.flushWrite();
    }, delayMs);
  }

  private async flushWrite(): Promise<void> {
    if (this.inFlightWrite !== undefined || this.pendingPosition === undefined) {
      return;
    }

    const targetPosition = this.pendingPosition;
    this.pendingPosition = undefined;
    this.lastWriteAtMs = this.clock.now();

    const write = Promise.resolve().then(() =>
      this.nativeWindow.setPosition(targetPosition),
    );
    this.inFlightWrite = write;

    try {
      await write;
    } catch (error) {
      this.reportError("set window position", error);
    } finally {
      if (this.inFlightWrite === write) {
        this.inFlightWrite = undefined;
      }

      this.scheduleWrite();
    }
  }
}
