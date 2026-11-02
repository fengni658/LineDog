import {
  HIT_BOX,
  PointerHitBoxController,
  createOnceErrorReporter,
  isPointInsideHitBox,
  resolveHitBox,
  type LogicalHitBox,
  type LogicalPoint,
} from "./pointer-hitbox";
import {
  FocusedInputGeometryAdapter,
} from "./input-avoidance";
import { NativeWindowMotionAdapter, createMotionSnapshot, type LogicalWorkArea } from "./native-motion";
import { NativePlatformAdapter } from "./native-platform";
import type { NativePlatformPort } from "./native-platform";
import { ParachuteViewportAdapter } from "./parachute-viewport";
import { applyParachuteVisual, createParachuteMarkup } from "./parachute-renderer";
import {
  resolveHomeMainVisibility,
  type HomeLifecycleEvent,
} from "./home-cycle";
import { HomeProximityController } from "./home-proximity";
import { PetBubbleController } from "./pet-bubble";
import { updatePetBubbleSurface } from "./pet-bubble-surface";
import { observePetInteractionLoss } from "./pet-interaction-lifecycle";
import { restoreDesktopLayout } from "./pet-controls";
import { loadDefaultRuntimeResources, type RuntimeFrame } from "./pet-manifest";
import { PetRuntime } from "./pet-runtime";
import { projectFrameHitBox } from "./pet-visual-geometry";
import { observeSpriteMotionPreference } from "./sprite-motion-preference";
import {
  CROSSFADE_ANIMATION_IDS,
  applySpriteHappyFeedback,
  applySpriteDraggingState,
  applySpriteFacing,
  applySpriteSleepingState,
  createBrowserImageLoader,
  createSpriteSurfaceMarkup,
  resolveSpriteFacing,
  SmoothSpriteFrameRenderer,
  type SpriteCrossfadePort,
} from "./sprite-renderer";
import {
  PointerGestureController,
} from "./pointer-gesture";
import { bindPetPointerEvents } from "./pet-pointer-events";
import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { installErrorDiagnostics, recordDiagnostic } from "./diagnostics";
installErrorDiagnostics();

const app = document.querySelector<HTMLElement>("#app");

if (!app) {
  throw new Error("LineDog could not find its application root.");
}

app.innerHTML = createParachuteMarkup() + createSpriteSurfaceMarkup();
const parachuteElement = app.querySelector<HTMLElement>(".pet-parachute")!;

const petStage = document.querySelector<HTMLElement>("#pet-stage");
const petSprite = document.querySelector<HTMLImageElement>("#pet-sprite");
const petSpriteUnder = document.querySelector<HTMLImageElement>(
  "#pet-sprite-under",
);
const petHitBox = document.querySelector<HTMLDivElement>("#pet-hitbox");
const petFeedback = document.querySelector<HTMLElement>("#pet-feedback");

if (!petStage || !petSprite || !petSpriteUnder || !petHitBox || !petFeedback) {
  throw new Error("LineDog could not initialize its Pointer HitBox surface.");
}

const surface = petStage;
const spriteElement = petSprite;
const spriteUnderElement = petSpriteUnder;
const hitBoxElement = petHitBox;
const stageElement = petStage;
const feedbackElement = petFeedback;
const originalErrorReporter = createOnceErrorReporter();
const reportError: typeof originalErrorReporter = (context, error) => {
  recordDiagnostic("native_error", { code: "unknown" });
  originalErrorReporter(context, error);
};
let diagnosticBehavior = "";
let diagnosticHome = "";
let activeHitBox: LogicalHitBox = { ...HIT_BOX };
let lastHitBoxFrame: RuntimeFrame | undefined;
let lastFrameHitBox: LogicalHitBox = { ...HIT_BOX };
let controller: PointerHitBoxController | undefined;
let runtime: PetRuntime | undefined;
let motionPort: NativeWindowMotionAdapter | undefined;
let nativePlatform: ParachuteViewportAdapter | undefined;
let focusedInputGeometry: FocusedInputGeometryAdapter | undefined;
let gesture: PointerGestureController | undefined;
let homeProximity: HomeProximityController | undefined;
let unlistenControls: UnlistenFn | undefined;
let controlsDisposed = false;
let lastMenuState = "";
let menuUpdates: Promise<void> = Promise.resolve();
let bubbleWorkArea: LogicalWorkArea | undefined;
let bubbleWindowPosition: LogicalPoint | undefined;
let bubbleCompact = false;
const bubbleElement = document.createElement("div");
bubbleElement.className = "pet-bubble";
bubbleElement.setAttribute("role", "status");
stageElement.append(bubbleElement);
const bubbles = new PetBubbleController(text => {
  bubbleElement.textContent = text;
  if (!text) bubbleCompact = false;
  updateBubbleLayout();
});

function updateBubbleLayout(): void {
  updatePetBubbleSurface(bubbleElement, {
    frame: lastHitBoxFrame, facing: stageElement.dataset.facing === "Left" ? "Left" : "Right",
    grabBounds: activeHitBox, windowPosition: bubbleWindowPosition,
    workArea: bubbleWorkArea, compact: bubbleCompact,
  });
}

function publishControls(): void {
  const state = runtime?.state;
  const snapshot = {
    ready: state?.readiness === "ready" && state.behavior !== "BOOTING",
    paused: !!state?.autonomyPaused,
    bubbles: bubbles.enabled,
    canRestore: !!runtime?.canRestorePosition,
    busy: state?.restoreStatus === "busy",
    failed: state?.restoreStatus === "failed",
  };
  const key = JSON.stringify(snapshot);
  if (key === lastMenuState || controlsDisposed) return;
  lastMenuState = key;
  menuUpdates = menuUpdates.then(async () => {
    if (!controlsDisposed) await invoke("pet_control_state", { state: snapshot });
  }).catch(() => {
    lastMenuState = "";
    recordDiagnostic("native_error", { code: "unknown" });
  });
}

async function handlePetControl(action: string): Promise<void> {
  bubbles.activity();
  if (!runtime || runtime.state.readiness !== "ready" || controlsDisposed) return;
  if (action === "pet-pause") {
    runtime.setAutonomyPaused(!runtime.state.autonomyPaused);
    bubbles.control(!!runtime.state.autonomyPaused);
  } else if (action === "pet-bubbles") {
    bubbles.setEnabled(!bubbles.enabled);
  } else if (action === "pet-restore" && nativePlatform) {
    const platform = nativePlatform;
    try { await platform.setExpanded(false); }
    catch (error) { reportError("Parachute viewport restore", error); return; }
    await runtime.restoreDefaultPosition(() => restoreDesktopLayout(platform, rect => homeProximity?.updateRect(rect)));
  }
  publishControls();
}

const smoothFrameRenderer = new SmoothSpriteFrameRenderer(globalThis);
const spriteCrossfadePort: SpriteCrossfadePort = {
  sprite: spriteElement,
  under: spriteUnderElement,
};
const spriteMotionPreference = observeSpriteMotionPreference(
  window.matchMedia("(prefers-reduced-motion: reduce)"),
  () => {
    if (lastHitBoxFrame) smoothFrameRenderer.render(spriteCrossfadePort, lastHitBoxFrame, false);
  },
);
const parachuteMotionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
const updateParachuteMotionPreference = () => runtime?.setReducedMotion(parachuteMotionMedia.matches);
parachuteMotionMedia.addEventListener("change", updateParachuteMotionPreference);

function pointerToLocalLogicalPoint(event: PointerEvent): LogicalPoint {
  const bounds = surface.getBoundingClientRect();

  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  };
}

function isCoreHit(point: LogicalPoint): boolean {
  return isPointInsideHitBox(point, activeHitBox);
}

function applyHitBoxToElement(hitBox: LogicalHitBox): void {
  activeHitBox = { ...hitBox };
  hitBoxElement.style.left = `${hitBox.x}px`;
  hitBoxElement.style.top = `${hitBox.y}px`;
  hitBoxElement.style.width = `${hitBox.width}px`;
  hitBoxElement.style.height = `${hitBox.height}px`;
}

applyHitBoxToElement(activeHitBox);

async function applyHomeLifecycle(event: HomeLifecycleEvent): Promise<void> {
  const platform = nativePlatform;
  if (!platform) {
    return;
  }

  try {
    const visibility = resolveHomeMainVisibility(event);
    await platform.setOverlayOpacity({
      windowLabel: "main",
      opacity: visibility.opacity,
    });
    await platform.setOverlayVisibility({
      windowLabel: "main",
      visible: visibility.visible,
    });
  } catch (error) {
    reportError(`Home lifecycle ${event.type}`, error);
  }
}

function initializePointerHitBox(): void {
  if (!("__TAURI_INTERNALS__" in window)) {
    return;
  }

  try {
    const platform = new ParachuteViewportAdapter(new NativePlatformAdapter(), {
      onInsetChange: inset => {
        document.documentElement.dataset.parachuteExpanded = String(inset > 0);
      },
      onDesktopSnapshot: snapshot => {
        bubbleWorkArea = { ...snapshot.workArea };
        bubbleWindowPosition = { ...snapshot.windowPosition };
        updateBubbleLayout();
        if (runtime?.state.restoreStatus === "busy") return;
        homeProximity?.updateDesktopSnapshot(snapshot);
        runtime?.handleDesktopSnapshot(createMotionSnapshot(snapshot));
      },
      reportError,
      onUnsafe: error => {
        applyParachuteVisual(parachuteElement, "NONE", 0);
        void controller?.forceSafeClickThrough();
        reportError("Parachute window geometry recovery", error);
      },
    });
    nativePlatform = platform;
    motionPort = new NativeWindowMotionAdapter(platform, { reportError });
    void initializeHomeProximity(platform);
    controller = new PointerHitBoxController(
      platform,
      {
        setPressed: (pressed) => {
          stageElement.dataset.pressed = String(pressed);
        },
      },
      {
        reportError,
        onPointerSample: (sample) => {
          runtime?.handlePointerSample(sample.relativeLogical);
          gesture?.handleGlobalPointerSample(sample);
          homeProximity?.handlePointerSample(sample.cursorScreenLogical, sample.scaleFactor);
        },
      },
    );
  } catch (error) {
    reportError("Pointer HitBox initialization", error);
  }
}

async function initializeHomeProximity(
  platform: NativePlatformPort,
): Promise<void> {
  try {
    const desktop = await platform.desktopSnapshot();
    homeProximity = new HomeProximityController({
      // 工作区无效时 rect 为 undefined，控制器退化为永远不透明（现状行为）。
      rect: undefined,
      applyOpacity: (opacity) =>
        platform.setOverlayOpacity({ windowLabel: "home", opacity }),
      reportError,
    });
    homeProximity.updateDesktopSnapshot(desktop);
  } catch (error) {
    reportError("Home proximity initialization", error);
  }
}

async function initializePetRuntime(): Promise<void> {
  try {
    unlistenControls = await listen<string>("pet-control", event => { void handlePetControl(event.payload); });
    const resources = await loadDefaultRuntimeResources((url) => fetch(url));
    runtime = new PetRuntime(resources, {
      motionPort,
      onMotionSnapshotAccepted: snapshot => motionPort?.acceptDesktopSnapshot(snapshot),
      setParachuteExpanded: expanded => nativePlatform?.setExpanded(expanded) ?? Promise.resolve(false),
      onInteractionAcknowledged: () => bubbles.acknowledgeClick(),
      onInteractionResponse: response => {
        bubbles.respond(response);
        bubbleCompact = response?.kind === "playful";
        updateBubbleLayout();
      },
      onDiagnostic: diagnostic => recordDiagnostic("behavior_wait", { ...diagnostic }),
      onHomeLifecycle: (event) => {
        recordDiagnostic("home_stage", { state: event.type });
        void applyHomeLifecycle(event);
      },
      onFrame: ({ frame, animationId, animationHitBox }) => {
        lastHitBoxFrame = frame;
        lastFrameHitBox = resolveHitBox(frame.hitBox, animationHitBox);
        const hitBox = projectFrameHitBox(frame, lastFrameHitBox,
          stageElement.dataset.facing === "Left" ? "Left" : "Right");
        controller?.setHitBox(hitBox);
        applyHitBoxToElement(hitBox);
        updateBubbleLayout();
        smoothFrameRenderer.render(
          spriteCrossfadePort,
          frame,
          CROSSFADE_ANIMATION_IDS.has(animationId) && spriteMotionPreference.allowsCrossfade(),
        );
      },
      onStateChange: (state) => {
        applyParachuteVisual(parachuteElement, state.parachutePhase, state.parachuteProgress);
        const moving = ["DRAG", "FALL", "LAND", "GO_HOME", "LEAVE_HOME"].includes(state.behavior) || state.restoreStatus === "busy";
        bubbles.update(!!runtime?.canShowIdleBubble, moving);
        updateBubbleLayout();
        publishControls();
        const homePhase = state.homeCyclePhase ?? "NONE";
        if (diagnosticHome !== homePhase) {
          diagnosticHome = homePhase;
          recordDiagnostic("home_stage", { state: homePhase });
        }
        if (diagnosticBehavior !== state.behavior) {
          diagnosticBehavior = state.behavior;
          recordDiagnostic("pet_state", { state: state.behavior });
        }
        applySpriteFacing(
          stageElement,
          resolveSpriteFacing(
            state.behavior,
            state.facing,
            state.visualTransition,
            state.turnFrameMirrored,
            state.activeAnimationId,
          ),
        );
        applySpriteHappyFeedback(stageElement, feedbackElement, state.behavior);
        if (lastHitBoxFrame) {
          const hitBox = projectFrameHitBox(lastHitBoxFrame, lastFrameHitBox,
            stageElement.dataset.facing === "Left" ? "Left" : "Right");
          controller?.setHitBox(hitBox);
          applyHitBoxToElement(hitBox);
          updateBubbleLayout();
        }
        applySpriteDraggingState(stageElement, state.isDragging);
        applySpriteSleepingState(
          stageElement,
          state.behavior,
          state.activeAnimationId,
        );
      },
      onInputAvoidanceWarning: ({ code }) => {
        console.warn(`[LineDog Input Avoidance] ${code}`);
      },
    });
    updateParachuteMotionPreference();
    await runtime.initialize(createBrowserImageLoader());
    const platform = nativePlatform;
    if (controller && motionPort && platform) {
      gesture = new PointerGestureController(runtime, controller, motionPort);
      focusedInputGeometry = new FocusedInputGeometryAdapter({
        readDesktopSnapshot: () => platform.desktopSnapshot(),
        readFocusedInputSnapshot: (request) =>
          platform.focusedInputSnapshot(request),
        onFact: (fact) => runtime?.handleInputAvoidanceFact(fact),
        onDiagnostic: diagnostic => recordDiagnostic("input_status", { ...diagnostic }),
      });
      focusedInputGeometry.start();
    }
    stageElement.dataset.runtimeState = "ready";
    controller?.startPolling();
  } catch (error) {
    stageElement.dataset.runtimeState = "failed";
    void controller?.forceSafeClickThrough();
    reportError("Sprite runtime initialization", error);
  }
}

const pointerEvents = bindPetPointerEvents(hitBoxElement, {
  gesture: () => gesture,
  isCoreHit: event => isCoreHit(pointerToLocalLogicalPoint(event)),
  activity: () => bubbles.activity(),
  onError: error => reportError("pointer gesture", error),
});

function cancelActivePointerGesture(): void { pointerEvents.cancel(); }

hitBoxElement.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  bubbles.activity();
  void invoke("chat_context_menu").catch(() => recordDiagnostic("native_error", { code: "unknown" }));
});

const stopInteractionLossObserver = observePetInteractionLoss(window, document, () => document.visibilityState, () => {
  runtime?.cancelPendingClickResponses();
  cancelActivePointerGesture();
  bubbles.respond(null);
  void controller?.forceSafeClickThrough();
});

window.addEventListener("pagehide", () => {
  stopInteractionLossObserver();
  pointerEvents.dispose();
  controlsDisposed = true;
  unlistenControls?.();
  bubbles.dispose();
  cancelActivePointerGesture();
  void controller?.forceSafeClickThrough();
  controller?.dispose();
  focusedInputGeometry?.dispose();
  homeProximity?.dispose();
  smoothFrameRenderer.dispose();
  spriteMotionPreference.dispose();
  parachuteMotionMedia.removeEventListener("change", updateParachuteMotionPreference);
  runtime?.dispose();
  motionPort?.dispose();
  void nativePlatform?.dispose().catch(error => reportError("Parachute viewport disposal", error));
});

window.addEventListener("beforeunload", () => {
  void controller?.forceSafeClickThrough();
});

initializePointerHitBox();
void initializePetRuntime();
