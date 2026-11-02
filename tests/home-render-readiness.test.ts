import { describe, expect, it } from "vitest";
import type {
  HomeDomRenderEnvironment,
  HomeRenderComputedStyle,
  HomeRenderPaintScheduler,
  HomeRenderRect,
} from "../src/home-render-readiness";
import {
  HOME_RENDER_PAINT_TIMEOUT_MS,
  assertHomeDomRenderReady,
  waitForHomeRenderPaint,
} from "../src/home-render-readiness";

const VIEWPORT_RECT: HomeRenderRect = {
  left: 0,
  top: 0,
  right: 800,
  bottom: 600,
  width: 800,
  height: 600,
};

type FakeElement = {
  isConnected: boolean;
  dataset: Record<string, string | undefined>;
  rect: HomeRenderRect;
  children: Set<FakeElement>;
  contains: (child: unknown) => boolean;
  getBoundingClientRect: () => HomeRenderRect;
};

type FakeImage = FakeElement & {
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
};

type DomFixture = {
  root: HTMLElement;
  surface: HTMLElement;
  image: HTMLImageElement;
  fakeRoot: FakeElement;
  fakeSurface: FakeElement;
  fakeImage: FakeImage;
  styles: Map<FakeElement, HomeRenderComputedStyle>;
  environment: HomeDomRenderEnvironment;
};

function makeElement(rect: HomeRenderRect): FakeElement {
  const element: FakeElement = {
    isConnected: true,
    dataset: {},
    rect,
    children: new Set<FakeElement>(),
    contains: (child) => element.children.has(child as FakeElement),
    getBoundingClientRect: () => element.rect,
  };
  return element;
}

function makeImage(rect: HomeRenderRect): FakeImage {
  return {
    ...makeElement(rect),
    complete: true,
    naturalWidth: 256,
    naturalHeight: 256,
  };
}

function makeDomFixture(): DomFixture {
  const fakeRoot = makeElement(VIEWPORT_RECT);
  const fakeSurface = makeElement({
    left: 100,
    top: 100,
    right: 356,
    bottom: 356,
    width: 256,
    height: 256,
  });
  const fakeImage = makeImage({
    left: 120,
    top: 120,
    right: 336,
    bottom: 336,
    width: 216,
    height: 216,
  });
  fakeRoot.children.add(fakeSurface);
  fakeSurface.children.add(fakeImage);
  fakeSurface.dataset.homeVisibility = "hidden";
  fakeSurface.dataset.homeRenderReady = "true";

  const visibleStyle: HomeRenderComputedStyle = {
    opacity: "1",
    display: "block",
    visibility: "visible",
  };
  const styles = new Map<FakeElement, HomeRenderComputedStyle>([
    [fakeRoot, visibleStyle],
    [fakeSurface, visibleStyle],
    [fakeImage, visibleStyle],
  ]);
  const environment: HomeDomRenderEnvironment = {
    getComputedStyle: (element) =>
      styles.get(element as FakeElement) ?? visibleStyle,
    getCssViewportRect: () => VIEWPORT_RECT,
  };

  return {
    root: fakeRoot as unknown as HTMLElement,
    surface: fakeSurface as unknown as HTMLElement,
    image: fakeImage as unknown as HTMLImageElement,
    fakeRoot,
    fakeSurface,
    fakeImage,
    styles,
    environment,
  };
}

function assertFixture(fixture: DomFixture): void {
  assertHomeDomRenderReady(
    fixture.root,
    fixture.surface,
    [fixture.image],
    fixture.image,
    fixture.environment,
  );
}

describe("Home render paint readiness", () => {
  it("waits for two consecutive frames and clears the timeout", async () => {
    const frameCallbacks: Array<() => void> = [];
    let timeoutCallback: (() => void) | undefined;
    let clearCount = 0;
    const timerHandle = 1 as ReturnType<typeof globalThis.setTimeout>;
    const scheduler: HomeRenderPaintScheduler = {
      requestAnimationFrame: (callback) => {
        frameCallbacks.push(callback);
      },
      setTimeout: (callback, delayMs) => {
        expect(delayMs).toBe(HOME_RENDER_PAINT_TIMEOUT_MS);
        timeoutCallback = callback;
        return timerHandle;
      },
      clearTimeout: (handle) => {
        expect(handle).toBe(timerHandle);
        clearCount += 1;
      },
    };

    const paintPromise = waitForHomeRenderPaint(scheduler);
    expect(frameCallbacks).toHaveLength(1);
    expect(timeoutCallback).toBeDefined();

    frameCallbacks.shift()?.();
    expect(frameCallbacks).toHaveLength(1);
    let settled = false;
    void paintPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    frameCallbacks.shift()?.();
    await expect(paintPromise).resolves.toBeUndefined();
    expect(clearCount).toBe(1);
  });

  it("resolves on the bounded timeout and ignores a late first frame", async () => {
    let firstFrame: (() => void) | undefined;
    let timeoutCallback: (() => void) | undefined;
    let frameRequestCount = 0;
    let clearCount = 0;
    const timerHandle = 2 as ReturnType<typeof globalThis.setTimeout>;
    const scheduler: HomeRenderPaintScheduler = {
      requestAnimationFrame: (callback) => {
        frameRequestCount += 1;
        firstFrame = callback;
      },
      setTimeout: (callback) => {
        timeoutCallback = callback;
        return timerHandle;
      },
      clearTimeout: () => {
        clearCount += 1;
      },
    };

    const paintPromise = waitForHomeRenderPaint(scheduler);
    expect(frameRequestCount).toBe(1);
    timeoutCallback?.();
    await expect(paintPromise).resolves.toBeUndefined();
    expect(clearCount).toBe(1);

    firstFrame?.();
    await Promise.resolve();
    expect(frameRequestCount).toBe(1);
  });

  it("resolves immediately without a paint scheduler", async () => {
    const noScheduler = {
      requestAnimationFrame: undefined,
    } as unknown as HomeRenderPaintScheduler;

    await expect(waitForHomeRenderPaint(noScheduler)).resolves.toBeUndefined();
  });

  it("rejects a scheduler exception and clears its timeout", async () => {
    const schedulerError = new Error("requestAnimationFrame failed");
    let clearCount = 0;
    const timerHandle = 3 as ReturnType<typeof globalThis.setTimeout>;
    const scheduler: HomeRenderPaintScheduler = {
      requestAnimationFrame: () => {
        throw schedulerError;
      },
      setTimeout: () => timerHandle,
      clearTimeout: () => {
        clearCount += 1;
      },
    };

    await expect(waitForHomeRenderPaint(scheduler)).rejects.toBe(schedulerError);
    expect(clearCount).toBe(1);
  });
});

describe("Home DOM render proof", () => {
  it("accepts the mounted, hidden-before-show DOM with valid visible geometry", () => {
    const fixture = makeDomFixture();

    expect(() => assertFixture(fixture)).not.toThrow();
    expect(
      assertHomeDomRenderReady(
        fixture.root,
        fixture.surface,
        [fixture.image],
        fixture.image,
        fixture.environment,
      ),
    ).toMatchObject({
      viewportRect: VIEWPORT_RECT,
      surfaceRect: fixture.fakeSurface.rect,
      imageRect: fixture.fakeImage.rect,
    });
  });

  it("fails closed when the DOM is disconnected", () => {
    const fixture = makeDomFixture();
    fixture.fakeRoot.isConnected = false;

    expect(() => assertFixture(fixture)).toThrow(
      "SURFACE_NOT_CONNECTED_OR_CONTAINED",
    );
  });

  it("fails closed for an invalid surface size", () => {
    const fixture = makeDomFixture();
    fixture.fakeSurface.rect = {
      ...fixture.fakeSurface.rect,
      right: fixture.fakeSurface.rect.left,
      width: 0,
    };

    expect(() => assertFixture(fixture)).toThrow("SURFACE_RECT_INVALID");
  });

  it("fails closed when computed Home content is hidden", () => {
    const fixture = makeDomFixture();
    fixture.styles.set(fixture.fakeSurface, {
      opacity: "1",
      display: "none",
      visibility: "visible",
    });

    expect(() => assertFixture(fixture)).toThrow("SURFACE_COMPUTED_HIDDEN");
  });

  it("fails closed when the image is not complete or has no dimensions", () => {
    const fixture = makeDomFixture();
    fixture.fakeImage.complete = false;
    fixture.fakeImage.naturalWidth = 0;
    fixture.fakeImage.naturalHeight = 0;

    expect(() => assertFixture(fixture)).toThrow("IMAGE_DIMENSIONS_INVALID");
  });
});
