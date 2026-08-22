export const CHARACTER_MANIFEST_URL = "/character/manifest.json";

export type AnimationStatus =
  | "DRAFT"
  | "CANDIDATE_READY"
  | "FROZEN"
  | "NO_GO";

export type InterruptPolicy =
  | "interruptible_at_frame_boundary"
  | "interruptible_by_user_interaction"
  | "non_interruptible";

export interface CharacterCanvas {
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly footBaseline: number;
  readonly safeMargin: number;
}

export interface CharacterFrame {
  readonly src: string;
  readonly durationMs?: number;
  readonly visualAnchor: Readonly<{ x: number; y: number }>;
  readonly groundContact: boolean;
}

export interface CharacterAnimation {
  readonly animationId: string;
  readonly revision: string;
  readonly status: AnimationStatus;
  readonly sourceView: string;
  readonly loop: boolean;
  readonly interruptPolicy: InterruptPolicy;
  readonly nextState: string;
  readonly frameDurationMs: number;
  readonly frames: readonly CharacterFrame[];
}

export interface CharacterManifest {
  readonly schemaVersion: 1;
  readonly characterId: string;
  readonly characterModelVersion: string;
  readonly canvas: CharacterCanvas;
  readonly animations: Readonly<Record<string, CharacterAnimation>>;
}

export interface RuntimeFrame extends CharacterFrame {
  readonly durationMs: number;
  readonly url: string;
}

export interface RuntimeAnimation extends Omit<CharacterAnimation, "frames"> {
  readonly frames: readonly RuntimeFrame[];
}

export interface DefaultRuntimeResources {
  readonly canvas: CharacterCanvas;
  readonly idle: RuntimeAnimation;
  readonly blink: RuntimeAnimation;
  readonly walk: RuntimeAnimation;
  readonly lookMouse: RuntimeAnimation;
  readonly happy: RuntimeAnimation;
  readonly drag: RuntimeAnimation;
  readonly fall: RuntimeAnimation;
  readonly land: RuntimeAnimation;
  readonly turn: RuntimeAnimation;
}

export interface CharacterManifestResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type CharacterManifestFetcher = (
  url: string,
) => Promise<CharacterManifestResponse>;

const VALID_STATUSES = new Set<AnimationStatus>([
  "DRAFT",
  "CANDIDATE_READY",
  "FROZEN",
  "NO_GO",
]);

const VALID_INTERRUPT_POLICIES = new Set<InterruptPolicy>([
  "interruptible_at_frame_boundary",
  "interruptible_by_user_interaction",
  "non_interruptible",
]);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Character manifest ${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Character manifest ${label}.${key} must be a non-empty string.`);
  }

  return value;
}

function requiredPositiveNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Character manifest ${label}.${key} must be a finite positive number.`);
  }

  return value;
}

function optionalPositiveNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  if (!(key in record)) {
    return undefined;
  }

  return requiredPositiveNumber(record, key, label);
}

function requiredBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];

  if (typeof value !== "boolean") {
    throw new Error(`Character manifest ${label}.${key} must be a boolean.`);
  }

  return value;
}

function parseCanvas(value: unknown): CharacterCanvas {
  const record = asRecord(value, "canvas");
  const canvas = {
    width: requiredPositiveNumber(record, "width", "canvas"),
    height: requiredPositiveNumber(record, "height", "canvas"),
    centerX: requiredPositiveNumber(record, "centerX", "canvas"),
    footBaseline: requiredPositiveNumber(record, "footBaseline", "canvas"),
    safeMargin: requiredPositiveNumber(record, "safeMargin", "canvas"),
  };

  if (canvas.centerX > canvas.width || canvas.footBaseline > canvas.height) {
    throw new Error("Character manifest canvas anchors must remain inside the canvas.");
  }

  return canvas;
}

function parseFrame(value: unknown, label: string): CharacterFrame {
  const record = asRecord(value, label);
  const visualAnchor = asRecord(record.visualAnchor, `${label}.visualAnchor`);

  return {
    src: requiredString(record, "src", label),
    durationMs: optionalPositiveNumber(record, "durationMs", label),
    visualAnchor: {
      x: requiredPositiveNumber(visualAnchor, "x", `${label}.visualAnchor`),
      y: requiredPositiveNumber(visualAnchor, "y", `${label}.visualAnchor`),
    },
    groundContact: requiredBoolean(record, "groundContact", label),
  };
}

function parseAnimation(
  value: unknown,
  animationKey: string,
): CharacterAnimation {
  const label = `animations.${animationKey}`;
  const record = asRecord(value, label);
  const status = requiredString(record, "status", label);
  const interruptPolicy = requiredString(record, "interruptPolicy", label);
  const rawFrames = record.frames;

  if (!VALID_STATUSES.has(status as AnimationStatus)) {
    throw new Error(`Character manifest ${label}.status is not a supported status.`);
  }

  if (!VALID_INTERRUPT_POLICIES.has(interruptPolicy as InterruptPolicy)) {
    throw new Error(
      `Character manifest ${label}.interruptPolicy is not a supported policy.`,
    );
  }

  if (!Array.isArray(rawFrames) || rawFrames.length === 0) {
    throw new Error(`Character manifest ${label}.frames must be a non-empty array.`);
  }

  const animationId = requiredString(record, "animationId", label);
  if (animationId !== animationKey) {
    throw new Error(
      `Character manifest ${label}.animationId must match its animation key.`,
    );
  }

  return {
    animationId,
    revision: requiredString(record, "revision", label),
    status: status as AnimationStatus,
    sourceView: requiredString(record, "sourceView", label),
    loop: requiredBoolean(record, "loop", label),
    interruptPolicy: interruptPolicy as InterruptPolicy,
    nextState: requiredString(record, "nextState", label),
    frameDurationMs: requiredPositiveNumber(record, "frameDurationMs", label),
    frames: rawFrames.map((frame, index) =>
      parseFrame(frame, `${label}.frames[${index}]`),
    ),
  };
}

export function parseCharacterManifest(value: unknown): CharacterManifest {
  const record = asRecord(value, "root");

  if (record.schemaVersion !== 1) {
    throw new Error("Character manifest schemaVersion must equal 1.");
  }

  const rawAnimations = asRecord(record.animations, "animations");
  const animations = Object.fromEntries(
    Object.entries(rawAnimations).map(([key, animation]) => [
      key,
      parseAnimation(animation, key),
    ]),
  ) as Record<string, CharacterAnimation>;

  return {
    schemaVersion: 1,
    characterId: requiredString(record, "characterId", "root"),
    characterModelVersion: requiredString(record, "characterModelVersion", "root"),
    canvas: parseCanvas(record.canvas),
    animations,
  };
}

export function resolveCharacterResourceUrl(sourcePath: string): string {
  const segments = sourcePath.split("/");
  const isSafePath =
    sourcePath.length > 0 &&
    !sourcePath.startsWith("/") &&
    !sourcePath.includes("\\") &&
    sourcePath.toLowerCase().endsWith(".png") &&
    segments.every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== "..",
    );

  if (!isSafePath) {
    throw new Error("Character resource path must be a relative PNG path under /character/.");
  }

  return `/character/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export function toRuntimeAnimation(animation: CharacterAnimation): RuntimeAnimation {
  return {
    ...animation,
    frames: animation.frames.map((frame) => ({
      ...frame,
      durationMs: frame.durationMs ?? animation.frameDurationMs,
      url: resolveCharacterResourceUrl(frame.src),
    })),
  };
}

function requiredFrozenAnimation(
  manifest: CharacterManifest,
  animationId:
    | "idle"
    | "blink"
    | "walk"
    | "look_mouse"
    | "happy"
    | "drag"
    | "fall"
    | "land"
    | "turn",
): RuntimeAnimation {
  const animation = manifest.animations[animationId];

  if (!animation || animation.status !== "FROZEN") {
    throw new Error(
      `Character manifest requires a frozen ${animationId} animation for default runtime playback.`,
    );
  }

  const runtimeAnimation = toRuntimeAnimation(animation);
  assertFrozenRuntimeSemantics(animationId, runtimeAnimation);
  return runtimeAnimation;
}

function assertFrozenRuntimeSemantics(
  animationId: string,
  animation: RuntimeAnimation,
): void {
  if (animationId === "drag") {
    if (animation.revision !== "r1") {
      throw new Error("Character manifest Drag must use frozen r1.");
    }

    if (!animation.loop) {
      throw new Error("Character manifest Drag must loop.");
    }

    if (animation.sourceView !== "front") {
      throw new Error("Character manifest Drag must use the front view.");
    }

    if (animation.nextState !== "DRAG") {
      throw new Error("Character manifest Drag must remain in DRAG.");
    }

    assertFrozenFrameSemantics(animation, "Drag", [220, 220], false);
    return;
  }

  if (animationId === "fall") {
    if (animation.revision !== "r1") {
      throw new Error("Character manifest Fall must use frozen r1.");
    }

    if (!animation.loop) {
      throw new Error("Character manifest Fall must loop.");
    }

    if (animation.sourceView !== "front") {
      throw new Error("Character manifest Fall must use the front view.");
    }

    assertFrozenFrameSemantics(animation, "Fall", [140, 140], false);
    return;
  }

  if (animationId === "land") {
    if (animation.revision !== "r2") {
      throw new Error("Character manifest Land must use frozen r2.");
    }

    if (animation.loop) {
      throw new Error("Character manifest Land must be non-looping.");
    }

    if (animation.sourceView !== "front") {
      throw new Error("Character manifest Land must use the front view.");
    }

    assertFrozenFrameSemantics(animation, "Land", [90, 80, 80], true);
    return;
  }

  if (animationId === "turn") {
    if (animation.revision !== "r1") {
      throw new Error("Character manifest TURN must use frozen r1.");
    }

    if (animation.loop) {
      throw new Error("Character manifest TURN must be non-looping.");
    }

    if (animation.sourceView !== "side-right-to-side-left") {
      throw new Error(
        "Character manifest TURN must use the frozen side-to-side sequence.",
      );
    }

    if (animation.nextState !== "WALK") {
      throw new Error("Character manifest TURN must lead into WALK.");
    }

    if (animation.interruptPolicy !== "interruptible_by_user_interaction") {
      throw new Error(
        "Character manifest TURN must allow direct user-interaction interruption.",
      );
    }

    assertFrozenFrameSemantics(animation, "TURN", [60, 80, 100, 80, 60], true);
  }
}

function assertFrozenFrameSemantics(
  animation: RuntimeAnimation,
  label: string,
  expectedDurations: readonly number[],
  expectedGroundContact: boolean,
): void {
  if (animation.frames.length !== expectedDurations.length) {
    throw new Error(`Character manifest ${label} timing must use its frozen frame count.`);
  }

  for (const [index, frame] of animation.frames.entries()) {
    if (frame.durationMs !== expectedDurations[index]) {
      throw new Error(`Character manifest ${label} timing does not match its frozen frames.`);
    }

    if (frame.groundContact !== expectedGroundContact) {
      throw new Error(`Character manifest ${label} ground-contact semantics are invalid.`);
    }
  }
}

export function createDefaultRuntimeResources(
  manifest: CharacterManifest,
): DefaultRuntimeResources {
  return {
    canvas: manifest.canvas,
    idle: requiredFrozenAnimation(manifest, "idle"),
    blink: requiredFrozenAnimation(manifest, "blink"),
    walk: requiredFrozenAnimation(manifest, "walk"),
    lookMouse: requiredFrozenAnimation(manifest, "look_mouse"),
    happy: requiredFrozenAnimation(manifest, "happy"),
    drag: requiredFrozenAnimation(manifest, "drag"),
    fall: requiredFrozenAnimation(manifest, "fall"),
    land: requiredFrozenAnimation(manifest, "land"),
    turn: requiredFrozenAnimation(manifest, "turn"),
  };
}

export async function loadDefaultRuntimeResources(
  fetchManifest: CharacterManifestFetcher,
): Promise<DefaultRuntimeResources> {
  const response = await fetchManifest(CHARACTER_MANIFEST_URL);

  if (!response.ok) {
    throw new Error("LineDog could not load its character manifest.");
  }

  return createDefaultRuntimeResources(parseCharacterManifest(await response.json()));
}
