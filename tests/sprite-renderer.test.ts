import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RuntimeFrame } from "../src/pet-manifest";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import { HOME_DISPLAY_SCALE, frameDisplayScale, projectFrameHitBox, projectFramePoint } from "../src/pet-visual-geometry";
import {
  applySpriteDraggingState,
  applySpriteSleepingState,
  applySpriteVisualAnchorOffset,
  createSpriteSurfaceMarkup,
  resolveSpriteFacing,
  SmoothSpriteFrameRenderer,
  CROSSFADE_ANIMATION_IDS,
  SPRITE_CROSSFADE_MS,
  type SpriteCrossfadePort,
} from "../src/sprite-renderer";

function frame(
  motionX: number,
  kind: "FOOT_CENTER" | "AIRBORNE_REFERENCE" = "FOOT_CENTER",
  visualX = 256,
  visualY = 448,
): RuntimeFrame {
  return {
    url: "/frame.png",
    logicalAssetKey: "home_land/frame_01.png",
    src: "home_land/frame_01.png",
    durationMs: 100,
    groundContact: kind === "FOOT_CENTER",
    visualAnchor: { x: visualX, y: visualY },
    motionAnchor: {
      kind,
      x: motionX,
      y: kind === "FOOT_CENTER" ? 448 : 300,
    },
    contactGeometry:
      kind === "FOOT_CENTER"
        ? { kind: "FOOT_SEGMENT", leftX: 220, rightX: 292, y: 448 }
        : { kind: "AIRBORNE" },
  };
}

function offsetStyle(browserBaseURL?: string) {
  const values = new Map<string, string>();
  let source = "";
  return {
    values,
    sprite: {
      get src() {
        return browserBaseURL && source ? new URL(source, browserBaseURL).href : source;
      },
      set src(value: string) {
        source = value;
      },
      getAttribute: (name: string) => name === "src" ? source : null,
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        removeProperty: (name: string) => values.delete(name),
      },
    },
  };
}

function makeTimers() {
  const scheduled: { callback: () => void; dueAtMs: number }[] = [];
  let nowMs = 0;
  return {
    get nowMsValue() {
      return nowMs;
    },
    advanceBy(deltaMs: number) {
      nowMs += deltaMs;
      for (const entry of [...scheduled]) {
        if (entry.dueAtMs <= nowMs) {
          scheduled.splice(scheduled.indexOf(entry), 1);
          entry.callback();
        }
      }
    },
    timers: {
      setTimeout: (callback: () => void, delayMs: number) => {
        const entry = { callback, dueAtMs: nowMs + delayMs };
        scheduled.push(entry);
        return entry;
      },
      clearTimeout: (handle: unknown) => {
        const index = scheduled.indexOf(handle as (typeof scheduled)[number]);
        if (index >= 0) {
          scheduled.splice(index, 1);
        }
      },
    },
    get pendingCount() {
      return scheduled.length;
    },
  };
}

function makeCrossfadePort(browserBaseURL?: string): SpriteCrossfadePort & {
  spriteValues: Map<string, string>;
  underValues: Map<string, string>;
} {
  const main = offsetStyle(browserBaseURL);
  const under = offsetStyle(browserBaseURL);
  return {
    sprite: main.sprite,
    under: under.sprite,
    spriteValues: main.values,
    underValues: under.values,
  };
}

function frameWithURL(url: string): RuntimeFrame {
  return { ...frame(256), url };
}

describe("sprite facing", () => {
  it("keeps facing mirror discrete instead of transitioning through scaleX(0)", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const facingLayerRule = styles.match(/\.pet-facing-layer\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const spriteRule = styles.match(/\.pet-sprite\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(facingLayerRule).toContain("scaleX(var(--pet-facing-scale-x))");
    expect(facingLayerRule).not.toMatch(/transition\s*:/);
    expect(spriteRule).not.toContain("scaleX(var(--pet-facing-scale-x))");
  });

  it.each(["WALK", "LOOK", "GO_HOME", "DRAG"])(
    "keeps the runtime facing while %s uses directional frames",
    (behavior) => {
      expect(resolveSpriteFacing(behavior, "Left")).toBe("Left");
      expect(resolveSpriteFacing(behavior, "Right")).toBe("Right");
    },
  );

  it("keeps the frozen turn-frame mirror policy authoritative", () => {
    expect(resolveSpriteFacing("WALK", "Right", "TURN", true)).toBe("Left");
    expect(resolveSpriteFacing("WALK", "Left", "TURN", false)).toBe("Right");
  });

  it("reverses GO_HOME facing only for the side-left jump_air source", () => {
    expect(resolveSpriteFacing("GO_HOME", "Right", "NONE", false, "jump_air")).toBe(
      "Left",
    );
    expect(resolveSpriteFacing("GO_HOME", "Left", "NONE", false, "jump_air")).toBe(
      "Right",
    );
    expect(resolveSpriteFacing("GO_HOME", "Right", "NONE", false, "walk")).toBe(
      "Right",
    );
  });

  it("keeps LEAVE_HOME jump_air in its native side-left orientation", () => {
    expect(resolveSpriteFacing("LEAVE_HOME", "Left", "NONE", false, "jump_air")).toBe(
      "Right",
    );
  });

  it("does not mirror front-facing animations from stale movement state", () => {
    expect(resolveSpriteFacing("IDLE", "Left")).toBe("Right");
    expect(resolveSpriteFacing("HAPPY", "Left")).toBe("Right");
  });
});

describe("sprite dragging state", () => {
  it("publishes whether the pressed sprite is actively being dragged", () => {
    const stage = { dataset: {} as { dragging?: string } };
    applySpriteDraggingState(stage, true);
    expect(stage.dataset.dragging).toBe("true");
    applySpriteDraggingState(stage, false);
    expect(stage.dataset.dragging).toBe("false");
  });
});

describe("sprite sleeping presentation", () => {
  it("uses only gentle vertical breathing at the foot baseline, without zoom or animated decoration", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const sleepRule = styles.match(/\.pet-stage\[data-sleeping="true"\]:not\(\[data-dragging="true"\]\) \.pet-facing-layer\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(sleepRule).toContain("transform-origin: 50% 140px;");
    expect(sleepRule).toContain("animation: pet-sleep-breath 5.6s ease-in-out infinite;");
    expect(styles).toContain("scaleY(1.006)");
    expect(styles).not.toContain("scale(1.014)");
    expect(styles).not.toContain("1.055");
    expect(styles).not.toContain("pet-sleep-zzz-rise");
    expect(styles).not.toContain("pet-sleep-glow");
    const zzzRule = styles.match(/\.pet-sleep-zzz__letter\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(zzzRule).toContain("opacity: 0.55;");
    expect(zzzRule).not.toMatch(/animation\s*:/);
    expect(styles.split("@media (prefers-reduced-motion: reduce)")[1]).toContain("animation: none;");
  });

  it("includes a discrete facing layer and visible three-letter ZZZ closeup", () => {
    const markup = createSpriteSurfaceMarkup();
    expect(markup).toContain('class="pet-facing-layer"');
    expect(markup).toMatch(/pet-facing-layer[\s\S]*id="pet-sprite"/);
    expect(markup).toContain('class="pet-sleep-closeup"');
    expect(markup.match(/pet-sleep-zzz__letter--[123]/g)).toHaveLength(3);
    expect(markup.match(/>Z<\/span>/g)).toHaveLength(3);
  });

  it("shows the closeup only during the deep sleep animation", () => {
    const stage = { dataset: {} as { sleeping?: string } };
    applySpriteSleepingState(stage, "REST", "home_idle");
    expect(stage.dataset.sleeping).toBe("false");
    applySpriteSleepingState(stage, "REST", "sleep");
    expect(stage.dataset.sleeping).toBe("true");
    applySpriteSleepingState(stage, "LEAVE_HOME", "sleep");
    expect(stage.dataset.sleeping).toBe("false");
  });
});

describe("sprite visualAnchor stabilization", () => {
  it("mirrors a shifted frame around its normalized visual foot", () => {
    const shifted = frame(240, "FOOT_CENTER", 240, 432);
    const anchor = { x: 75, y: 135 };
    expect(projectFramePoint(shifted, anchor, "Right")).toEqual({ x: 80, y: 140 });
    expect(projectFramePoint(shifted, anchor, "Left")).toEqual({ x: 80, y: 140 });
    expect(projectFrameHitBox(shifted, { x: 65, y: 125, width: 30, height: 20 }, "Right"))
      .toEqual({ x: 70, y: 130, width: 30, height: 20 });
    expect(projectFrameHitBox(shifted, { x: 65, y: 125, width: 30, height: 20 }, "Left"))
      .toEqual({ x: 60, y: 130, width: 30, height: 20 });
  });

  it("scales exactly the eight Home idle/sleep frames around the fixed foot", () => {
    const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(readFileSync(
      new URL("../public/character/manifest.json", import.meta.url), "utf8"))));
    const frames = [...resources.homeIdle.frames, ...resources.sleep.frames];
    expect(frames).toHaveLength(8);
    for (const f of frames) {
      expect(frameDisplayScale(f)).toBe(HOME_DISPLAY_SCALE);
      for (const facing of ["Left", "Right"] as const) {
        expect(projectFramePoint(f, { x: 80, y: 140 }, facing)).toEqual({ x: 80, y: 140 });
        expect(projectFramePoint(f, { x: 80, y: 40 }, facing).y).toBeCloseTo(140 - 100 * 377 / 300);
      }
    }
    for (const f of [...resources.homeLand.frames, ...resources.drag.frames]) expect(frameDisplayScale(f)).toBe(1);
  });
  it.each([84.5, 118.5, 249, 278.5])(
    "does not translate the sprite when only motionAnchor x=%s changes",
    (motionX) => {
      const { sprite, values } = offsetStyle();
      applySpriteVisualAnchorOffset(sprite, frame(motionX), "Right");
      expect(values.get("--pet-anchor-translate-x")).toBe("0px");
      expect(values.get("--pet-anchor-translate-y")).toBe("0px");
    },
  );

  it("uses the stable visual anchor rather than the active contact foot", () => {
    const right = offsetStyle();
    const left = offsetStyle();
    const shiftedVisualAnchor = frame(84.5, "FOOT_CENTER", 240, 432);

    applySpriteVisualAnchorOffset(right.sprite, shiftedVisualAnchor, "Right");
    applySpriteVisualAnchorOffset(left.sprite, shiftedVisualAnchor, "Left");

    expect(right.values.get("--pet-anchor-translate-x")).toBe("5px");
    expect(left.values.get("--pet-anchor-translate-x")).toBe("5px");
    expect(right.values.get("--pet-anchor-translate-y")).toBe("5px");
  });

  it("keeps airborne frames stable when their visual anchor is canonical", () => {
    const { sprite, values } = offsetStyle();
    applySpriteVisualAnchorOffset(sprite, frame(249, "AIRBORNE_REFERENCE"), "Left");
    expect(values.get("--pet-anchor-translate-x")).toBe("0px");
    expect(values.get("--pet-anchor-translate-y")).toBe("0px");
  });
});

describe("drag presentation stability contract (not visual acceptance)", () => {
  interface ManifestAnimation {
    readonly id: string;
    readonly frames: {
      readonly geometry?: { readonly visualAnchor?: { readonly x: number; readonly y: number } };
    }[];
  }
  const manifest = JSON.parse(
    readFileSync(new URL("../public/character/manifest.json", import.meta.url), "utf8"),
  ) as { animations: ManifestAnimation[] };
  const drag = manifest.animations.find((entry) => entry.id === "drag");

  it("excludes drag from dissolves while preserving quiet animation fades", () => {
    expect(drag).toBeDefined();
    expect([...CROSSFADE_ANIMATION_IDS]).toEqual(["home_idle"]);
  });

  it.each([...CROSSFADE_ANIMATION_IDS])(
    "keeps %s slow enough for a dissolve to finish before the next frame",
    (animationId) => {
      const entry = manifest.animations.find((item) => item.id === animationId);
      const durations =
        (entry as unknown as { frameDurationsMs?: number[] }).frameDurationsMs ??
        [(entry as unknown as { frameDurationMs?: number }).frameDurationMs ?? 0];
      const shortest = Math.min(...durations);
      // 溶解未提交就来了下一帧，会把两次提交叠在一起，同样会闪。
      expect(shortest).toBeGreaterThan(SPRITE_CROSSFADE_MS + 30);
    },
  );

  it("keeps existing drag assets on one visual anchor without claiming pose correctness", () => {
    const anchors = new Set(
      (drag?.frames ?? []).map(
        (entry) => `${entry.geometry?.visualAnchor?.x},${entry.geometry?.visualAnchor?.y}`,
      ),
    );
    expect(anchors.size).toBe(1);
  });

  it("disables drag decoration and excludes stale sleep and pressed transforms", () => {
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const facingRule = styles.match(
      /\.pet-stage\[data-dragging="true"\]\s+\.pet-facing-layer\s*\{([\s\S]*?)\}/,
    )?.[1] ?? "";
    const spriteRule = styles.match(
      /\.pet-stage\[data-dragging="true"\]\s+\.pet-sprite\s*\{([\s\S]*?)\}/,
    )?.[1] ?? "";
    expect(facingRule).toContain("animation: none;");
    expect(facingRule).toContain("transform: scaleX(var(--pet-facing-scale-x));");
    expect(styles).not.toContain("pet-drag-float");
    expect(spriteRule).toContain("transition: none;");
    expect(spriteRule).toContain("--pet-sleep-scale: 1;");
    expect(spriteRule).toContain("--pet-press-scale: 1;");
    expect(spriteRule).toContain("--pet-press-translate-y: 0px;");
    expect(styles).not.toMatch(/\[data-sleeping="true"\]\s+\./);
    expect(styles).not.toContain('[data-pressed="true"]:not([data-dragging="true"])');
    expect(styles).toMatch(/\[data-dragging="true"\] \.pet-sleep-closeup\s*\{\s*opacity: 0;\s*transition: none;/);
  });
});

describe("smooth sprite frame renderer", () => {
  it("does not dissolve a repeated frame when DOM src resolves to an absolute URL", () => {
    const timers = makeTimers();
    const renderer = new SmoothSpriteFrameRenderer(timers.timers);
    const port = makeCrossfadePort("http://tauri.localhost/");
    const sameFrame = frameWithURL("/character/home_idle/frame_01.png");
    renderer.render(port, sameFrame, false);
    expect(port.sprite.src).toBe("http://tauri.localhost/character/home_idle/frame_01.png");

    renderer.render(port, sameFrame, true);

    expect(timers.pendingCount).toBe(0);
    expect(port.under.src).toBe("");
    expect(port.spriteValues.get("opacity")).toBe("1");
  });

  it("keeps the original dissolve deadline on repeated DOM frame delivery", () => {
    const timers = makeTimers();
    const renderer = new SmoothSpriteFrameRenderer(timers.timers);
    const port = makeCrossfadePort("http://tauri.localhost/");
    const oldFrame = frameWithURL("/character/home_idle/frame_01.png");
    const newFrame = frameWithURL("/character/home_idle/frame_02.png");
    renderer.render(port, oldFrame, false);
    renderer.render(port, newFrame, true);
    timers.advanceBy(80);

    renderer.render(port, newFrame, true);

    expect(port.sprite.src).toBe("http://tauri.localhost/character/home_idle/frame_01.png");
    expect(timers.pendingCount).toBe(1);
    timers.advanceBy(SPRITE_CROSSFADE_MS + 30 - 80);
    expect(port.sprite.src).toBe("http://tauri.localhost/character/home_idle/frame_02.png");
    expect(port.spriteValues.get("opacity")).toBe("1");
    expect(port.underValues.get("opacity")).toBe("0");
    expect(timers.pendingCount).toBe(0);
  });

  it("recognizes a committed DOM frame without starting another dissolve", () => {
    const timers = makeTimers();
    const renderer = new SmoothSpriteFrameRenderer(timers.timers);
    const port = makeCrossfadePort("http://tauri.localhost/");
    const newFrame = frameWithURL("/character/home_idle/frame_02.png");
    renderer.render(port, frameWithURL("/character/home_idle/frame_01.png"), false);
    renderer.render(port, newFrame, true);
    timers.advanceBy(SPRITE_CROSSFADE_MS + 30);

    renderer.render(port, newFrame, true);

    expect(timers.pendingCount).toBe(0);
    expect(port.spriteValues.get("opacity")).toBe("1");
    expect(port.underValues.get("opacity")).toBe("0");
  });

  it("dissolves into a new frame for slow animations and commits after the fade", () => {
    const timers = makeTimers();
    const renderer = new SmoothSpriteFrameRenderer(timers.timers);
    const port = makeCrossfadePort();
    port.sprite.src = "sleep/frame_01.png";

    renderer.render(port, frameWithURL("sleep/frame_02.png"), true);

    // 旧帧在上层淡出，新帧在下层立即全量显示（画面 = 新帧 + 旧帧×alpha）。
    expect(port.under.src).toBe("sleep/frame_02.png");
    expect(port.underValues.get("opacity")).toBe("1");
    expect(port.sprite.src).toBe("sleep/frame_01.png");
    expect(port.spriteValues.get("opacity")).toBe("0");
    expect(port.spriteValues.get("transition")).toContain("opacity");
    expect(timers.pendingCount).toBe(1);

    timers.advanceBy(SPRITE_CROSSFADE_MS + 30);

    // 提交后上层采纳新帧，并且是**瞬时**恢复不透明（transition: none）。
    // 若只是移除内联样式，样式表的 320ms opacity 过渡会让上层从 0 重新淡入，
    // 下层已归零，因此必须保留提交时的显式不透明终态。
    expect(port.sprite.src).toBe("sleep/frame_02.png");
    expect(port.spriteValues.get("opacity")).toBe("1");
    expect(port.spriteValues.get("transition")).toBe("none");
    expect(port.underValues.get("opacity")).toBe("0");
    renderer.dispose();
  });

  it("preserves each layer's frame geometry throughout a dissolve", () => {
    const timers = makeTimers();
    const renderer = new SmoothSpriteFrameRenderer(timers.timers);
    const port = makeCrossfadePort();
    const oldFrame = { ...frame(256), url: "/old.png", logicalAssetKey: "idle/frame_01.png" };
    const newFrame = { ...frame(256, "FOOT_CENTER", 240, 432),
      url: "/new.png", logicalAssetKey: "home_idle/frame_01.png" };
    renderer.render(port, oldFrame, false);
    renderer.render(port, newFrame, true);
    expect(port.spriteValues.get("--pet-frame-scale")).toBe("1");
    expect(port.spriteValues.get("--pet-anchor-translate-x")).toBe("0px");
    expect(port.underValues.get("--pet-frame-scale")).toBe(String(377 / 300));
    expect(port.underValues.get("--pet-anchor-translate-x")).toBe("5px");
    expect(port.underValues.get("transform-origin")).toBe("75px 135px");
    timers.advanceBy(SPRITE_CROSSFADE_MS + 30);
    expect(port.spriteValues.get("--pet-frame-scale")).toBe(String(377 / 300));
    expect(port.spriteValues.get("--pet-anchor-translate-x")).toBe("5px");
    expect(port.spriteValues.get("transform-origin")).toBe("75px 135px");
    renderer.dispose();
  });

  it("never leaves both layers dark after a dissolve commits", () => {
    const timers = makeTimers();
    const renderer = new SmoothSpriteFrameRenderer(timers.timers);
    const port = makeCrossfadePort();
    port.sprite.src = "sleep/frame_01.png";

    // 安静动画仍需保留提交时不透明的回归保护。
    renderer.render(port, frameWithURL("sleep/frame_02.png"), true);
    timers.advanceBy(SPRITE_CROSSFADE_MS + 30);
    renderer.render(port, frameWithURL("sleep/frame_01.png"), true);
    timers.advanceBy(SPRITE_CROSSFADE_MS + 30);

    const top = Number(port.spriteValues.get("opacity"));
    const bottom = Number(port.underValues.get("opacity"));
    expect(top).toBe(1);
    expect(bottom).toBe(0);
    renderer.dispose();
  });

  it("keeps hard cuts immediate for fast animations", () => {
    const timers = makeTimers();
    const renderer = new SmoothSpriteFrameRenderer(timers.timers);
    const port = makeCrossfadePort();
    port.sprite.src = "walk/frame_01.png";

    renderer.render(port, frameWithURL("walk/frame_02.png"), false);

    expect(port.sprite.src).toBe("walk/frame_02.png");
    expect(port.spriteValues.get("opacity")).toBe("1");
    expect(port.spriteValues.get("transition")).toBe("none");
    expect(port.underValues.get("opacity")).toBe("0");
    expect(timers.pendingCount).toBe(0);
    renderer.dispose();
  });

  it("commits an in-flight dissolve before starting a hard cut", () => {
    const timers = makeTimers();
    const renderer = new SmoothSpriteFrameRenderer(timers.timers);
    const port = makeCrossfadePort();
    port.sprite.src = "home_idle/frame_01.png";

    renderer.render(port, frameWithURL("home_idle/frame_02.png"), true);
    renderer.render(port, frameWithURL("drag/frame_01.png"), false);

    expect(port.sprite.src).toBe("drag/frame_01.png");
    expect(port.spriteValues.get("opacity")).toBe("1");
    expect(port.spriteValues.get("transition")).toBe("none");
    expect(port.underValues.get("opacity")).toBe("0");
    expect(timers.pendingCount).toBe(0);
    renderer.dispose();
  });

  it.each(["sleep/frame_01.png", "sleep/frame_02.png", "drag/frame_01.png"])(
    "cancels a mid-sleep fade synchronously on hard cut to %s, including repeated src",
    (target) => {
      const timers = makeTimers();
      const renderer = new SmoothSpriteFrameRenderer(timers.timers);
      const port = makeCrossfadePort();
      port.sprite.src = "sleep/frame_01.png";
      renderer.render(port, frameWithURL("sleep/frame_02.png"), true);
      timers.advanceBy(80);
      expect(timers.pendingCount).toBe(1);

      renderer.render(port, frameWithURL(target), false);
      expect(timers.pendingCount).toBe(0);
      expect(port.sprite.src).toBe(target);
      expect(port.spriteValues.get("opacity")).toBe("1");
      expect(port.spriteValues.get("transition")).toBe("none");
      expect(port.underValues.get("opacity")).toBe("0");
      expect(port.underValues.get("transition")).toBe("none");
      timers.advanceBy(1_000);
      renderer.render(port, frameWithURL(target), false);
      expect(port.sprite.src).toBe(target);
      expect(port.spriteValues.get("opacity")).toBe("1");
      expect(port.underValues.get("opacity")).toBe("0");
      expect(timers.pendingCount).toBe(0);
    },
  );

  it("ignores repeated delivery of the frame already shown", () => {
    const timers = makeTimers();
    const renderer = new SmoothSpriteFrameRenderer(timers.timers);
    const port = makeCrossfadePort();
    port.sprite.src = "home_idle/frame_01.png";

    renderer.render(port, frameWithURL("home_idle/frame_01.png"), true);

    expect(timers.pendingCount).toBe(0);
    expect(port.under.src).toBe("");
    renderer.dispose();
  });

  it("renders the dissolve underlay in front of nothing: under img sits before the main sprite", () => {
    const markup = createSpriteSurfaceMarkup();
    const underIndex = markup.indexOf('id="pet-sprite-under"');
    const mainIndex = markup.indexOf('id="pet-sprite"');
    expect(underIndex).toBeGreaterThanOrEqual(0);
    expect(underIndex).toBeLessThan(mainIndex);
  });
});
