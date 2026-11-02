import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUNTIME_FOOT_BASELINE_LOGICAL_PX } from "../src/pet-behavior-core";

/**
 * A few layout constants exist independently in TypeScript and in Rust, and a
 * silent divergence between the two shows up as the pet standing at the wrong
 * height rather than as a test failure. These assertions pin the pairs together
 * so a change on one side cannot land without the other.
 */
describe("cross-language layout constants", () => {
  function readRustSource(fileName: string): string {
    return readFileSync(new URL(`../src-tauri/src/${fileName}`, import.meta.url), "utf8");
  }

  it("keeps the Rust foot anchor in sync with the TypeScript baseline", () => {
    const source = readRustSource("window_host.rs");
    const match = source.match(
      /NATIVE_PET_FOOT_ANCHOR_LOGICAL_PX:\s*f64\s*=\s*([0-9]+(?:\.[0-9]+)?)/,
    );

    expect(match, "NATIVE_PET_FOOT_ANCHOR_LOGICAL_PX must stay declared").not.toBeNull();
    expect(Number(match?.[1])).toBe(RUNTIME_FOOT_BASELINE_LOGICAL_PX);
  });
});
