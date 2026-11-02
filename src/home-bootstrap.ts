import { NativePlatformAdapter } from "./native-platform";
import { computeHomeSurfaceRect } from "./home-cycle";
import {
  assertHomeDomRenderReady,
  waitForHomeRenderPaint,
} from "./home-render-readiness";
import "./home-surface.css";

const HOME_IMAGE_URL = "/character/home/home.png";
const HOME_IMAGE_WAIT_TIMEOUT_MS = 500;

const appRoot = document.querySelector<HTMLElement>("#app");

if (!appRoot) {
  throw new Error("LineDog home could not find its application root.");
}

const app: HTMLElement = appRoot;

function prepareHomeSurfaceForPaint(
  surface: HTMLElement,
  image: HTMLImageElement,
): void {
  if (
    !surface.isConnected ||
    !app.contains(surface) ||
    !image.isConnected ||
    !surface.contains(image)
  ) {
    throw new Error("LineDog Home key visual DOM is not mounted.");
  }

  // Native has already shown the HWND without activation at alpha=0. This
  // staging flag is local DOM state; it does not receive Pet state updates and
  // does not claim pixel readback or user-visible acceptance.
  surface.dataset.homeRenderReady = "true";
}

async function waitForHomeImage(image: HTMLImageElement): Promise<void> {
  const assertDecoded = (): void => {
    if (!image.complete || image.naturalWidth <= 0) {
      throw new Error("Home image did not become available after decoding.");
    }
  };

  // Fast-path an already complete image with a positive naturalWidth. Otherwise
  // use the load/error event contract (mirroring createBrowserImageLoader for
  // the Main window) with a bounded timeout so the later synchronous DOM
  // dimension proof can still run.
  if (image.complete && image.naturalWidth > 0) {
    assertDecoded();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      // Bounded wait: if the image still is not decoded, defer to the
      // synchronous proof (which re-checks dimensions) instead of failing
      // closed and leaving the Home surface unready for the opacity raise.
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }, HOME_IMAGE_WAIT_TIMEOUT_MS);

    const onLoad = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error("Home image failed to load."));
    };
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
    };

    image.addEventListener("load", onLoad);
    image.addEventListener("error", onError);
  });
}

async function renderAcceptedHome(): Promise<void> {
  const platform = new NativePlatformAdapter();
  const desktop = await platform.desktopSnapshot();
  const surfaceRect = computeHomeSurfaceRect(desktop.workArea);
  if (!surfaceRect) {
    throw new Error("LineDog Home WorkArea is invalid.");
  }

  await platform.setOverlayFrame({
    windowLabel: "home",
    x: surfaceRect.x,
    y: surfaceRect.y,
    width: surfaceRect.width,
    height: surfaceRect.height,
  });

  const surface = document.createElement("section");
  surface.className = "home-surface";
  surface.dataset.homeVisibility = "hidden";
  surface.setAttribute("aria-label", "LineDog 小屋");
  surface.setAttribute("role", "img");

  const image = document.createElement("img");
  image.className = "home-surface__image";
  image.alt = "";
  image.decoding = "async";
  image.src = HOME_IMAGE_URL;
  surface.append(image);
  app.replaceChildren(surface);

  prepareHomeSurfaceForPaint(surface, image);
  await waitForHomeImage(image);
  surface.getBoundingClientRect();
  await waitForHomeRenderPaint();
  assertHomeDomRenderReady(app, surface, [image], image);

  // This is the only Home-to-Native signal in B6. Home never receives Pet
  // state, route phases, or placement/state increment events.
  await platform.surfaceReady("home");
  surface.dataset.homeVisibility = "shown";
}

if ("__TAURI_INTERNALS__" in window) {
  void renderAcceptedHome().catch((error: unknown) => {
    console.error("LineDog Home bootstrap failed closed.", error);
  });
}
