import type { LogicalHitBox, RuntimeFrame } from "./pet-manifest";
import type { LogicalPoint, LogicalWorkArea } from "./native-motion";
import { characterAnimationBounds } from "./character-visual-bounds";
import { computePetBubblePlacement } from "./pet-bubble-layout";

export interface PetBubbleSurface {
  textContent: string | null;
  readonly offsetWidth: number;
  readonly offsetHeight: number;
  readonly dataset: { visible?: string; compact?: string; side?: string };
  readonly style: { left: string; top: string };
}

export interface PetBubbleSurfaceGeometry {
  readonly frame?: RuntimeFrame;
  readonly facing: "Left" | "Right";
  readonly grabBounds: LogicalHitBox;
  readonly windowPosition?: LogicalPoint;
  readonly workArea?: LogicalWorkArea;
  readonly compact: boolean;
}

const envelopes = new WeakMap<PetBubbleSurface, { text: string; bounds: LogicalHitBox }>();

/** Uses real DOM border-box measurements; never touches native or hitbox state. */
export function updatePetBubbleSurface(element: PetBubbleSurface, geometry: PetBubbleSurfaceGeometry): void {
  // Preserve visibility during successful remeasurement. Hiding before an
  // offsetWidth read forces layout with a hidden caption and can restart fades.
  element.dataset.compact = String(geometry.compact);
  if (!element.textContent) { envelopes.delete(element); element.dataset.visible = "false"; return; }
  if (!geometry.frame || !geometry.windowPosition || !geometry.workArea) { element.dataset.visible = "false"; return; }
  const current = characterAnimationBounds(geometry.frame, geometry.facing);
  if (!current) { element.dataset.visible = "false"; return; }
  // Keep room for a previous sprite while its crossfade finishes. Retain the
  // conservative envelope for this caption rather than adding another timer.
  const old = envelopes.get(element);
  const previous = old?.text === element.textContent ? old.bounds : current;
  const x = Math.min(previous.x, current.x), y = Math.min(previous.y, current.y);
  const bodyBounds = { x, y,
    width: Math.max(previous.x + previous.width, current.x + current.width) - x,
    height: Math.max(previous.y + previous.height, current.y + current.height) - y };
  envelopes.set(element, { text: element.textContent, bounds: bodyBounds });
  const place = () => computePetBubblePlacement({
    bubbleSize: { width: element.offsetWidth, height: element.offsetHeight },
    bodyBounds, grabBounds: geometry.grabBounds,
    windowPosition: geometry.windowPosition!, workArea: geometry.workArea!,
  });
  let placement = place();
  if (!placement && !geometry.compact) {
    element.dataset.compact = "true";
    placement = place();
  }
  if (!placement) { element.dataset.visible = "false"; return; }
  element.style.left = `${placement.x}px`;
  element.style.top = `${placement.y}px`;
  element.dataset.side = placement.side;
  element.dataset.visible = "true";
}
