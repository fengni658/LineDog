import frozenManifest from "../public/character/manifest.json";
import { describe, expect, it } from "vitest";

import {
  createDefaultRuntimeResources,
  parseCharacterManifest,
  resolveCharacterResourceUrl,
} from "../src/pet-manifest";

describe("LineDog character manifest", () => {
  it("accepts schemaVersion 1 and exposes only frozen runtime resources, including DRAG r1 and TURN r1", () => {
    const resources = createDefaultRuntimeResources(
      parseCharacterManifest(frozenManifest),
    );

    expect(resources.canvas).toEqual({
      width: 512,
      height: 512,
      centerX: 256,
      footBaseline: 448,
      safeMargin: 48,
    });
    expect(resources.idle.status).toBe("FROZEN");
    expect(resources.idle.revision).toBe("r1");
    expect(resources.blink.status).toBe("FROZEN");
    expect(resources.blink.revision).toBe("r4");
    expect(resources.walk.status).toBe("FROZEN");
    expect(resources.walk.revision).toBe("r1");
    expect(resources.lookMouse.status).toBe("FROZEN");
    expect(resources.lookMouse.revision).toBe("r2");
    expect(resources.happy.status).toBe("FROZEN");
    expect(resources.happy.revision).toBe("r1");
    expect(resources.drag.status).toBe("FROZEN");
    expect(resources.drag.revision).toBe("r1");
    expect(resources.fall.status).toBe("FROZEN");
    expect(resources.fall.revision).toBe("r1");
    expect(resources.land.status).toBe("FROZEN");
    expect(resources.land.revision).toBe("r2");
    expect((resources as unknown as { turn: { status: string; revision: string } }).turn).toMatchObject({
      status: "FROZEN",
      revision: "r1",
    });
    expect(resources.idle.frames.map((frame) => frame.url)).toEqual([
      "/character/idle/frame_01.png",
      "/character/idle/frame_02.png",
      "/character/idle/frame_03.png",
      "/character/idle/frame_04.png",
    ]);
    expect(resources.blink.frames.map((frame) => frame.durationMs)).toEqual([
      120,
      160,
      220,
    ]);
    expect(resources.walk.frames.map((frame) => frame.durationMs)).toEqual([
      130,
      130,
      130,
      130,
      130,
      130,
    ]);
    expect(resources.lookMouse.frames.map((frame) => frame.durationMs)).toEqual([
      120,
      140,
      220,
    ]);
    expect(resources.happy.frames.map((frame) => frame.durationMs)).toEqual([
      120,
      140,
      180,
      140,
      220,
    ]);
    expect(resources.drag.frames.map((frame) => frame.durationMs)).toEqual([
      220,
      220,
    ]);
    expect(resources.fall.frames.map((frame) => frame.durationMs)).toEqual([
      140,
      140,
    ]);
    expect(resources.land.frames.map((frame) => frame.durationMs)).toEqual([
      90,
      80,
      80,
    ]);
    expect(
      (resources as unknown as { turn: { frames: readonly { durationMs: number }[] } }).turn.frames.map(
        (frame) => frame.durationMs,
      ),
    ).toEqual([60, 80, 100, 80, 60]);
  });

  it("uses a frame override before the animation default and keeps URLs under /character/", () => {
    const resources = createDefaultRuntimeResources(
      parseCharacterManifest(frozenManifest),
    );

    expect(resources.idle.frames.map((frame) => frame.durationMs)).toEqual([
      420,
      320,
      420,
      320,
    ]);
    expect(resolveCharacterResourceUrl("blink/frame_01.png")).toBe(
      "/character/blink/frame_01.png",
    );
    expect(() => resolveCharacterResourceUrl("../outside.png")).toThrow(
      /character resource path/i,
    );
  });

  it("requires all nine frozen runtime resources and fails closed for missing or candidate actions", () => {
    const resources = createDefaultRuntimeResources(
      parseCharacterManifest(frozenManifest),
    );

    expect(Object.keys(resources).sort()).toEqual([
      "blink",
      "canvas",
      "drag",
      "fall",
      "happy",
      "idle",
      "land",
      "lookMouse",
      "turn",
      "walk",
    ]);

    const nonFrozenWalk = structuredClone(frozenManifest);
    nonFrozenWalk.animations.walk.status = "CANDIDATE_READY";
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(nonFrozenWalk)),
    ).toThrow(/frozen walk/i);

    const nonFrozenDrag = structuredClone(frozenManifest);
    nonFrozenDrag.animations.drag.status = "CANDIDATE_READY";
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(nonFrozenDrag)),
    ).toThrow(/frozen drag/i);

    const missingDrag = structuredClone(frozenManifest) as {
      animations: Record<string, unknown>;
    };
    delete missingDrag.animations.drag;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(missingDrag)),
    ).toThrow(/frozen drag/i);

    const missingWalk = structuredClone(frozenManifest) as {
      animations: Record<string, unknown>;
    };
    delete missingWalk.animations.walk;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(missingWalk)),
    ).toThrow(/frozen walk/i);

    const nonFrozenLook = structuredClone(frozenManifest);
    nonFrozenLook.animations.look_mouse.status = "CANDIDATE_READY";
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(nonFrozenLook)),
    ).toThrow(/frozen look_mouse/i);

    const missingHappy = structuredClone(frozenManifest) as {
      animations: Record<string, unknown>;
    };
    delete missingHappy.animations.happy;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(missingHappy)),
    ).toThrow(/frozen happy/i);

    const nonFrozenFall = structuredClone(frozenManifest);
    nonFrozenFall.animations.fall.status = "CANDIDATE_READY";
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(nonFrozenFall)),
    ).toThrow(/frozen fall/i);

    const missingLand = structuredClone(frozenManifest) as {
      animations: Record<string, unknown>;
    };
    delete missingLand.animations.land;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(missingLand)),
    ).toThrow(/frozen land/i);

    const nonFrozenTurn = structuredClone(frozenManifest);
    nonFrozenTurn.animations.turn.status = "CANDIDATE_READY";
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(nonFrozenTurn)),
    ).toThrow(/frozen turn/i);

    const missingTurn = structuredClone(frozenManifest) as {
      animations: Record<string, unknown>;
    };
    delete missingTurn.animations.turn;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(missingTurn)),
    ).toThrow(/frozen turn/i);
  });

  it("fails closed when TURN differs from its frozen revision, direction sequence, loop, or timing", () => {
    const wrongTurnRevision = structuredClone(frozenManifest);
    wrongTurnRevision.animations.turn.revision = "r2";
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongTurnRevision)),
    ).toThrow(/turn.*r1/i);

    const wrongTurnSourceView = structuredClone(frozenManifest);
    wrongTurnSourceView.animations.turn.sourceView = "front";
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongTurnSourceView)),
    ).toThrow(/turn.*sequence/i);

    const wrongTurnLoop = structuredClone(frozenManifest);
    wrongTurnLoop.animations.turn.loop = true;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongTurnLoop)),
    ).toThrow(/turn.*non-loop/i);

    const wrongTurnTiming = structuredClone(frozenManifest);
    wrongTurnTiming.animations.turn.frames[2].durationMs = 99;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongTurnTiming)),
    ).toThrow(/turn.*timing/i);
  });

  it("fails closed when Fall or Land differs from its frozen revision, loop, or frame timing", () => {
    const wrongFallRevision = structuredClone(frozenManifest);
    wrongFallRevision.animations.fall.revision = "r2";
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongFallRevision)),
    ).toThrow(/fall.*r1/i);

    const wrongFallTiming = structuredClone(frozenManifest);
    wrongFallTiming.animations.fall.frames[1].durationMs = 141;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongFallTiming)),
    ).toThrow(/fall.*timing/i);

    const wrongLandLoop = structuredClone(frozenManifest);
    wrongLandLoop.animations.land.loop = true;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongLandLoop)),
    ).toThrow(/land.*non-loop/i);

    const wrongLandTiming = structuredClone(frozenManifest);
    wrongLandTiming.animations.land.frames[0].durationMs = 80;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongLandTiming)),
    ).toThrow(/land.*timing/i);
  });

  it("fails closed when Drag differs from its frozen revision, loop, or frame timing", () => {
    const wrongDragRevision = structuredClone(frozenManifest);
    wrongDragRevision.animations.drag.revision = "r2";
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongDragRevision)),
    ).toThrow(/drag.*r1/i);

    const wrongDragLoop = structuredClone(frozenManifest);
    wrongDragLoop.animations.drag.loop = false;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongDragLoop)),
    ).toThrow(/drag.*loop/i);

    const wrongDragTiming = structuredClone(frozenManifest);
    wrongDragTiming.animations.drag.frames[1].durationMs = 221;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(wrongDragTiming)),
    ).toThrow(/drag.*timing/i);
  });

  it("rejects malformed schema input and a missing or non-frozen required animation", () => {
    expect(() =>
      parseCharacterManifest({ ...frozenManifest, schemaVersion: 2 }),
    ).toThrow(/schemaVersion/i);

    const nonFrozen = structuredClone(frozenManifest);
    nonFrozen.animations.blink.status = "CANDIDATE_READY";
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(nonFrozen)),
    ).toThrow(/frozen blink/i);

    const missingBlink = structuredClone(frozenManifest) as {
      animations: Record<string, unknown>;
    };
    delete missingBlink.animations.blink;
    expect(() =>
      createDefaultRuntimeResources(parseCharacterManifest(missingBlink)),
    ).toThrow(/frozen blink/i);
  });
});
