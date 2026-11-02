type EventSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Covers visible-window blur as well as a hidden document; no focus requests. */
export function observePetInteractionLoss(
  windowEvents: EventSource,
  documentEvents: EventSource,
  visibility: () => string,
  interrupt: () => void,
): () => void {
  const blur = () => interrupt();
  const hidden = () => { if (visibility() !== "visible") interrupt(); };
  windowEvents.addEventListener("blur", blur);
  documentEvents.addEventListener("visibilitychange", hidden);
  return () => {
    windowEvents.removeEventListener("blur", blur);
    documentEvents.removeEventListener("visibilitychange", hidden);
  };
}
