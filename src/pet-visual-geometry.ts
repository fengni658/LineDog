import type { LogicalHitBox, RuntimeFrame } from "./pet-manifest";

export const HOME_DISPLAY_SCALE = 377 / 300;
export const VISUAL_FOOT = { x: 80, y: 140 } as const;

export function frameDisplayScale(frame: RuntimeFrame): number {
  return /^(home_idle|sleep)\//.test(frame.logicalAssetKey) ? HOME_DISPLAY_SCALE : 1;
}

/** Shared sprite and pointer projection around the canonical visual foot. */
export function projectFramePoint(
  frame: RuntimeFrame,
  point: { readonly x: number; readonly y: number },
  facing: "Left" | "Right",
): { x: number; y: number } {
  const scale = frameDisplayScale(frame);
  const dx = (point.x - frame.visualAnchor.x * 160 / 512) * scale;
  const dy = (point.y - frame.visualAnchor.y * 160 / 512) * scale;
  return { x: VISUAL_FOOT.x + (facing === "Left" ? -dx : dx), y: VISUAL_FOOT.y + dy };
}

export function projectFrameHitBox(
  frame: RuntimeFrame,
  box: LogicalHitBox,
  facing: "Left" | "Right",
): LogicalHitBox {
  const first = projectFramePoint(frame, box, facing);
  const last = projectFramePoint(frame, { x: box.x + box.width, y: box.y + box.height }, facing);
  // Pointer geometry remains in the native 160px surface, including clipping.
  const x = Math.max(0, Math.min(first.x, last.x));
  const y = Math.max(0, Math.min(first.y, last.y));
  return { x, y, width: Math.max(0, Math.min(160, Math.max(first.x, last.x)) - x),
    height: Math.max(0, Math.min(160, Math.max(first.y, last.y)) - y) };
}
