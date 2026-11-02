import { describe, expect, it, vi } from "vitest";
import { observeSpriteMotionPreference } from "../src/sprite-motion-preference";

describe("sprite motion preference", () => {
  it("honors the initial preference and settles only when motion becomes reduced", () => {
    const listeners = new Set<() => void>();
    const media = {
      matches: true,
      addEventListener: (_: "change", cb: () => void) => { listeners.add(cb); },
      removeEventListener: (_: "change", cb: () => void) => { listeners.delete(cb); },
    };
    const settle = vi.fn();
    const preference = observeSpriteMotionPreference(media, settle);
    expect(preference.allowsCrossfade()).toBe(false);
    media.matches = false; listeners.forEach(cb => cb());
    expect(preference.allowsCrossfade()).toBe(true);
    expect(settle).not.toHaveBeenCalled();
    media.matches = true; listeners.forEach(cb => cb());
    expect(settle).toHaveBeenCalledOnce();
    expect(preference.allowsCrossfade()).toBe(false);
    preference.dispose();
    expect(listeners.size).toBe(0);
  });
});
