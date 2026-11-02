import { expect, it } from "vitest";
import { observePetInteractionLoss } from "../src/pet-interaction-lifecycle";

it("wires visible-window blur and hidden-document cancellation, then removes both handlers", () => {
  const windowEvents = new EventTarget(), documentEvents = new EventTarget();
  let visibility = "visible", interrupted = 0;
  const dispose = observePetInteractionLoss(windowEvents, documentEvents, () => visibility, () => interrupted++);
  windowEvents.dispatchEvent(new Event("blur"));
  expect(interrupted).toBe(1);
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  expect(interrupted).toBe(1);
  visibility = "hidden";
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  expect(interrupted).toBe(2);
  dispose();
  windowEvents.dispatchEvent(new Event("blur"));
  documentEvents.dispatchEvent(new Event("visibilitychange"));
  expect(interrupted).toBe(2);
});
