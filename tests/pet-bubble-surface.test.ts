import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import { characterAnimationBounds } from "../src/character-visual-bounds";
import { projectFrameHitBox } from "../src/pet-visual-geometry";
import { updatePetBubbleSurface, type PetBubbleSurface, type PetBubbleSurfaceGeometry } from "../src/pet-bubble-surface";

const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(
  readFileSync(new URL("../public/character/manifest.json", import.meta.url), "utf8"),
)));
function surface(): PetBubbleSurface {
  return { textContent: "陪着你呀", dataset: {}, style: { left: "", top: "" },
    get offsetWidth() { return this.dataset.compact === "true" ? 60 : 68; },
    get offsetHeight() { return this.dataset.compact === "true" ? 14 : 18; } };
}
const geometry = (overrides: Partial<PetBubbleSurfaceGeometry> = {}): PetBubbleSurfaceGeometry => ({
  frame: resources.idle.frames[0], facing: "Right", grabBounds: { x: 32, y: 28, width: 96, height: 110 },
  windowPosition: { x: 100, y: 460 }, workArea: { x: 0, y: 0, width: 800, height: 600 },
  compact: false, ...overrides,
});

describe("bubble surface with original character alpha geometry", () => {
  it.each([resources.idle, resources.blink, resources.lookMouse, resources.homeIdle, resources.sleep])(
    "keeps one stable readable placement across $animationId original frames", animation => {
      const element = surface();
      const positions: string[] = [];
      for (const frame of animation.frames) {
        const input = geometry({ frame });
        updatePetBubbleSurface(element, input);
        expect(element.dataset.visible).toBe("true");
        expect(element.dataset.compact).toBe("false");
        const body = characterAnimationBounds(frame, "Right")!;
        expect(Number.parseFloat(element.style.top) + element.offsetHeight + 1).toBeLessThanOrEqual(body.y);
        positions.push(element.style.top);
      }
      expect(new Set(positions).size).toBe(1);
    },
  );

  it("fits the compact caption above the actual 15px happy headroom", () => {
    const element = surface();
    updatePetBubbleSurface(element, geometry({ frame: resources.happy.frames[2], compact: true }));
    expect(element.dataset).toMatchObject({ visible: "true", compact: "true", side: "above" });
    expect(element.style.top).toBe("0px");
    expect(characterAnimationBounds(resources.happy.frames[2], "Right")!.y).toBe(15);
  });

  it("shows Home copy above visible fur even when the original projected grab box reaches y=0", () => {
    const element = surface();
    const frame = resources.homeIdle.frames[0];
    const grabBounds = projectFrameHitBox(frame, { x: 32, y: 28, width: 96, height: 110 }, "Right");
    expect(grabBounds.y).toBe(0);
    const before = JSON.stringify(grabBounds);
    updatePetBubbleSurface(element, geometry({ frame, grabBounds }));
    expect(element.dataset.visible).toBe("true");
    expect(Number.parseFloat(element.style.top) + element.offsetHeight + 1).toBeLessThanOrEqual(characterAnimationBounds(frame, "Right")!.y);
    expect(JSON.stringify(grabBounds)).toBe(before);
  });

  it("keeps room for the outgoing happy frame through a later idle crossfade", () => {
    const element = surface();
    updatePetBubbleSurface(element, geometry({ frame: resources.happy.frames[2] }));
    const before = { ...element.style };
    updatePetBubbleSurface(element, geometry());
    expect(element.dataset.compact).toBe("true");
    expect(element.style.top).toBe(before.top);
    expect(Math.abs(Number.parseFloat(element.style.left) - Number.parseFloat(before.left))).toBeLessThan(1);
    element.textContent = "";
    updatePetBubbleSurface(element, geometry());
    expect(element.dataset.visible).toBe("false");
    element.textContent = "看见你啦";
    updatePetBubbleSurface(element, geometry());
    expect(element.dataset.compact).toBe("false");
    expect(Number.parseFloat(element.style.top)).toBeGreaterThan(0);
  });

  it("recomputes a negative-origin monitor and hides at a clipped top edge", () => {
    const element = surface();
    const input = geometry({ workArea: { x: -800, y: -200, width: 800, height: 600 }, windowPosition: { x: -800, y: 260 } });
    const original = JSON.stringify(input);
    updatePetBubbleSurface(element, input);
    expect(element.dataset.visible).toBe("true");
    expect(Number.parseFloat(element.style.left)).toBeGreaterThanOrEqual(0);
    updatePetBubbleSurface(element, { ...input, windowPosition: { x: -800, y: -220 } });
    expect(element.dataset.visible).toBe("false");
    expect(JSON.stringify(input)).toBe(original);
  });

  it("does not invent geometry before the first native facts or for unknown assets", () => {
    const element = surface();
    updatePetBubbleSurface(element, geometry({ workArea: undefined }));
    expect(element.dataset.visible).toBe("false");
    updatePetBubbleSurface(element, geometry({ frame: { ...resources.idle.frames[0], logicalAssetKey: "unknown/frame.png" } }));
    expect(element.dataset.visible).toBe("false");
  });
});

it("does not transiently hide a visible caption while measuring an unchanged layout", () => {
  const element = surface();
  updatePetBubbleSurface(element, geometry());
  const states: Array<string | undefined> = [];
  Object.defineProperty(element, "offsetWidth", { get() { states.push(element.dataset.visible); return 68; } });
  for (let tick = 0; tick < 8; tick++) updatePetBubbleSurface(element, geometry());
  expect(states).not.toContain("false");
});
