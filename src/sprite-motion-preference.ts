export interface MotionPreference {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

/** Cancel an in-flight dissolve as soon as the OS requests less motion. */
export function observeSpriteMotionPreference(
  preference: MotionPreference,
  settleCurrentFrame: () => void,
): { allowsCrossfade(): boolean; dispose(): void } {
  const changed = () => { if (preference.matches) settleCurrentFrame(); };
  preference.addEventListener("change", changed);
  return {
    allowsCrossfade: () => !preference.matches,
    dispose: () => preference.removeEventListener("change", changed),
  };
}
