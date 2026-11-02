import type { DefaultRuntimeResources, RuntimeFrame } from "./pet-manifest";
import { frameDisplayScale } from "./pet-visual-geometry";

export const RUNTIME_VIEWPORT_SIZE = 160;

export type ImageLoader = (url: string) => Promise<void>;

export interface SpriteImagePort {
  src: string;
  getAttribute?(name: string): string | null;
  readonly style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
}

export type SpriteFacing = "Left" | "Right";
export type SpriteVisualTransition = "NONE" | "TURN";

export interface SpriteStagePort {
  readonly dataset: {
    facing?: string;
    happy?: string;
    dragging?: string;
    sleeping?: string;
  };
}

export interface SpriteFeedbackPort {
  textContent: string | null;
}

export function createSpriteSurfaceMarkup(): string {
  return `
    <section
      id="pet-stage"
      class="pet-stage"
      data-runtime-state="loading"
      data-facing="Right"
      data-pressed="false"
      data-happy="false"
      role="img"
      aria-label="线条小狗"
    >
      <div class="pet-facing-layer" aria-hidden="true">
        <img
          id="pet-sprite-under"
          class="pet-sprite pet-sprite-under"
          width="160"
          height="160"
          alt=""
          draggable="false"
        />
        <img
          id="pet-sprite"
          class="pet-sprite"
          width="160"
          height="160"
          alt=""
          draggable="false"
        />
      </div>
      <div class="pet-sleep-closeup" aria-hidden="true">
        <span class="pet-sleep-closeup__glow"></span>
        <span class="pet-sleep-zzz" aria-label="熟睡中">
          <span class="pet-sleep-zzz__letter pet-sleep-zzz__letter--1">Z</span>
          <span class="pet-sleep-zzz__letter pet-sleep-zzz__letter--2">Z</span>
          <span class="pet-sleep-zzz__letter pet-sleep-zzz__letter--3">Z</span>
        </span>
      </div>
      <div id="pet-hitbox" class="pet-hitbox" aria-hidden="true"></div>
    </section>
    <span id="pet-feedback" class="visually-hidden" aria-live="polite"></span>
  `;
}

export function createBrowserImageLoader(): ImageLoader {
  return (url) =>
    new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`LineDog could not preload ${url}.`));
      image.src = url;
    });
}

export async function preloadRuntimeFrames(
  resources: DefaultRuntimeResources,
  loadImage: ImageLoader,
): Promise<void> {
  const urls = [
    ...resources.idle.frames.map((frame) => frame.url),
    ...resources.blink.frames.map((frame) => frame.url),
    ...resources.walk.frames.map((frame) => frame.url),
    ...resources.lookMouse.frames.map((frame) => frame.url),
    ...resources.happy.frames.map((frame) => frame.url),
    ...resources.drag.frames.map((frame) => frame.url),
    ...resources.fall.frames.map((frame) => frame.url),
    ...resources.land.frames.map((frame) => frame.url),
    ...resources.turn.frames.map((frame) => frame.url),
    ...resources.jumpAir.frames.map((frame) => frame.url),
    ...resources.homeLand.frames.map((frame) => frame.url),
    ...resources.homeIdle.frames.map((frame) => frame.url),
    ...resources.sleep.frames.map((frame) => frame.url),
  ];

  await Promise.all([...new Set(urls)].map((url) => loadImage(url)));
}

export function renderSpriteFrame(
  sprite: SpriteImagePort,
  frame: RuntimeFrame,
): void {
  sprite.src = frame.url;
}

export function applySpriteVisualAnchorOffset(
  sprite: SpriteImagePort,
  frame: RuntimeFrame,
  _renderedFacing: SpriteFacing,
  under?: SpriteImagePort,
): void {
  const offsetX = ((256 - frame.visualAnchor.x) / 512) * RUNTIME_VIEWPORT_SIZE;
  const offsetY = ((448 - frame.visualAnchor.y) / 512) * RUNTIME_VIEWPORT_SIZE;
  // The parent facing layer mirrors around (80, 140); child offsets stay in
  // source orientation, otherwise a shifted visual anchor is mirrored twice.
  const renderedOffsetX = offsetX;

  sprite.style.setProperty("--pet-anchor-translate-x", `${renderedOffsetX}px`);
  sprite.style.setProperty("--pet-anchor-translate-y", `${offsetY}px`);
  sprite.style.setProperty("--pet-frame-scale", String(frameDisplayScale(frame)));
  sprite.style.setProperty("transform-origin", `${frame.visualAnchor.x * 160 / 512}px ${frame.visualAnchor.y * 160 / 512}px`);
  if (under) {
    under.style.setProperty("--pet-anchor-translate-x", `${renderedOffsetX}px`);
    under.style.setProperty("--pet-anchor-translate-y", `${offsetY}px`);
    under.style.setProperty("--pet-frame-scale", String(frameDisplayScale(frame)));
    under.style.setProperty("transform-origin", `${frame.visualAnchor.x * 160 / 512}px ${frame.visualAnchor.y * 160 / 512}px`);
  }
}

/** 缓慢的安静动画（趴窝/入睡）逐帧硬切会呈现“定格动画”式的生硬感。 */
export const SPRITE_CROSSFADE_MS = 160;

/** 仅整理卧姿逐帧溶解；睡眠固定首帧和拖拽都立即独占主层。 */
export const CROSSFADE_ANIMATION_IDS: ReadonlySet<string> = new Set([
  "home_idle",
]);

export interface SpriteCrossfadePort {
  readonly sprite: SpriteImagePort;
  readonly under: SpriteImagePort;
}

export interface CrossfadeTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

function spriteSource(sprite: SpriteImagePort): string {
  // HTMLImageElement.src resolves relative asset URLs to absolute URLs. Compare
  // and copy the assigned attribute so duplicate frames keep their identity.
  return sprite.getAttribute?.("src") ?? sprite.src;
}

/**
 * 通过“旧帧在上层淡出、新帧在下层全量显示”实现帧间溶解：
 * 溶解期间画面 = 新帧 + 旧帧×alpha，不会塌到背景色。
 * 快节奏动画（走/跳/拖拽）仍走硬切以保持干脆。
 */
export class SmoothSpriteFrameRenderer {
  private timer: unknown | undefined;
  private pendingFrame: RuntimeFrame | undefined;

  constructor(private readonly timers: CrossfadeTimers) {}

  dispose(): void {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  render(ports: SpriteCrossfadePort, frame: RuntimeFrame, crossfade: boolean): void {
    const { sprite, under } = ports;

    // 即使 src 重复，硬切也必须同步取消旧溶解并恢复单层不透明。
    if (!crossfade) {
      this.dispose();
      sprite.style.setProperty("transition", "none");
      sprite.src = frame.url;
      applySpriteVisualAnchorOffset(sprite, frame, "Right");
      sprite.style.setProperty("opacity", "1");
      under.style.setProperty("transition", "none");
      under.style.setProperty("opacity", "0");
      return;
    }

    if (this.timer !== undefined) {
      if (spriteSource(under) === frame.url) return;
      this.dispose();
      this.commit(sprite, under);
    }

    if (spriteSource(sprite) === frame.url) {
      return;
    }

    // 新帧放到下层并立即全量显示；上层旧帧保持不动，随后淡出。
    under.style.setProperty("transition", "none");
    under.style.setProperty("opacity", "1");
    under.src = frame.url;
    applySpriteVisualAnchorOffset(under, frame, "Right");
    this.pendingFrame = frame;
    sprite.style.setProperty("transition", `opacity ${SPRITE_CROSSFADE_MS}ms ease-out`);
    sprite.style.setProperty("opacity", "0");
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.commit(sprite, under);
    }, SPRITE_CROSSFADE_MS + 30);
  }

  /**
   * 提交：上层采纳新帧并**瞬时**恢复不透明，下层随即归零。
   *
   * 这里必须显式写 `transition: none` + `opacity: 1`，不能只是移除内联样式：
   * 样式表给 `.pet-sprite` 的是 320ms 的 opacity 过渡，移除内联后上层会从 0
   * 重新淡入，而下层已经瞬时归零，中间几十毫秒两层都暗。此修复必须保留。
   */
  private commit(sprite: SpriteImagePort, under: SpriteImagePort): void {
    sprite.style.setProperty("transition", "none");
    sprite.src = spriteSource(under);
    if (this.pendingFrame) applySpriteVisualAnchorOffset(sprite, this.pendingFrame, "Right");
    this.pendingFrame = undefined;
    sprite.style.setProperty("opacity", "1");
    under.style.setProperty("transition", "none");
    under.style.setProperty("opacity", "0");
  }
}

export function applySpriteFacing(
  stage: SpriteStagePort,
  facing: SpriteFacing,
): void {
  stage.dataset.facing = facing;
}

export function applySpriteHappyFeedback(
  stage: SpriteStagePort,
  feedback: SpriteFeedbackPort,
  behavior: string,
): void {
  const isHappy = behavior === "HAPPY";
  stage.dataset.happy = String(isHappy);
  feedback.textContent = isHappy ? "小狗开心地回应了。" : "";
}

export function applySpriteDraggingState(
  stage: SpriteStagePort,
  isDragging: boolean,
): void {
  stage.dataset.dragging = String(isDragging);
}

export function applySpriteSleepingState(
  stage: SpriteStagePort,
  behavior: string,
  activeAnimationId: string,
): void {
  stage.dataset.sleeping = String(
    behavior === "REST" && activeAnimationId === "sleep",
  );
}

export function resolveSpriteFacing(
  behavior: string,
  facing: SpriteFacing,
  visualTransition: SpriteVisualTransition = "NONE",
  turnFrameMirrored = false,
  activeAnimationId?: string,
): SpriteFacing {
  if (visualTransition === "TURN") {
    return turnFrameMirrored ? "Left" : "Right";
  }

  if (activeAnimationId === "jump_air") {
    return behavior === "LEAVE_HOME"
      ? "Right"
      : facing === "Right"
        ? "Left"
        : "Right";
  }

  return behavior === "WALK" ||
    behavior === "LOOK" ||
    behavior === "GO_HOME" ||
    behavior === "DRAG"
    ? facing
    : "Right";
}
