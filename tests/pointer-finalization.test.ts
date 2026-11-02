import { describe, expect, it, vi } from "vitest";
import type { MotionSnapshot } from "../src/native-motion";
import type { NativePointerSnapshotV1 } from "../src/native-platform";
import { PointerGestureController, type GestureRuntimePort } from "../src/pointer-gesture";
import { PointerHitBoxController } from "../src/pointer-hitbox";
import { bindPetPointerEvents } from "../src/pet-pointer-events";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const desktop: MotionSnapshot = {
  currentMonitorId: "monitor-1", windowScaleFactor: 1,
  workArea: { x: 0, y: 0, width: 1000, height: 600 },
  windowPosition: { space: "WINDOW_TOP_LEFT_LOGICAL", x: 100, y: 460 },
};
const sample = (inside = true): NativePointerSnapshotV1 => ({
  protocolVersion: 1, snapshotRevision: 1, capturedAtMonotonicMs: 0, scaleFactor: 1,
  cursorScreenLogical: { x: inside ? 180 : 900, y: 540 },
  windowOuterTopLeftLogical: { x: 100, y: 460 },
  relativeLogical: { x: inside ? 80 : 800, y: 80 },
});

function harness(options: { waitForRuntime?: Promise<void>; waitForUnlock?: Promise<void> } = {}) {
  let busy = false;
  const feedback = vi.fn();
  const end = vi.fn(async (endOptions: { triggerHappy: boolean; isCurrent?: () => boolean }) => {
    if (options.waitForRuntime) await options.waitForRuntime;
    busy = false;
    if (endOptions.triggerHappy && endOptions.isCurrent?.() !== false) feedback();
    return true;
  });
  const runtime: GestureRuntimePort = {
    beginPointerGesture: () => { if (busy) return false; busy = true; return true; },
    canConfirmPointerClick: () => true,
    promotePointerGestureToDrag: () => true,
    movePointerDrag: () => true,
    endPointerGesture: end,
  };
  const lock = vi.fn(async (locked: boolean) => { if (!locked) await options.waitForUnlock; });
  const pointerRead = vi.fn(async () => sample());
  const resync = vi.fn(async () => desktop);
  const controller = new PointerGestureController(runtime, {
    setInteractionLock: lock, setPointerPressed: () => undefined, readPointerSample: pointerRead,
  }, { resync });
  return { controller, feedback, end, lock, pointerRead, resync };
}

describe("pointer release finalization", () => {
  it("confirms a prepared stationary click and admits the next click while native unlock is pending", async () => {
    const unlock = deferred<void>();
    const h = harness({ waitForUnlock: unlock.promise });
    await h.controller.begin(1);
    const first = h.controller.finish(1, "pointerup");
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.feedback).toHaveBeenCalledTimes(1);
    expect(await h.controller.begin(1)).toBe(true);
    expect(h.controller.phase).toBe("ARMED");
    unlock.resolve();
    await first;
    expect(h.controller.phase).toBe("ARMED");
    await h.controller.cancel();
  });

  it.each([false, true])("cancels final feedback during runtime wait even with unlock pending=%s", async pendingUnlock => {
    const runtime = deferred<void>();
    const unlock = deferred<void>();
    const h = harness({ waitForRuntime: runtime.promise, waitForUnlock: pendingUnlock ? unlock.promise : undefined });
    await h.controller.begin(1);
    const finish = h.controller.finish(1, "pointerup");
    await Promise.resolve();
    expect(h.end).toHaveBeenCalledTimes(1);
    const cancellation = h.controller.cancel();
    runtime.resolve();
    unlock.resolve();
    await Promise.all([finish, cancellation]);
    expect(h.feedback).not.toHaveBeenCalled();
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.controller.phase).toBe("NONE");
  });

  it("retains cancellation ownership until runtime settles when unlock fails first", async () => {
    const runtime = deferred<void>();
    const unlock = deferred<void>();
    const h = harness({ waitForRuntime: runtime.promise, waitForUnlock: unlock.promise });
    await h.controller.begin(1);
    const finish = h.controller.finish(1, "pointerup");
    const observedFinish = finish.catch(error => error);
    const failure = new Error("unlock failed");
    unlock.reject(failure);
    await Promise.resolve();
    await Promise.resolve();
    const cancellation = h.controller.cancel().catch(error => error);
    runtime.resolve();
    expect(await observedFinish).toBe(failure);
    await cancellation;
    expect(h.feedback).not.toHaveBeenCalled();
    expect(h.end).toHaveBeenCalledTimes(1);
  });

  it("does not launch new geometry reads after a cancelled lock preparation", async () => {
    const lock = deferred<void>();
    const runtime: GestureRuntimePort = {
      beginPointerGesture: () => true, promotePointerGestureToDrag: () => true,
      movePointerDrag: () => true, endPointerGesture: async () => false,
    };
    const read = vi.fn(async () => sample());
    const resync = vi.fn(async () => desktop);
    const controller = new PointerGestureController(runtime, {
      setPointerPressed: () => undefined, readPointerSample: read,
      setInteractionLock: async locked => { if (locked) await lock.promise; },
    }, { resync });
    const begin = controller.begin(1);
    await controller.cancel();
    lock.resolve();
    expect(await begin).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
  });

  it("DOM cancellation after pointerup still cancels an unfinished Runtime release", async () => {
    const runtime = deferred<void>();
    const h = harness({ waitForRuntime: runtime.promise });
    const target = new EventTarget() as unknown as HTMLElement;
    let captured = false;
    target.setPointerCapture = () => { captured = true; };
    target.hasPointerCapture = () => captured;
    target.releasePointerCapture = () => { captured = false; };
    const errors = vi.fn();
    const binding = bindPetPointerEvents(target, { gesture: () => h.controller, isCoreHit: () => true,
      activity: () => undefined, onError: errors });
    const emit = (name: string) => {
      const event = new Event(name, { cancelable: true });
      Object.assign(event, { button: 0, pointerId: 1 });
      target.dispatchEvent(event);
    };
    emit("pointerdown");
    // Native preparation is real asynchronous work, not DOM-event completion.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    emit("pointerup");
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(h.end).toHaveBeenCalledTimes(1);
    expect(captured).toBe(false);
    binding.cancel();
    runtime.resolve();
    await h.controller.cancel();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(h.feedback).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    binding.dispose();
  });
});

describe("overlapping click-through cleanup", () => {
  it("cannot apply an old unlock sample over the next gesture lock", async () => {
    const stale = deferred<NativePointerSnapshotV1>();
    const writes: boolean[] = [];
    const pointer = new PointerHitBoxController({
      pointerSnapshot: () => stale.promise,
      setWindowClickThrough: async ({ ignore }) => { writes.push(ignore); },
    }, { setPressed: () => undefined });
    await pointer.setInteractionLock(true);
    const unlock = pointer.setInteractionLock(false);
    await pointer.setInteractionLock(true);
    stale.resolve(sample(false));
    await unlock;
    expect(writes).toEqual([false]);
    await pointer.forceSafeClickThrough();
    expect(writes).toEqual([false, true]);
  });

  it("cannot re-enable interception after a blur-safe request", async () => {
    const stale = deferred<NativePointerSnapshotV1>();
    const writes: boolean[] = [];
    const pointer = new PointerHitBoxController({
      pointerSnapshot: () => stale.promise,
      setWindowClickThrough: async ({ ignore }) => { writes.push(ignore); },
    }, { setPressed: () => undefined });
    await pointer.setInteractionLock(true);
    const unlock = pointer.setInteractionLock(false);
    await pointer.forceSafeClickThrough();
    stale.resolve(sample());
    await unlock;
    expect(writes).toEqual([false, true]);
  });
});
