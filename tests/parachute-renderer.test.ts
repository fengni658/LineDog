import { describe, expect, it } from "vitest";
import { applyParachuteVisual, createParachuteMarkup } from "../src/parachute-renderer";

describe("parachute vector rendering", () => {
  it("keeps the accessory decorative and bounds partial deployment", () => {
    const values = new Map<string, string>();
    const element = { dataset: {}, style: { setProperty: (key: string, value: string) => values.set(key, value) } } as unknown as HTMLElement;
    applyParachuteVisual(element, "OPENING", 0.5);
    expect(values.get("--parachute-open")).toBe("0.5");
    applyParachuteVisual(element, "GLIDING", Infinity);
    expect(values.get("--parachute-open")).toBe("0");
    applyParachuteVisual(element, "NONE", 1);
    expect(values.get("--parachute-open")).toBe("0");
    expect(createParachuteMarkup()).toContain('aria-hidden="true"');
    expect(createParachuteMarkup()).not.toContain("tabindex");
  });
});
