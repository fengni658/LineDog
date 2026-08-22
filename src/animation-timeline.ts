import type { RuntimeAnimation, RuntimeFrame } from "./pet-manifest";

export interface TimelineClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimelineClock: TimelineClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

export interface TimelineFrameEvent {
  readonly animationId: string;
  readonly frameIndex: number;
  readonly frame: RuntimeFrame;
  readonly timestampMs: number;
}

export interface TimelineCompletion {
  readonly animationId: string;
  readonly nextState: string;
}

export interface TimelineCallbacks {
  readonly onFrame: (event: TimelineFrameEvent) => void;
  readonly onComplete: (completion: TimelineCompletion) => void;
}

export class AnimationTimeline {
  private activeAnimation: RuntimeAnimation | undefined;
  private callbacks: TimelineCallbacks | undefined;
  private currentFrameIndex = 0;
  private timer: unknown | undefined;
  private playbackRevision = 0;

  constructor(private readonly clock: TimelineClock = systemTimelineClock) {}

  get isPlaying(): boolean {
    return this.activeAnimation !== undefined;
  }

  play(animation: RuntimeAnimation, callbacks: TimelineCallbacks): void {
    this.stop();
    this.activeAnimation = animation;
    this.callbacks = callbacks;
    this.currentFrameIndex = 0;
    this.playbackRevision += 1;
    this.emitCurrentFrame(this.playbackRevision);
  }

  stop(): void {
    this.playbackRevision += 1;

    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.activeAnimation = undefined;
    this.callbacks = undefined;
    this.currentFrameIndex = 0;
  }

  private emitCurrentFrame(revision: number): void {
    const animation = this.activeAnimation;
    const callbacks = this.callbacks;

    if (!animation || !callbacks || revision !== this.playbackRevision) {
      return;
    }

    const frame = animation.frames[this.currentFrameIndex];
    if (!frame) {
      throw new Error(`Animation ${animation.animationId} has no frame at the active index.`);
    }

    callbacks.onFrame({
      animationId: animation.animationId,
      frameIndex: this.currentFrameIndex,
      frame,
      timestampMs: this.clock.now(),
    });

    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.advance(revision);
    }, frame.durationMs);
  }

  private advance(revision: number): void {
    const animation = this.activeAnimation;
    const callbacks = this.callbacks;

    if (!animation || !callbacks || revision !== this.playbackRevision) {
      return;
    }

    if (this.currentFrameIndex < animation.frames.length - 1) {
      this.currentFrameIndex += 1;
      this.emitCurrentFrame(revision);
      return;
    }

    if (animation.loop) {
      this.currentFrameIndex = 0;
      this.emitCurrentFrame(revision);
      return;
    }

    this.activeAnimation = undefined;
    this.callbacks = undefined;
    this.currentFrameIndex = 0;
    this.playbackRevision += 1;
    callbacks.onComplete({
      animationId: animation.animationId,
      nextState: animation.nextState,
    });
  }
}
