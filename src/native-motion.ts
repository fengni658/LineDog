import {
  systemTimelineClock,
  type TimelineClock,
} from "./animation-timeline";
import {
  type NativeDesktopSnapshotV1,
  type NativeHomeWindowSnapshot,
  type NativeLogicalPoint,
  type NativeLogicalRect,
  type NativePlatformPort,
  type NativeSetOverlayPositionArgs,
  type NativeWindowTopLeftLogical,
} from "./native-platform";

export const WINDOW_POSITION_COMMAND_INTERVAL_MS = 1000 / 30;

export type LogicalPoint = NativeLogicalPoint;
export type LogicalWorkArea = NativeLogicalRect;
export type WindowTopLeftLogical = NativeWindowTopLeftLogical;

export interface MotionSnapshot {
  readonly snapshotRevision?: number;
  readonly monitorScaleFactor?: number;
  readonly homeWindow?: NativeHomeWindowSnapshot | null;
  readonly currentMonitorId: string;
  readonly windowScaleFactor: number;
  readonly workArea: LogicalWorkArea;
  /** Outer-window position expressed in the coordinator's only input space. */
  readonly windowPosition: WindowTopLeftLogical;
}

export interface CurrentWorkAreaSnapshot {
  readonly snapshotRevision?: number;
  readonly windowScaleFactor?: number;
  readonly monitorScaleFactor?: number;
  readonly homeWindow?: NativeHomeWindowSnapshot | null;
  readonly currentMonitorId: string;
  readonly workArea: LogicalWorkArea;
}

export interface PetMotionPort {
  resync(): Promise<MotionSnapshot | null>;
  readCurrentWorkArea?(): Promise<CurrentWorkAreaSnapshot | null>;
  dispose?(): void;
  /**
   * The sole low-level writer used by MotionCoordinator. Its Promise resolves
   * only after the throttled native write completes, or rejects on failure.
   */
  writeWindowTopLeft(position: WindowTopLeftLogical): Promise<void>;
}

/** The frozen platform subset consumed by the high-level motion adapter. */
export type NativeWindowMotionApi = Pick<
  NativePlatformPort,
  "desktopSnapshot" | "setOverlayPosition"
>;

export type NativeMotionErrorReporter = (
  operation: string,
  error: unknown,
) => void;

export interface NativeWindowMotionAdapterOptions {
  readonly clock?: TimelineClock;
  readonly reportError?: NativeMotionErrorReporter;
}

export function createMotionSnapshot(
  snapshot: NativeDesktopSnapshotV1,
): MotionSnapshot {
  return {
    snapshotRevision: snapshot.snapshotRevision,
    monitorScaleFactor: snapshot.monitorScaleFactor,
    homeWindow: snapshot.homeWindow ? { ...snapshot.homeWindow, rect: { ...snapshot.homeWindow.rect } } : null,
    currentMonitorId: snapshot.currentMonitorId,
    workArea: { ...snapshot.workArea },
    windowPosition: { ...snapshot.windowPosition },
    windowScaleFactor: snapshot.windowScaleFactor,
  };
}

export function createCurrentWorkAreaSnapshot(
  snapshot: NativeDesktopSnapshotV1,
): CurrentWorkAreaSnapshot {
  return {
    snapshotRevision: snapshot.snapshotRevision,
    windowScaleFactor: snapshot.windowScaleFactor,
    monitorScaleFactor: snapshot.monitorScaleFactor,
    homeWindow: snapshot.homeWindow ? { ...snapshot.homeWindow, rect: { ...snapshot.homeWindow.rect } } : null,
    currentMonitorId: snapshot.currentMonitorId,
    workArea: { ...snapshot.workArea },
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
  private lastWriteAtMs = Number.NEGATIVE_INFINITY;
  private disposed = false;
  private coordinateScaleFactor: number | undefined;

  constructor(
    private readonly nativeWindow: NativeWindowMotionApi,
    options: NativeWindowMotionAdapterOptions = {},
  ) {
    this.clock = options.clock ?? systemTimelineClock;
    this.reportError = options.reportError ?? createOnceMotionErrorReporter();
  }

  async resync(): Promise<MotionSnapshot | null> {
    try {
      const snapshot = await this.nativeWindow.desktopSnapshot();
      this.acceptDesktopSnapshot(snapshot);
      return createMotionSnapshot(snapshot);
    } catch (error) {
      this.reportError("window motion synchronization", error);
      return null;
    }
  }

  /** Call only when Runtime adopts coordinates from this snapshot. */
  acceptDesktopSnapshot(snapshot: Pick<MotionSnapshot, "windowScaleFactor">): void {
    if (this.disposed) return;
    if (!Number.isFinite(snapshot.windowScaleFactor) || snapshot.windowScaleFactor <= 0) {
      throw new Error("LineDog accepted motion snapshot scale must be positive and finite.");
    }
    this.coordinateScaleFactor = snapshot.windowScaleFactor;
  }

  async readCurrentWorkArea(): Promise<CurrentWorkAreaSnapshot | null> {
    try {
      return createCurrentWorkAreaSnapshot(
        await this.nativeWindow.desktopSnapshot(),
      );
    } catch (error) {
      this.reportError("current monitor facts", error);
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  async writeWindowTopLeft(position: WindowTopLeftLogical): Promise<void> {
    if (this.disposed) {
      throw new Error("LineDog native motion adapter has been disposed.");
    }

    if (
      position.space !== "WINDOW_TOP_LEFT_LOGICAL" ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y)
    ) {
      const error = new Error(
        "LineDog window position must use finite logical top-left coordinates.",
      );
      this.reportError("window position request", error);
      throw error;
    }

    // A Runtime rebase may occur while this write waits for the throttle.
    // Its already supplied coordinates must retain their original scale.
    const coordinateScaleFactor = this.coordinateScaleFactor;

    const elapsedSincePreviousWrite = this.clock.now() - this.lastWriteAtMs;
    const delayMs = Math.max(
      0,
      WINDOW_POSITION_COMMAND_INTERVAL_MS - elapsedSincePreviousWrite,
    );
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        this.clock.setTimeout(resolve, delayMs);
      });
    }

    if (this.disposed) {
      throw new Error("LineDog native motion adapter has been disposed.");
    }

    this.lastWriteAtMs = this.clock.now();
    const positionRequest: NativeSetOverlayPositionArgs = {
      windowLabel: "main",
      x: position.x,
      y: position.y,
      ...(coordinateScaleFactor === undefined ? {} : { coordinateScaleFactor }),
    };
    try {
      await this.nativeWindow.setOverlayPosition(positionRequest);
    } catch (error) {
      this.reportError("set window position", error);
      throw error;
    }
  }
}
