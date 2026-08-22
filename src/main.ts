import { LogicalPosition } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import {
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
} from "@tauri-apps/api/window";

import {
  HIT_BOX,
  NativeSpikeController,
  createOnceErrorReporter,
  invokeWindowClickThrough,
  type LogicalPoint,
} from "./native-spike";
import { NativeWindowMotionAdapter } from "./native-motion";
import { loadDefaultRuntimeResources } from "./pet-manifest";
import { PetRuntime } from "./pet-runtime";
import {
  applySpriteFacing,
  createBrowserImageLoader,
  createSpriteSurfaceMarkup,
  renderSpriteFrame,
  resolveSpriteFacing,
} from "./sprite-renderer";
import {
  PointerGestureController,
  type PointerGestureEnd,
} from "./pointer-gesture";
import "./styles.css";

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("LineDog could not find its application root.");
}

app.innerHTML = createSpriteSurfaceMarkup();

const petStage = document.querySelector<HTMLElement>("#pet-stage");
const petSprite = document.querySelector<HTMLImageElement>("#pet-sprite");
const petHitBox = document.querySelector<HTMLDivElement>("#pet-hitbox");
const petFeedback = document.querySelector<HTMLElement>("#pet-feedback");

if (!petStage || !petSprite || !petHitBox || !petFeedback) {
  throw new Error("LineDog could not initialize its Native Spike surface.");
}

const surface = petStage;
const spriteElement = petSprite;
const hitBoxElement = petHitBox;
const stageElement = petStage;
const feedbackElement = petFeedback;
const reportError = createOnceErrorReporter();
let controller: NativeSpikeController | undefined;
let runtime: PetRuntime | undefined;
let motionPort: NativeWindowMotionAdapter | undefined;
let gesture: PointerGestureController | undefined;
let capturedPointerId: number | undefined;

function pointerToLocalLogicalPoint(event: PointerEvent): LogicalPoint {
  const bounds = surface.getBoundingClientRect();

  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  };
}

function isCoreHit(point: LogicalPoint): boolean {
  return (
    point.x >= HIT_BOX.x &&
    point.x <= HIT_BOX.x + HIT_BOX.width &&
    point.y >= HIT_BOX.y &&
    point.y <= HIT_BOX.y + HIT_BOX.height
  );
}

function initializeNativeSpike(): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    return;
  }

  try {
    const appWindow = getCurrentWindow();
    motionPort = new NativeWindowMotionAdapter(
      {
        currentMonitor,
        outerPosition: () => appWindow.outerPosition(),
        scaleFactor: () => appWindow.scaleFactor(),
        setPosition: (position) =>
          appWindow.setPosition(new LogicalPosition(position.x, position.y)),
      },
      { reportError },
    );
    controller = new NativeSpikeController(
      {
        cursorPosition,
        outerPosition: () => appWindow.outerPosition(),
        scaleFactor: () => appWindow.scaleFactor(),
        setIgnoreCursorEvents: (ignore) => invokeWindowClickThrough(invoke, ignore),
      },
      {
        setPressed: (pressed) => {
          stageElement.dataset.pressed = String(pressed);
        },
        setHappy: (happy) => {
          stageElement.dataset.happy = String(happy);
          feedbackElement.textContent = happy ? "小狗开心地回应了。" : "";
        },
      },
      {
        reportError,
        onPointerSample: (sample) => {
          runtime?.handlePointerSample(sample.relativeLogical);
          gesture?.handleGlobalPointerSample(sample);
        },
      },
    );
  } catch (error) {
    reportError("Native Spike initialization", error);
  }
}

async function initializePetRuntime(): Promise<void> {
  try {
    const resources = await loadDefaultRuntimeResources((url) => fetch(url));
    runtime = new PetRuntime(resources, {
      motionPort,
      onFrame: ({ frame }) => renderSpriteFrame(spriteElement, frame),
      onStateChange: (state) =>
        applySpriteFacing(
          stageElement,
          resolveSpriteFacing(
            state.behavior,
            state.facing,
            state.visualTransition,
            state.turnFrameMirrored,
          ),
        ),
    });
    await runtime.initialize(createBrowserImageLoader());
    if (controller && motionPort) {
      gesture = new PointerGestureController(runtime, controller, motionPort);
    }
    stageElement.dataset.runtimeState = "ready";
    controller?.startPolling();
  } catch (error) {
    stageElement.dataset.runtimeState = "failed";
    void controller?.forceSafeClickThrough();
    reportError("Sprite runtime initialization", error);
  }
}

function releasePointerCapture(pointerId: number): void {
  if (
    typeof hitBoxElement.hasPointerCapture === "function" &&
    typeof hitBoxElement.releasePointerCapture === "function" &&
    hitBoxElement.hasPointerCapture(pointerId)
  ) {
    hitBoxElement.releasePointerCapture(pointerId);
  }
}

async function finishPointerGesture(
  pointerId: number,
  outcome: PointerGestureEnd,
): Promise<void> {
  if (capturedPointerId !== pointerId) {
    return;
  }

  capturedPointerId = undefined;
  if (outcome !== "lostpointercapture") {
    releasePointerCapture(pointerId);
  }

  const shouldShowHappyFeedback = await gesture?.finish(pointerId, outcome);
  if (shouldShowHappyFeedback) {
    controller?.triggerHappyFeedback();
  }
}

function cancelActivePointerGesture(): void {
  const pointerId = capturedPointerId;
  capturedPointerId = undefined;

  if (pointerId !== undefined) {
    releasePointerCapture(pointerId);
  }

  void gesture?.cancel();
}

hitBoxElement.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) {
    return;
  }

  const point = pointerToLocalLogicalPoint(event);
  if (!isCoreHit(point)) {
    return;
  }

  if (
    !gesture ||
    typeof hitBoxElement.setPointerCapture !== "function" ||
    capturedPointerId !== undefined
  ) {
    if (typeof hitBoxElement.setPointerCapture !== "function") {
      reportError(
        "pointer capture",
        new Error("LineDog requires DOM Pointer Capture for gesture release."),
      );
    }
    return;
  }

  event.preventDefault();

  try {
    hitBoxElement.setPointerCapture(event.pointerId);
  } catch (error) {
    reportError("pointer capture", error);
    return;
  }

  capturedPointerId = event.pointerId;
  void gesture.begin(event.pointerId).then((started) => {
    if (!started && capturedPointerId === event.pointerId) {
      capturedPointerId = undefined;
      releasePointerCapture(event.pointerId);
    }
  });
});

hitBoxElement.addEventListener("pointerup", (event) => {
  void finishPointerGesture(event.pointerId, "pointerup");
});

hitBoxElement.addEventListener("pointercancel", (event) => {
  void finishPointerGesture(event.pointerId, "pointercancel");
});

hitBoxElement.addEventListener("lostpointercapture", (event) => {
  void finishPointerGesture(event.pointerId, "lostpointercapture");
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    cancelActivePointerGesture();
    void controller?.forceSafeClickThrough();
  }
});

window.addEventListener("pagehide", () => {
  cancelActivePointerGesture();
  void controller?.forceSafeClickThrough();
  controller?.dispose();
  runtime?.dispose();
  motionPort?.dispose();
});

window.addEventListener("beforeunload", () => {
  void controller?.forceSafeClickThrough();
});

initializeNativeSpike();
void initializePetRuntime();
