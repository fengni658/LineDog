import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";

const EXPECTED_ACTIONS = [
  "idle",
  "blink",
  "walk",
  "happy",
  "look_mouse",
  "drag",
  "fall",
  "land",
  "turn",
  "jump_air",
  "home_land",
  "home_idle",
  "sleep",
];

function loadJson(relativeUrl: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8"),
  ) as Record<string, unknown>;
}

describe("production manifest schema", () => {
  it("loads the actual production manifest through the complete runtime loader", () => {
    const resources = createDefaultRuntimeResources(
      parseCharacterManifest(loadJson("../public/character/manifest.json")),
    );
    expect(resources.jumpAir.frames.map((frame) => frame.durationMs)).toEqual([230, 230, 220, 220]);
    expect(resources.land.frames.map((frame) => frame.durationMs)).toEqual([140, 130, 130]);
    expect(resources.sleep.frames).toHaveLength(4);
    expect(resources.sleep.frames[0].logicalAssetKey).toBe("sleep/frame_01.png");
  });

  it("keeps schema prefixItems and cardinality aligned with 13 actions and 51 frames", () => {
    const schema = loadJson("../public/character/character-manifest-v2.schema.json");
    const manifest = loadJson("../public/character/manifest.json");
    const animationsSchema = (
      (schema.properties as Record<string, unknown>).animations as Record<string, unknown>
    );
    const prefixItems = animationsSchema.prefixItems as Array<Record<string, unknown>>;
    const definitions = schema.$defs as Record<string, Record<string, unknown>>;
    const schemaActionIds = prefixItems.map((item) => {
      const reference = item.$ref as string | undefined;
      const actionSchema = reference
        ? definitions[reference.replace("#/$defs/", "")]
        : item;
      const allOf = actionSchema.allOf as Array<Record<string, unknown>>;
      const properties = allOf[1].properties as Record<string, Record<string, unknown>>;
      return properties.id.const;
    });
    const animations = manifest.animations as Array<Record<string, unknown>>;

    expect(JSON.stringify(schema)).not.toContain("undefined");
    expect(animationsSchema.minItems).toBe(13);
    expect(animationsSchema.maxItems).toBe(13);
    expect(prefixItems).toHaveLength(13);
    expect(schemaActionIds).toEqual(EXPECTED_ACTIONS);
    expect(animations.map((animation) => animation.id)).toEqual(EXPECTED_ACTIONS);
    expect(
      animations.reduce(
        (count, animation) => count + (animation.frames as unknown[]).length,
        0,
      ),
    ).toBe(51);
  });

  it("keeps the Home landing, settling, and sleep cadence deliberately slow", () => {
    const manifest = loadJson("../public/character/manifest.json");
    const animations = manifest.animations as Array<Record<string, unknown>>;
    const durations = (id: string): number[] => {
      const animation = animations.find((item) => item.id === id);
      expect(animation).toBeDefined();
      return animation?.frameDurationsMs as number[];
    };
    const total = (values: number[]): number =>
      values.reduce((sum, duration) => sum + duration, 0);

    expect(durations("home_land")).toEqual([120, 140, 160, 240]);
    expect(total(durations("home_land"))).toBe(660);
    expect(durations("home_idle")).toEqual([320, 400, 520, 760]);
    expect(total(durations("home_idle"))).toBe(2_000);
    expect(durations("sleep")).toEqual([1_050, 950, 1_050, 1_150]);
    expect(total(durations("sleep"))).toBe(4_200);
  });
});
