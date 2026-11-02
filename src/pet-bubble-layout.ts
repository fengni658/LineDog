import type { LogicalPoint, LogicalWorkArea } from "./native-motion";
import type { LogicalHitBox } from "./pet-manifest";

export interface PetBubbleLayoutInput {
  /** Actual border-box measurement in CSS/logical px, including padding. */
  readonly bubbleSize: { readonly width: number; readonly height: number };
  /** Projected visible body bounds in the canonical 160px pet canvas. */
  readonly bodyBounds: LogicalHitBox;
  /** Actual projected grab bounds; defaults to the frozen placeholder hitbox. */
  readonly grabBounds?: LogicalHitBox;
  /** Canonical window position and current WorkArea in the same logical space. */
  readonly windowPosition: LogicalPoint;
  readonly workArea: LogicalWorkArea;
}

export interface PetBubblePlacement extends LogicalHitBox {
  readonly side: "above" | "left" | "right";
}

const CANVAS_SIZE = 160;
const BODY_GAP = 1;
const DEFAULT_GRAB_BOUNDS = { x: 32, y: 28, width: 96, height: 110 } as const;

/**
 * Pure presentation geometry: never resizes the native window or its hitbox.
 * The caller remeasures/recomputes for new text, body frames, positions and
 * WorkArea facts. It hides the bubble on null; clipping text is not a fallback.
 * Physical pixels and per-monitor scale factors must not be passed here.
 */
export function computePetBubblePlacement(input: PetBubbleLayoutInput): PetBubblePlacement | null {
  const { bubbleSize: size, bodyBounds: visible, windowPosition: position, workArea: area } = input;
  const grab = input.grabBounds ?? DEFAULT_GRAB_BOUNDS;
  const values = [size.width, size.height, visible.x, visible.y, visible.width, visible.height,
    grab.x, grab.y, grab.width, grab.height, position.x, position.y, area.x, area.y, area.width, area.height];
  if (!values.every(Number.isFinite) || size.width <= 0 || size.height <= 0 ||
      visible.width <= 0 || visible.height <= 0 || grab.width <= 0 || grab.height <= 0 ||
      area.width <= 0 || area.height <= 0) return null;
  // Side placement avoids the grab region conservatively. Above the actual
  // head, existing transparent grab area may overlap the caption: the caption
  // is pointer-events:none and never changes or expands that existing region.
  const body = { x: Math.min(visible.x, grab.x), y: Math.min(visible.y, grab.y),
    width: 0, height: 0 };
  body.width = Math.max(visible.x + visible.width, grab.x + grab.width) - body.x;
  body.height = Math.max(visible.y + visible.height, grab.y + grab.height) - body.y;

  // Window clipping matters even with unlimited desktop space: a bubble
  // outside this surface cannot be drawn by a 160x160 native window.
  const left = Math.max(0, area.x - position.x);
  const top = Math.max(0, area.y - position.y);
  const right = Math.min(CANVAS_SIZE, area.x + area.width - position.x);
  const bottom = Math.min(CANVAS_SIZE, area.y + area.height - position.y);
  if (right - left < size.width || bottom - top < size.height) return null;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const centeredX = clamp(body.x + (body.width - size.width) / 2, left, right - size.width);
  const aboveBottom = Math.min(bottom, visible.y - BODY_GAP);
  if (aboveBottom - top >= size.height) {
    return { x: centeredX, y: aboveBottom - size.height, ...size, side: "above" };
  }

  const centeredY = clamp(body.y + (body.height - size.height) / 2, top, bottom - size.height);
  const rightStart = Math.max(left, body.x + body.width + BODY_GAP);
  const leftEnd = Math.min(right, body.x - BODY_GAP);
  // Pick the roomier side first so layout does not prefer the nearest edge.
  const candidates = [
    { x: rightStart, available: right - rightStart, side: "right" as const },
    { x: leftEnd - size.width, available: leftEnd - left, side: "left" as const },
  ].sort((a, b) => b.available - a.available);
  for (const candidate of candidates) {
    if (candidate.available >= size.width) {
      return { x: candidate.x, y: centeredY, ...size, side: candidate.side };
    }
  }
  // Most normal frames have only 32px at either side. Honest hiding is safer
  // than covering the body, shrinking copy or expanding transparent capture.
  return null;
}
