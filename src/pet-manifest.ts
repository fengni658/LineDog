export const CHARACTER_MANIFEST_URL = "/character/manifest.json";

const CANVAS_SIZE = 512;
const EXPECTED_ACTION_IDS = [
  "idle", "blink", "walk", "happy", "look_mouse", "drag", "fall", "land", "turn",
  "jump_air", "home_land", "home_idle", "sleep",
] as const;

export type RuntimeAnimationId = (typeof EXPECTED_ACTION_IDS)[number];
export type AnimationStatus = "FROZEN";
export type InterruptPolicy =
  | "interruptible_at_frame_boundary"
  | "interruptible_by_user_interaction";
export type Playback = "LOOP" | "ONCE";
export type MotionAnchorKind = "FOOT_CENTER" | "AIRBORNE_REFERENCE";

export interface CharacterCanvas {
  readonly width: 512;
  readonly height: 512;
  readonly centerX: 256;
  readonly footBaseline: 448;
  readonly safeMargin: 48;
}

export interface RuntimeWindow {
  readonly width: 160;
  readonly height: 160;
}

/** Runtime-logical pointer geometry; it is not a 512px canvas geometry fact. */
export interface LogicalHitBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface VisualAnchor { readonly x: number; readonly y: number; }
export interface FootCenterMotionAnchor { readonly kind: "FOOT_CENTER"; readonly x: number; readonly y: number; }
export interface AirborneReferenceMotionAnchor { readonly kind: "AIRBORNE_REFERENCE"; readonly x: number; readonly y: number; }
export type MotionAnchor = FootCenterMotionAnchor | AirborneReferenceMotionAnchor;

export interface FootSegmentContactGeometry { readonly kind: "FOOT_SEGMENT"; readonly leftX: number; readonly rightX: number; readonly y: number; }
export interface AirborneContactGeometry { readonly kind: "AIRBORNE"; }
export type ContactGeometry = FootSegmentContactGeometry | AirborneContactGeometry;

/** Visual comparison metadata only; this consumer does not make native writes. */
export interface FrameGeometry {
  readonly visualAnchor: VisualAnchor;
  readonly motionAnchor: MotionAnchor;
  readonly contactGeometry: ContactGeometry;
}

export interface CharacterFrame extends FrameGeometry {
  readonly logicalAssetKey: string;
  /** Compatibility alias for the logical asset key. */
  readonly src: string;
  readonly durationMs: number;
  readonly groundContact: boolean;
  /** Optional runtime-logical override for pointer hit testing. */
  readonly hitBox?: LogicalHitBox;
}

export interface CharacterAnimation {
  readonly id: RuntimeAnimationId;
  readonly animationId: RuntimeAnimationId;
  readonly revision: string;
  readonly frozenVersion?: string;
  readonly status: AnimationStatus;
  readonly sourceView: "front" | "side-left" | "side-right" | "front-to-three-quarter-right" | "side-right-to-side-left";
  readonly loop: boolean;
  readonly interruptPolicy: InterruptPolicy;
  readonly nextState: "IDLE" | "WALK" | "LOOK" | "DRAG" | "FALL" | "HOME_LAND" | "HOME_IDLE" | "SLEEP";
  readonly frameDurationMs: number;
  readonly playback: Playback;
  readonly reversePlaybackAllowed: boolean;
  readonly frameDurationsMs: readonly number[];
  readonly frames: readonly CharacterFrame[];
  /** Optional runtime-logical default for frames without their own hitBox. */
  readonly hitBox?: LogicalHitBox;
}

export interface GeometryValidation {
  readonly anchorContactConsistency: "ANCHOR_CONTACT_CONSISTENCY_V1";
  readonly mirrorTransform: {
    readonly formulaVersion: "MIRROR_512_V1";
    readonly pointXPrime: "512 - pointX";
    readonly footLeftPrime: "512 - footRight";
    readonly footRightPrime: "512 - footLeft";
    readonly motionAnchorXPrime: "512 - motionAnchorX";
  };
  readonly transparentMarginException: "NONE";
}

export interface CharacterManifest {
  readonly schemaVersion: 2;
  readonly characterId: "linedog";
  readonly characterModelVersion: string;
  readonly assetStatus: "FROZEN";
  readonly provenance: "ORIGINAL_GENERATED";
  readonly contentRevision: string;
  readonly manifestRevision: string;
  readonly canvas: CharacterCanvas;
  readonly runtimeWindow: RuntimeWindow;
  readonly geometryValidation: GeometryValidation;
  readonly animations: Readonly<Record<RuntimeAnimationId, CharacterAnimation>>;
}

export interface RuntimeFrame extends CharacterFrame { readonly url: string; }
/** Timeline-facing animation facts consumed by the single Pet Runtime. */
export interface RuntimeAnimation {
  readonly id: string;
  readonly animationId: string;
  readonly revision: string;
  readonly frozenVersion?: string;
  readonly status: "FROZEN";
  readonly sourceView: string;
  readonly loop: boolean;
  readonly interruptPolicy: string;
  readonly nextState: string;
  readonly frameDurationMs: number;
  readonly playback: Playback;
  readonly reversePlaybackAllowed: boolean;
  readonly frameDurationsMs: readonly number[];
  readonly frames: readonly RuntimeFrame[];
  readonly hitBox?: LogicalHitBox;
}

export interface DefaultRuntimeResources {
  readonly canvas: CharacterCanvas;
  readonly runtimeWindow: RuntimeWindow;
  readonly idle: RuntimeAnimation;
  readonly blink: RuntimeAnimation;
  readonly walk: RuntimeAnimation;
  readonly lookMouse: RuntimeAnimation;
  readonly happy: RuntimeAnimation;
  readonly drag: RuntimeAnimation;
  readonly fall: RuntimeAnimation;
  readonly land: RuntimeAnimation;
  readonly turn: RuntimeAnimation;
  readonly jumpAir: RuntimeAnimation;
  readonly homeLand: RuntimeAnimation;
  readonly homeIdle: RuntimeAnimation;
  readonly sleep: RuntimeAnimation;
}
export interface CharacterManifestResponse { readonly ok: boolean; json(): Promise<unknown>; }
export type CharacterManifestFetcher = (url: string) => Promise<CharacterManifestResponse>;

const VALID_SOURCE_VIEWS = new Set([
  "front", "side-left", "side-right", "front-to-three-quarter-right", "side-right-to-side-left",
]);
const VALID_INTERRUPT_POLICIES = new Set([
  "interruptible_at_frame_boundary", "interruptible_by_user_interaction",
]);
const VALID_NEXT_STATES = new Set([
  "IDLE", "WALK", "LOOK", "DRAG", "FALL", "HOME_LAND", "HOME_IDLE", "SLEEP",
]);
const REVISION_PATTERN = /^r[1-9][0-9]*$/;
const REVISION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Character manifest ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, required: readonly string[], allowed: readonly string[], label: string): void {
  for (const key of required) {
    if (!(key in record)) throw new Error(`Character manifest ${label}.${key} is required.`);
  }
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new Error(`Character manifest ${label}.${key} is not allowed by schemaVersion 2.`);
  }
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Character manifest ${label}.${key} must be a non-empty string.`);
  }
  return value;
}

function requiredBoundedNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > CANVAS_SIZE) {
    throw new Error(`Character manifest ${label}.${key} must be finite and inside the 512px canvas.`);
  }
  return value;
}

function parseLogicalHitBox(value: unknown, label: string): LogicalHitBox {
  const record = asRecord(value, label);
  const keys = ["x", "y", "width", "height"];
  assertExactKeys(record, keys, keys, label);
  const x = record.x;
  const y = record.y;
  const width = record.width;
  const height = record.height;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > 160 ||
    y + height > 160
  ) {
    throw new Error(`Character manifest ${label} must be a finite positive rectangle inside the 160px runtime window.`);
  }
  return { x, y, width, height };
}

function requiredPositiveInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`Character manifest ${label}.${key} must be a positive integer.`);
  }
  return value as number;
}

function requiredBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`Character manifest ${label}.${key} must be a boolean.`);
  return value;
}

function assertConst(actual: unknown, expected: string | number, label: string): void {
  if (actual !== expected) throw new Error(`Character manifest ${label} must equal ${String(expected)}.`);
}

function parseCanvas(value: unknown): CharacterCanvas {
  const record = asRecord(value, "canvas");
  const keys = ["width", "height", "centerX", "footBaseline", "safeMargin"];
  assertExactKeys(record, keys, keys, "canvas");
  assertConst(record.width, 512, "canvas.width");
  assertConst(record.height, 512, "canvas.height");
  assertConst(record.centerX, 256, "canvas.centerX");
  assertConst(record.footBaseline, 448, "canvas.footBaseline");
  assertConst(record.safeMargin, 48, "canvas.safeMargin");
  return { width: 512, height: 512, centerX: 256, footBaseline: 448, safeMargin: 48 };
}

function parseRuntimeWindow(value: unknown): RuntimeWindow {
  const record = asRecord(value, "runtimeWindow");
  const keys = ["width", "height"];
  assertExactKeys(record, keys, keys, "runtimeWindow");
  assertConst(record.width, 160, "runtimeWindow.width");
  assertConst(record.height, 160, "runtimeWindow.height");
  return { width: 160, height: 160 };
}

function parseGeometryValidation(value: unknown): GeometryValidation {
  const record = asRecord(value, "geometryValidation");
  const keys = ["anchorContactConsistency", "mirrorTransform", "transparentMarginException"];
  assertExactKeys(record, keys, keys, "geometryValidation");
  assertConst(record.anchorContactConsistency, "ANCHOR_CONTACT_CONSISTENCY_V1", "geometryValidation.anchorContactConsistency");
  assertConst(record.transparentMarginException, "NONE", "geometryValidation.transparentMarginException");
  const mirror = asRecord(record.mirrorTransform, "geometryValidation.mirrorTransform");
  const mirrorKeys = ["formulaVersion", "pointXPrime", "footLeftPrime", "footRightPrime", "motionAnchorXPrime"];
  assertExactKeys(mirror, mirrorKeys, mirrorKeys, "geometryValidation.mirrorTransform");
  assertConst(mirror.formulaVersion, "MIRROR_512_V1", "geometryValidation.mirrorTransform.formulaVersion");
  assertConst(mirror.pointXPrime, "512 - pointX", "geometryValidation.mirrorTransform.pointXPrime");
  assertConst(mirror.footLeftPrime, "512 - footRight", "geometryValidation.mirrorTransform.footLeftPrime");
  assertConst(mirror.footRightPrime, "512 - footLeft", "geometryValidation.mirrorTransform.footRightPrime");
  assertConst(mirror.motionAnchorXPrime, "512 - motionAnchorX", "geometryValidation.mirrorTransform.motionAnchorXPrime");
  return {
    anchorContactConsistency: "ANCHOR_CONTACT_CONSISTENCY_V1",
    mirrorTransform: {
      formulaVersion: "MIRROR_512_V1",
      pointXPrime: "512 - pointX",
      footLeftPrime: "512 - footRight",
      footRightPrime: "512 - footLeft",
      motionAnchorXPrime: "512 - motionAnchorX",
    },
    transparentMarginException: "NONE",
  };
}

function parseVisualAnchor(value: unknown, label: string): VisualAnchor {
  const record = asRecord(value, label);
  const keys = ["x", "y"];
  assertExactKeys(record, keys, keys, label);
  return { x: requiredBoundedNumber(record, "x", label), y: requiredBoundedNumber(record, "y", label) };
}

function parseMotionAnchor(value: unknown, label: string): MotionAnchor {
  const record = asRecord(value, label);
  const keys = ["kind", "x", "y"];
  assertExactKeys(record, keys, keys, label);
  const kind = requiredString(record, "kind", label);
  const point = { x: requiredBoundedNumber(record, "x", label), y: requiredBoundedNumber(record, "y", label) };
  if (kind === "FOOT_CENTER") return { kind, ...point };
  if (kind === "AIRBORNE_REFERENCE") return { kind, ...point };
  throw new Error(`Character manifest ${label}.kind is not a supported motion anchor.`);
}

function parseContactGeometry(value: unknown, label: string): ContactGeometry {
  const record = asRecord(value, label);
  const kind = requiredString(record, "kind", label);
  if (kind === "FOOT_SEGMENT") {
    const keys = ["kind", "leftX", "rightX", "y"];
    assertExactKeys(record, keys, keys, label);
    const leftX = requiredBoundedNumber(record, "leftX", label);
    const rightX = requiredBoundedNumber(record, "rightX", label);
    if (leftX > rightX) throw new Error(`Character manifest ${label} foot segment must be ordered.`);
    return { kind, leftX, rightX, y: requiredBoundedNumber(record, "y", label) };
  }
  if (kind === "AIRBORNE") {
    const keys = ["kind"];
    assertExactKeys(record, keys, keys, label);
    return { kind };
  }
  throw new Error(`Character manifest ${label}.kind is not a supported contact geometry.`);
}

function assertAnchorContactConsistency(geometry: FrameGeometry, label: string): void {
  const { motionAnchor, contactGeometry } = geometry;
  if (contactGeometry.kind === "FOOT_SEGMENT") {
    if (motionAnchor.kind !== "FOOT_CENTER" || motionAnchor.x !== (contactGeometry.leftX + contactGeometry.rightX) / 2 || motionAnchor.y !== contactGeometry.y) {
      throw new Error(`Character manifest ${label} violates ANCHOR_CONTACT_CONSISTENCY_V1 for FOOT_CENTER.`);
    }
    return;
  }
  if (motionAnchor.kind !== "AIRBORNE_REFERENCE") {
    throw new Error(`Character manifest ${label} violates ANCHOR_CONTACT_CONSISTENCY_V1 for AIRBORNE.`);
  }
}

function parseFrameGeometry(value: unknown, label: string): FrameGeometry {
  const record = asRecord(value, label);
  const keys = ["visualAnchor", "motionAnchor", "contactGeometry"];
  assertExactKeys(record, keys, keys, label);
  const geometry = {
    visualAnchor: parseVisualAnchor(record.visualAnchor, `${label}.visualAnchor`),
    motionAnchor: parseMotionAnchor(record.motionAnchor, `${label}.motionAnchor`),
    contactGeometry: parseContactGeometry(record.contactGeometry, `${label}.contactGeometry`),
  };
  assertAnchorContactConsistency(geometry, label);
  return geometry;
}

function parseLogicalAssetKey(value: unknown, actionId: string, label: string): string {
  const logicalAssetKey = typeof value === "string" ? value : "";
  const segments = logicalAssetKey.split("/");
  const isSafePath = logicalAssetKey.length > 0 && logicalAssetKey.startsWith(`${actionId}/`) && !logicalAssetKey.startsWith("/") && !logicalAssetKey.includes("\\") && logicalAssetKey.toLowerCase().endsWith(".png") && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  if (!isSafePath) throw new Error(`Character manifest ${label}.logicalAssetKey must be a safe ${actionId}/ PNG path.`);
  return logicalAssetKey;
}

function parseFrame(value: unknown, actionId: string, durationMs: number, label: string): CharacterFrame {
  const record = asRecord(value, label);
  const keys = ["logicalAssetKey", "geometry"];
  assertExactKeys(record, keys, [...keys, "hitBox"], label);
  const logicalAssetKey = parseLogicalAssetKey(record.logicalAssetKey, actionId, label);
  const geometry = parseFrameGeometry(record.geometry, `${label}.geometry`);
  const hitBox = "hitBox" in record
    ? parseLogicalHitBox(record.hitBox, `${label}.hitBox`)
    : undefined;
  return {
    logicalAssetKey,
    src: logicalAssetKey,
    durationMs,
    groundContact: geometry.contactGeometry.kind !== "AIRBORNE",
    ...(hitBox === undefined ? {} : { hitBox }),
    ...geometry,
  };
}

function parseAnimation(value: unknown, expectedId: RuntimeAnimationId): CharacterAnimation {
  const label = `animations.${expectedId}`;
  const record = asRecord(value, label);
  const required = ["id", "animationId", "revision", "status", "sourceView", "loop", "interruptPolicy", "nextState", "frameDurationMs", "playback", "reversePlaybackAllowed", "frameDurationsMs", "frames"];
  assertExactKeys(record, required, [...required, "frozenVersion", "hitBox"], label);
  const id = requiredString(record, "id", label);
  const animationId = requiredString(record, "animationId", label);
  if (id !== expectedId || animationId !== expectedId) {
    throw new Error(`Character manifest ${label} must preserve the ordered ${expectedId} action.`);
  }
  const revision = requiredString(record, "revision", label);
  if (!REVISION_PATTERN.test(revision)) throw new Error(`Character manifest ${label}.revision must use the frozen rN form.`);
  const frozenVersion = "frozenVersion" in record ? requiredString(record, "frozenVersion", label) : undefined;
  if (frozenVersion !== undefined && !REVISION_PATTERN.test(frozenVersion)) throw new Error(`Character manifest ${label}.frozenVersion must use the frozen rN form.`);
  const hitBox = "hitBox" in record
    ? parseLogicalHitBox(record.hitBox, `${label}.hitBox`)
    : undefined;
  assertConst(record.status, "FROZEN", `${label}.status`);
  const sourceView = requiredString(record, "sourceView", label);
  if (!VALID_SOURCE_VIEWS.has(sourceView)) throw new Error(`Character manifest ${label}.sourceView is not supported.`);
  const interruptPolicy = requiredString(record, "interruptPolicy", label);
  if (!VALID_INTERRUPT_POLICIES.has(interruptPolicy)) throw new Error(`Character manifest ${label}.interruptPolicy is not supported.`);
  const nextState = requiredString(record, "nextState", label);
  if (!VALID_NEXT_STATES.has(nextState)) throw new Error(`Character manifest ${label}.nextState is not supported.`);
  const loop = requiredBoolean(record, "loop", label);
  const playback = requiredString(record, "playback", label);
  if ((playback !== "LOOP" && playback !== "ONCE") || loop !== (playback === "LOOP")) {
    throw new Error(`Character manifest ${label} playback and loop values must agree.`);
  }
  if (!Array.isArray(record.frameDurationsMs) || record.frameDurationsMs.length === 0) {
    throw new Error(`Character manifest ${label}.frameDurationsMs must be a non-empty array.`);
  }
  const frameDurationsMs = record.frameDurationsMs.map((duration, index) => {
    if (!Number.isInteger(duration) || duration <= 0) throw new Error(`Character manifest ${label}.frameDurationsMs[${index}] must be a positive integer.`);
    return duration;
  });
  if (!Array.isArray(record.frames) || record.frames.length === 0) throw new Error(`Character manifest ${label}.frames must be a non-empty array.`);
  if (record.frames.length !== frameDurationsMs.length) throw new Error(`Character manifest ${label} frame order and durations must have the same length.`);
  return {
    id: expectedId,
    animationId: expectedId,
    revision,
    ...(frozenVersion === undefined ? {} : { frozenVersion }),
    status: "FROZEN",
    sourceView: sourceView as CharacterAnimation["sourceView"],
    loop,
    interruptPolicy: interruptPolicy as InterruptPolicy,
    nextState: nextState as CharacterAnimation["nextState"],
    frameDurationMs: requiredPositiveInteger(record, "frameDurationMs", label),
    playback: playback as Playback,
    reversePlaybackAllowed: requiredBoolean(record, "reversePlaybackAllowed", label),
    frameDurationsMs,
    ...(hitBox === undefined ? {} : { hitBox }),
    frames: record.frames.map((frame, index) => parseFrame(frame, expectedId, frameDurationsMs[index], `${label}.frames[${index}]`)),
  };
}

function parseFrozenManifestBase(
  record: Record<string, unknown>,
  rawAnimations: readonly unknown[],
): CharacterManifest {
  const required = ["$schema", "schemaVersion", "characterId", "characterModelVersion", "assetStatus", "provenance", "contentRevision", "manifestRevision", "canvas", "runtimeWindow", "geometryValidation", "animations"];
  assertExactKeys(record, required, required, "root");
  assertConst(record.$schema, "./character-manifest-v2.schema.json", "root.$schema");
  assertConst(record.schemaVersion, 2, "root.schemaVersion");
  assertConst(record.characterId, "linedog", "root.characterId");
  assertConst(record.assetStatus, "FROZEN", "root.assetStatus");
  assertConst(record.provenance, "ORIGINAL_GENERATED", "root.provenance");
  const contentRevision = requiredString(record, "contentRevision", "root");
  const manifestRevision = requiredString(record, "manifestRevision", "root");
  if (!REVISION_ID_PATTERN.test(contentRevision) || !REVISION_ID_PATTERN.test(manifestRevision)) {
    throw new Error("Character manifest root revision identifiers are invalid.");
  }
  if (rawAnimations.length !== EXPECTED_ACTION_IDS.length) {
    throw new Error("Character manifest must contain the ordered thirteen frozen runtime actions.");
  }
  const animations = Object.fromEntries(
    EXPECTED_ACTION_IDS.map((id, index) => [id, parseAnimation(rawAnimations[index], id)]),
  ) as Record<RuntimeAnimationId, CharacterAnimation>;
  const frameCount = Object.values(animations).reduce(
    (total, animation) => total + animation.frames.length,
    0,
  );
  if (frameCount !== 51) {
    throw new Error("Character manifest must contain exactly 51 ordered frozen frames.");
  }
  return {
    schemaVersion: 2,
    characterId: "linedog",
    characterModelVersion: requiredString(record, "characterModelVersion", "root"),
    assetStatus: "FROZEN",
    provenance: "ORIGINAL_GENERATED",
    contentRevision,
    manifestRevision,
    canvas: parseCanvas(record.canvas),
    runtimeWindow: parseRuntimeWindow(record.runtimeWindow),
    geometryValidation: parseGeometryValidation(record.geometryValidation),
    animations,
  };
}

export function parseCharacterManifest(value: unknown): CharacterManifest {
  const record = asRecord(value, "root");
  const rawAnimations = record.animations;
  if (!Array.isArray(rawAnimations) || rawAnimations.length !== EXPECTED_ACTION_IDS.length) {
    throw new Error("Character manifest must contain the ordered thirteen frozen runtime actions.");
  }
  return parseFrozenManifestBase(record, rawAnimations);
}

export function resolveCharacterResourceUrl(sourcePath: string): string {
  const segments = sourcePath.split("/");
  const isSafePath = sourcePath.length > 0 && !sourcePath.startsWith("/") && !sourcePath.includes("\\") && sourcePath.toLowerCase().endsWith(".png") && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  if (!isSafePath) throw new Error("Character resource path must be a relative PNG path under /character/.");
  return `/character/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export function toRuntimeAnimation(animation: CharacterAnimation): RuntimeAnimation {
  return {
    ...animation,
    frames: animation.frames.map((frame) => ({ ...frame, url: resolveCharacterResourceUrl(frame.logicalAssetKey) })),
  };
}

function requiredFrozenAnimation(manifest: CharacterManifest, animationId: RuntimeAnimationId): RuntimeAnimation {
  const animation = manifest.animations[animationId];
  if (!animation || animation.status !== "FROZEN") throw new Error(`Character manifest requires a frozen ${animationId} animation for default runtime playback.`);
  const runtimeAnimation = toRuntimeAnimation(animation);
  assertFrozenRuntimeSemantics(animationId, runtimeAnimation);
  return runtimeAnimation;
}

function assertFrozenRuntimeSemantics(animationId: RuntimeAnimationId, animation: RuntimeAnimation): void {
  if (animationId === "drag") {
    if (animation.revision !== "r1") throw new Error("Character manifest Drag must use frozen r1.");
    if (!animation.loop) throw new Error("Character manifest Drag must loop.");
    if (animation.sourceView !== "front" || animation.nextState !== "DRAG") throw new Error("Character manifest Drag must retain its frozen front DRAG behavior.");
    assertFrozenFrameSemantics(animation, "Drag", [220, 220], true);
    return;
  }
  if (animationId === "fall") {
    if (animation.revision !== "r1") throw new Error("Character manifest Fall must use frozen r1.");
    if (!animation.loop || animation.sourceView !== "front") throw new Error("Character manifest Fall must retain its frozen looping front behavior.");
    assertFrozenFrameSemantics(animation, "Fall", [140, 140], false);
    return;
  }
  if (animationId === "land") {
    if (animation.revision !== "r2") throw new Error("Character manifest Land must use frozen r2.");
    if (animation.loop || animation.sourceView !== "front") throw new Error("Character manifest Land must retain its frozen non-looping front behavior.");
    assertFrozenFrameSemantics(animation, "Land", [140, 130, 130], true);
    return;
  }
  if (animationId === "turn") {
    if (animation.revision !== "r1") throw new Error("Character manifest TURN must use frozen r1.");
    if (animation.loop || animation.sourceView !== "side-right-to-side-left") throw new Error("Character manifest TURN must use the frozen side-to-side sequence.");
    if (animation.nextState !== "WALK") throw new Error("Character manifest TURN must lead into WALK.");
    if (animation.interruptPolicy !== "interruptible_by_user_interaction") throw new Error("Character manifest TURN must allow direct user-interaction interruption.");
    assertFrozenFrameSemantics(animation, "TURN", [60, 80, 100, 80, 60], true);
    return;
  }
  const homeSemantics = {
    jump_air: ["side-left", "HOME_LAND", [230, 230, 220, 220], false, false],
    home_land: ["front-to-three-quarter-right", "HOME_IDLE", [120, 140, 160, 240], false, true],
    home_idle: ["front-to-three-quarter-right", "SLEEP", [320, 400, 520, 760], false, true],
    sleep: ["front", "SLEEP", [1050, 950, 1050, 1150], true, true],
  } as const;
  if (animationId in homeSemantics) {
    const [sourceView, nextState, durations, loop, groundContact] =
      homeSemantics[animationId as keyof typeof homeSemantics];
    if (animation.revision !== "r1" || animation.sourceView !== sourceView || animation.nextState !== nextState || animation.loop !== loop) {
      throw new Error(`Character manifest ${animationId} frozen semantics are invalid.`);
    }
    assertFrozenFrameSemantics(animation, animationId, durations, groundContact);
  }
}

function assertFrozenFrameSemantics(animation: RuntimeAnimation, label: string, expectedDurations: readonly number[], expectedGroundContact: boolean): void {
  if (animation.frames.length !== expectedDurations.length) throw new Error(`Character manifest ${label} timing must use its frozen frame count.`);
  for (const [index, frame] of animation.frames.entries()) {
    if (frame.durationMs !== expectedDurations[index]) throw new Error(`Character manifest ${label} timing does not match its frozen frames.`);
    if (frame.groundContact !== expectedGroundContact) throw new Error(`Character manifest ${label} ground-contact semantics are invalid.`);
  }
}

export function createDefaultRuntimeResources(manifest: CharacterManifest): DefaultRuntimeResources {
  return {
    canvas: manifest.canvas,
    runtimeWindow: manifest.runtimeWindow,
    idle: requiredFrozenAnimation(manifest, "idle"),
    blink: requiredFrozenAnimation(manifest, "blink"),
    walk: requiredFrozenAnimation(manifest, "walk"),
    lookMouse: requiredFrozenAnimation(manifest, "look_mouse"),
    happy: requiredFrozenAnimation(manifest, "happy"),
    drag: requiredFrozenAnimation(manifest, "drag"),
    fall: requiredFrozenAnimation(manifest, "fall"),
    land: requiredFrozenAnimation(manifest, "land"),
    turn: requiredFrozenAnimation(manifest, "turn"),
    jumpAir: requiredFrozenAnimation(manifest, "jump_air"),
    homeLand: requiredFrozenAnimation(manifest, "home_land"),
    homeIdle: requiredFrozenAnimation(manifest, "home_idle"),
    sleep: requiredFrozenAnimation(manifest, "sleep"),
  };
}

export async function loadDefaultRuntimeResources(fetchManifest: CharacterManifestFetcher): Promise<DefaultRuntimeResources> {
  const response = await fetchManifest(CHARACTER_MANIFEST_URL);
  if (!response.ok) throw new Error("LineDog could not load its character manifest.");
  return createDefaultRuntimeResources(parseCharacterManifest(await response.json()));
}
