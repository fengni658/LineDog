import { describe, expect, it } from "vitest";
import { computePetBubblePlacement, type PetBubbleLayoutInput, type PetBubblePlacement } from "../src/pet-bubble-layout";

const body = { x: 32, y: 22.5, width: 96, height: 117.5 };
const area = { x: 0, y: 0, width: 1_000, height: 600 };
const input = (overrides: Partial<PetBubbleLayoutInput> = {}): PetBubbleLayoutInput => ({
  bubbleSize: { width: 92, height: 18 }, bodyBounds: body,
  windowPosition: { x: 420, y: 440 }, workArea: area, ...overrides,
});
const overlap = (a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

function assertSafe(data: PetBubbleLayoutInput, placement: PetBubblePlacement | null): asserts placement is PetBubblePlacement {
  expect(placement).not.toBeNull();
  if (!placement) throw Error("expected a visible placement");
  expect(placement.x).toBeGreaterThanOrEqual(0);
  expect(placement.y).toBeGreaterThanOrEqual(0);
  expect(placement.x + placement.width).toBeLessThanOrEqual(160);
  expect(placement.y + placement.height).toBeLessThanOrEqual(160);
  expect(placement.x + data.windowPosition.x).toBeGreaterThanOrEqual(data.workArea.x);
  expect(placement.y + data.windowPosition.y).toBeGreaterThanOrEqual(data.workArea.y);
  expect(placement.x + placement.width + data.windowPosition.x).toBeLessThanOrEqual(data.workArea.x + data.workArea.width);
  expect(placement.y + placement.height + data.windowPosition.y).toBeLessThanOrEqual(data.workArea.y + data.workArea.height);
  expect(overlap(placement, data.bodyBounds)).toBe(false);
  expect(overlap(placement, data.grabBounds ?? { x: 32, y: 28, width: 96, height: 110 })).toBe(false);
}

describe("bubble placement inside the existing native surface", () => {
  it("prefers above the real head without covering its lower grab region", () => {
    const data = input();
    const placement = computePetBubblePlacement(data);
    assertSafe(data, placement);
    expect(placement).toEqual({ x: 34, y: 3.5, width: 92, height: 18, side: "above" });
  });

  it("fits a compact playful bubble exactly above a 15px-high head", () => {
    const data = input({ bodyBounds: { ...body, y: 15 }, bubbleSize: { width: 80, height: 14 } });
    const placement = computePetBubblePlacement(data);
    assertSafe(data, placement);
    expect(placement.y).toBe(0);
    expect(placement.side).toBe("above");
  });

  it("hides a measured normal bubble if neither headroom nor sides can hold it", () => {
    expect(computePetBubblePlacement(input({ bodyBounds: { ...body, y: 15 } }))).toBeNull();
  });

  it.each([{ x: 0, y: 0 }, { x: 840, y: 0 }, { x: 0, y: 440 }, { x: 840, y: 440 }])(
    "stays readable at the WorkArea corner %j", windowPosition => {
      const data = input({ windowPosition });
      const placement = computePetBubblePlacement(data);
      assertSafe(data, placement);
      expect(placement.side).toBe("above");
    },
  );

  it.each([{ x: -12, y: 100 }, { x: 902, y: 100 }])(
    "clamps horizontally within the visible window/WorkArea intersection at %j", windowPosition => {
      const data = input({ windowPosition });
      assertSafe(data, computePetBubblePlacement(data));
    },
  );

  it("tries a genuinely roomy right side when the upper WorkArea clips the headroom", () => {
    const smallBody = { x: 15, y: 16, width: 30, height: 100 };
    const data = input({ bodyBounds: smallBody, grabBounds: smallBody, windowPosition: { x: 300, y: -10 } });
    const placement = computePetBubblePlacement(data);
    assertSafe(data, placement);
    expect(placement.side).toBe("right");
    expect(placement.x).toBe(46);
  });

  it("tries the left side at the right screen edge and never hangs outside the native window", () => {
    const smallBody = { x: 110, y: 10, width: 25, height: 100 };
    const data = input({ bodyBounds: smallBody, grabBounds: smallBody, windowPosition: { x: 875, y: 50 } });
    const placement = computePetBubblePlacement(data);
    assertSafe(data, placement);
    expect(placement.side).toBe("left");
    expect(placement.x).toBe(17);
  });

  it("keeps side copy clear of a grab box wider than the visible body", () => {
    const data = input({ bodyBounds: { x: 15, y: 16, width: 30, height: 100 }, windowPosition: { x: 300, y: -10 } });
    expect(computePetBubblePlacement(data)).toBeNull();
  });

  it("clamps vertical side placement away from the lower WorkArea edge", () => {
    const smallBody = { x: 0, y: 8, width: 20, height: 140 };
    const data = input({ bodyBounds: smallBody, grabBounds: smallBody, windowPosition: { x: 50, y: 545 } });
    const placement = computePetBubblePlacement(data);
    assertSafe(data, placement);
    expect(placement.y + placement.height).toBe(55);
  });

  it("hides rather than clipping when too little WorkArea remains at top or bottom", () => {
    expect(computePetBubblePlacement(input({ windowPosition: { x: 50, y: -150 } }))).toBeNull();
    expect(computePetBubblePlacement(input({ windowPosition: { x: 50, y: 590 } }))).toBeNull();
  });

  it("recomputes from current screen facts including a negative monitor origin", () => {
    const original = input();
    const translated = input({ windowPosition: { x: -1580, y: 240 }, workArea: { ...area, x: -2000, y: -200 } });
    expect(computePetBubblePlacement(translated)).toEqual(computePetBubblePlacement(original));
    const clipped = { ...translated, workArea: { ...translated.workArea, y: 250 } };
    expect(computePetBubblePlacement(clipped)).toBeNull();
    expect(computePetBubblePlacement(translated)).not.toBeNull();
  });

  it.each([1, 1.25, 1.5, 2])( "uses the same canonical logical inputs after HWND DPI %s conversion", scale => {
    const logical = input({ windowPosition: { x: -840, y: 220 }, workArea: { ...area, x: -1_000, y: -100 } });
    // Native is the sole conversion boundary. Layout receives its normalized
    // facts and CSS measurements, never physical pixels or a second scale.
    const physicalPosition = { x: logical.windowPosition.x * scale, y: logical.windowPosition.y * scale };
    const physicalArea = { x: logical.workArea.x * scale, y: logical.workArea.y * scale,
      width: logical.workArea.width * scale, height: logical.workArea.height * scale };
    const normalized = { ...logical,
      windowPosition: { x: physicalPosition.x / scale, y: physicalPosition.y / scale },
      workArea: { x: physicalArea.x / scale, y: physicalArea.y / scale,
        width: physicalArea.width / scale, height: physicalArea.height / scale } };
    expect(computePetBubblePlacement(normalized)).toEqual(computePetBubblePlacement(logical));
    assertSafe(normalized, computePetBubblePlacement(normalized));
  });

  it.each([
    { bubbleSize: { width: 0, height: 18 } },
    { bubbleSize: { width: 180, height: 18 } },
    { bubbleSize: { width: 92, height: 170 } },
    { bubbleSize: { width: NaN, height: 18 } },
    { bodyBounds: { ...body, height: 0 } },
    { grabBounds: { ...body, x: Infinity } },
    { windowPosition: { x: NaN, y: 100 } },
    { windowPosition: { x: 2000, y: 100 } },
    { workArea: { ...area, height: -1 } },
  ])("fails closed for invalid or unavailable geometry %j", overrides => {
    expect(computePetBubblePlacement(input(overrides))).toBeNull();
  });
});
