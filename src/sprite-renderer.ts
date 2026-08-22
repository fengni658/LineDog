import type { DefaultRuntimeResources, RuntimeFrame } from "./pet-manifest";

export const RUNTIME_VIEWPORT_SIZE = 160;

export type ImageLoader = (url: string) => Promise<void>;

export interface SpriteImagePort {
  src: string;
}

export type SpriteFacing = "Left" | "Right";
export type SpriteVisualTransition = "NONE" | "TURN";

export interface SpriteStagePort {
  readonly dataset: {
    facing?: string;
  };
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
      <img
        id="pet-sprite"
        class="pet-sprite"
        width="160"
        height="160"
        alt=""
        aria-hidden="true"
        draggable="false"
      />
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
  ];

  await Promise.all([...new Set(urls)].map((url) => loadImage(url)));
}

export function renderSpriteFrame(
  sprite: SpriteImagePort,
  frame: RuntimeFrame,
): void {
  sprite.src = frame.url;
}

export function applySpriteFacing(
  stage: SpriteStagePort,
  facing: SpriteFacing,
): void {
  stage.dataset.facing = facing;
}

export function resolveSpriteFacing(
  behavior: string,
  facing: SpriteFacing,
  visualTransition: SpriteVisualTransition = "NONE",
  turnFrameMirrored = false,
): SpriteFacing {
  if (visualTransition === "TURN") {
    return turnFrameMirrored ? "Left" : "Right";
  }

  return behavior === "WALK" || behavior === "LOOK" ? facing : "Right";
}
