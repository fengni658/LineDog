import type { PointerGestureController, PointerGestureEnd } from "./pointer-gesture";

/** The production DOM boundary. Native preparation is asynchronous, DOM release is not. */
export function bindPetPointerEvents(
  element: HTMLElement,
  options: {
    gesture: () => PointerGestureController | undefined;
    isCoreHit: (event: PointerEvent) => boolean;
    activity: () => void;
    onError: (error: unknown) => void;
  },
): { cancel: () => void; dispose: () => void } {
  let capture: { pointerId: number } | undefined;
  const release = (pointerId: number) => {
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
  };
  const finish = (event: PointerEvent, outcome: PointerGestureEnd) => {
    if (capture?.pointerId !== event.pointerId) return;
    capture = undefined;
    // Clear ownership first: releasePointerCapture can dispatch a lost event.
    if (outcome !== "lostpointercapture") release(event.pointerId);
    void options.gesture()?.finish(event.pointerId, outcome).catch(options.onError);
  };
  const down = (event: PointerEvent) => {
    const gesture = options.gesture();
    if (event.button !== 0 || !options.isCoreHit(event) || !gesture || capture) return;
    if (typeof element.setPointerCapture !== "function") {
      options.onError(new Error("LineDog requires DOM Pointer Capture for gesture release."));
      return;
    }
    event.preventDefault();
    options.activity();
    try { element.setPointerCapture(event.pointerId); }
    catch (error) { options.onError(error); return; }
    const owned = { pointerId: event.pointerId };
    capture = owned;
    void gesture.begin(event.pointerId).then(started => {
      // A mouse reuses pointerId. A late result must not release its next click.
      if (!started && capture === owned) {
        capture = undefined;
        release(owned.pointerId);
      }
    }).catch(options.onError);
  };
  const up = (event: PointerEvent) => finish(event, "pointerup");
  const cancelEvent = (event: PointerEvent) => finish(event, "pointercancel");
  const lost = (event: PointerEvent) => finish(event, "lostpointercapture");
  const cancel = () => {
    const owned = capture;
    capture = undefined;
    if (owned) release(owned.pointerId);
    void options.gesture()?.cancel().catch(options.onError);
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancelEvent);
  element.addEventListener("lostpointercapture", lost);
  return { cancel, dispose: () => {
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("pointerup", up);
    element.removeEventListener("pointercancel", cancelEvent);
    element.removeEventListener("lostpointercapture", lost);
    cancel();
  } };
}
