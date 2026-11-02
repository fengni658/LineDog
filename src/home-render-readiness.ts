export const HOME_RENDER_PAINT_TIMEOUT_MS = 250;

type HomeRenderTimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface HomeRenderPaintScheduler {
  requestAnimationFrame(callback: () => void): unknown;
  setTimeout(callback: () => void, delayMs: number): HomeRenderTimerHandle;
  clearTimeout(handle: HomeRenderTimerHandle): void;
}

export interface HomeRenderRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface HomeRenderComputedStyle {
  readonly opacity: string;
  readonly display: string;
  readonly visibility: string;
}

export interface HomeDomRenderEnvironment {
  getComputedStyle(element: Element): HomeRenderComputedStyle;
  getCssViewportRect(): HomeRenderRect;
}

export interface HomeDomRenderProof {
  readonly viewportRect: HomeRenderRect;
  readonly surfaceRect: HomeRenderRect;
  readonly imageRect?: HomeRenderRect;
}

function failDomRenderProof(reason: string): never {
  throw new Error(`LineDog Home DOM render proof failed: ${reason}.`);
}

function createBrowserDomRenderEnvironment(): HomeDomRenderEnvironment | undefined {
  if (
    typeof document === "undefined" ||
    !document.documentElement ||
    typeof globalThis.getComputedStyle !== "function"
  ) {
    return undefined;
  }

  return {
    getComputedStyle: (element) => globalThis.getComputedStyle(element),
    getCssViewportRect: () => {
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      return {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
      };
    },
  };
}

function readHomeRenderRect(element: Element): HomeRenderRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function assertFiniteNonZeroRect(
  rect: HomeRenderRect,
  reason: string,
): void {
  if (
    ![
      rect.left,
      rect.top,
      rect.right,
      rect.bottom,
      rect.width,
      rect.height,
    ].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.right <= rect.left ||
    rect.bottom <= rect.top
  ) {
    failDomRenderProof(reason);
  }
}

function intersectsCssViewport(
  rect: HomeRenderRect,
  viewport: HomeRenderRect,
): boolean {
  return (
    rect.left < viewport.right &&
    rect.right > viewport.left &&
    rect.top < viewport.bottom &&
    rect.bottom > viewport.top
  );
}

function assertComputedVisible(
  element: Element,
  environment: HomeDomRenderEnvironment,
  reason: string,
): void {
  const style = environment.getComputedStyle(element);
  const opacity = Number.parseFloat(style.opacity);
  if (
    !Number.isFinite(opacity) ||
    opacity <= 0 ||
    style.display === "none" ||
    style.visibility !== "visible"
  ) {
    failDomRenderProof(reason);
  }
}

/**
 * Verifies the DOM state before `surface_ready` raises Home opacity, without
 * crossing the Home/Native boundary.
 * The returned proof contains only bounded geometry and style facts; it never
 * includes text, URLs, image bytes, or user content.
 */
export function assertHomeDomRenderReady(
  root: HTMLElement,
  surface: HTMLElement,
  keyVisuals: readonly Element[],
  image?: HTMLImageElement,
  environment: HomeDomRenderEnvironment | undefined =
    createBrowserDomRenderEnvironment(),
): HomeDomRenderProof {
  if (!environment) {
    failDomRenderProof("DOM_ENVIRONMENT_UNAVAILABLE");
  }

  if (
    !root.isConnected ||
    !surface.isConnected ||
    !root.contains(surface)
  ) {
    failDomRenderProof("SURFACE_NOT_CONNECTED_OR_CONTAINED");
  }

  if (
    surface.dataset.homeVisibility !== "hidden" ||
    surface.dataset.homeRenderReady !== "true"
  ) {
    failDomRenderProof("PRE_SHOW_SURFACE_STATE_INVALID");
  }

  if (
    keyVisuals.length === 0 ||
    keyVisuals.some(
      (keyVisual) =>
        !keyVisual.isConnected || !surface.contains(keyVisual),
    )
  ) {
    failDomRenderProof("KEY_VISUAL_NOT_CONNECTED_OR_CONTAINED");
  }

  const viewportRect = environment.getCssViewportRect();
  assertFiniteNonZeroRect(viewportRect, "CSS_VIEWPORT_RECT_INVALID");

  const surfaceRect = readHomeRenderRect(surface);
  assertFiniteNonZeroRect(surfaceRect, "SURFACE_RECT_INVALID");
  if (!intersectsCssViewport(surfaceRect, viewportRect)) {
    failDomRenderProof("SURFACE_OUTSIDE_CSS_VIEWPORT");
  }
  assertComputedVisible(surface, environment, "SURFACE_COMPUTED_HIDDEN");

  if (!image) {
    return { viewportRect, surfaceRect };
  }

  if (!image.isConnected || !surface.contains(image)) {
    failDomRenderProof("IMAGE_NOT_CONNECTED_OR_CONTAINED");
  }
  if (
    !image.complete ||
    image.naturalWidth <= 0 ||
    image.naturalHeight <= 0
  ) {
    failDomRenderProof("IMAGE_DIMENSIONS_INVALID");
  }
  assertComputedVisible(image, environment, "IMAGE_COMPUTED_HIDDEN");

  const imageRect = readHomeRenderRect(image);
  assertFiniteNonZeroRect(imageRect, "IMAGE_RECT_INVALID");
  if (!intersectsCssViewport(imageRect, viewportRect)) {
    failDomRenderProof("IMAGE_OUTSIDE_CSS_VIEWPORT");
  }

  return { viewportRect, surfaceRect, imageRect };
}

function createBrowserPaintScheduler(): HomeRenderPaintScheduler | undefined {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    return undefined;
  }

  return {
    requestAnimationFrame: (callback) =>
      globalThis.requestAnimationFrame(() => callback()),
    setTimeout: (callback, delayMs) =>
      globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
  };
}

/**
 * Resolves after two consecutive animation-frame callbacks when the scheduler
 * can provide them. This is a bounded frame boundary for the committed DOM
 * and decoded assets, not a pixel readback or a user-visibility assertion.
 *
 * Native starts the Home HWND shown without activation at alpha=0. A hidden
 * document context can still pause requestAnimationFrame, so a rAF timeout is
 * an expected bounded fallback, not by itself a render failure. In that case
 * we resolve; the caller still performs a synchronous DOM geometry, style and
 * image-dimension proof via `assertHomeDomRenderReady` before allowing Native
 * to raise opacity.
 */
export function waitForHomeRenderPaint(
  scheduler?: HomeRenderPaintScheduler,
  timeoutMs = HOME_RENDER_PAINT_TIMEOUT_MS,
): Promise<void> {
  const activeScheduler = scheduler ?? createBrowserPaintScheduler();
  if (
    !activeScheduler ||
    typeof activeScheduler.requestAnimationFrame !== "function"
  ) {
    // No rAF scheduler is available (headless or hidden document): there is
    // no frame boundary to observe. Defer to the caller's synchronous DOM
    // proof rather than claiming a paint or failing closed.
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: HomeRenderTimerHandle | undefined;

    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout !== undefined) {
        activeScheduler.clearTimeout(timeout);
      }
      resolve();
    };

    const fail = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout !== undefined) {
        activeScheduler.clearTimeout(timeout);
      }
      reject(
        error instanceof Error
          ? error
          : new Error("LineDog Home render paint verification failed."),
      );
    };

    timeout = activeScheduler.setTimeout(() => {
      // rAF did not fire within the bound. For the alpha=0 Home HWND this is
      // the bounded pre-show fallback; resolve so the synchronous DOM proof
      // can run. Only a genuinely broken scheduler (rAF throwing) fails
      // closed.
      finish();
    }, timeoutMs);

    try {
      activeScheduler.requestAnimationFrame(() => {
        if (settled) {
          return;
        }

        try {
          activeScheduler.requestAnimationFrame(finish);
        } catch (error) {
          fail(error);
        }
      });
    } catch (error) {
      fail(error);
    }
  });
}
