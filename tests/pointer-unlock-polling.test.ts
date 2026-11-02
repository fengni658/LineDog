import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativePointerSnapshotV1 } from "../src/native-platform";
import { PointerHitBoxController, POLL_INTERVAL_MS } from "../src/pointer-hitbox";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const sample = (inside: boolean): NativePointerSnapshotV1 => ({
  protocolVersion: 1, snapshotRevision: 1, capturedAtMonotonicMs: 0, scaleFactor: 1,
  cursorScreenLogical: { x: inside ? 180 : 900, y: 540 },
  windowOuterTopLeftLogical: { x: 100, y: 460 },
  relativeLogical: { x: inside ? 80 : 800, y: 80 },
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const controllers: PointerHitBoxController[] = [];
afterEach(async () => {
  for (const pointer of controllers.splice(0)) pointer.dispose();
  await flush();
  vi.useRealTimers();
});

async function harness() {
  vi.useFakeTimers();
  const writes: boolean[] = [];
  let next: Promise<NativePointerSnapshotV1> | undefined;
  let writeGate: Promise<void> | undefined;
  const read = vi.fn(async () => next ?? sample(true));
  const pointer = new PointerHitBoxController({
    pointerSnapshot: read,
    setWindowClickThrough: async ({ ignore }) => { writes.push(ignore); await writeGate; },
  }, { setPressed: () => undefined });
  controllers.push(pointer);
  pointer.startPolling();
  await flush();
  return { pointer, read, writes,
    setNext: (value: Promise<NativePointerSnapshotV1>) => { next = value; },
    setWriteGate: (value: Promise<void>) => { writeGate = value; },
  };
}

describe("release shares regular pointer polling", () => {
  it("reuses a poll from the same lock epoch instead of adding an unlock read", async () => {
    const h = await harness();
    await h.pointer.setInteractionLock(true);
    const pending = deferred<NativePointerSnapshotV1>();
    h.setNext(pending.promise);
    const poll = h.pointer.samplePointer();
    const beforeRelease = h.read.mock.calls.length;
    await h.pointer.setInteractionLock(false);
    expect(h.read).toHaveBeenCalledTimes(beforeRelease);
    pending.resolve(sample(false));
    await poll;
    expect(h.writes.at(-1)).toBe(true);
  });

  it("uses the next regular poll when no read is in flight", async () => {
    const h = await harness();
    await h.pointer.setInteractionLock(true);
    h.setNext(Promise.resolve(sample(false)));
    const beforeRelease = h.read.mock.calls.length;
    await h.pointer.setInteractionLock(false);
    expect(h.read).toHaveBeenCalledTimes(beforeRelease);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.read).toHaveBeenCalledTimes(beforeRelease + 1);
    expect(h.writes.at(-1)).toBe(true);
  });

  it("does not revive a pre-lock poll when releasing that lock", async () => {
    const h = await harness();
    const old = deferred<NativePointerSnapshotV1>();
    h.setNext(old.promise);
    const poll = h.pointer.samplePointer();
    await h.pointer.setInteractionLock(true);
    await h.pointer.setInteractionLock(false);
    old.resolve(sample(false));
    await poll;
    expect(h.writes.at(-1)).toBe(false);
    h.setNext(Promise.resolve(sample(false)));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(h.writes.at(-1)).toBe(true);
  });

  it("invalidates a reused unlock poll when the next gesture locks", async () => {
    const h = await harness();
    await h.pointer.setInteractionLock(true);
    const old = deferred<NativePointerSnapshotV1>();
    h.setNext(old.promise);
    const poll = h.pointer.samplePointer();
    await h.pointer.setInteractionLock(false);
    await h.pointer.setInteractionLock(true);
    old.resolve(sample(false));
    await poll;
    expect(h.writes.at(-1)).toBe(false);
  });

  it("invalidates a reused unlock poll after blur requests safe pass-through", async () => {
    const h = await harness();
    await h.pointer.setInteractionLock(true);
    const old = deferred<NativePointerSnapshotV1>();
    h.setNext(old.promise);
    const poll = h.pointer.samplePointer();
    await h.pointer.setInteractionLock(false);
    await h.pointer.forceSafeClickThrough();
    old.resolve(sample(true));
    await poll;
    expect(h.writes.at(-1)).toBe(true);
  });

  it("performs fresh cleanup if polling stops before the pending release gets a poll", async () => {
    const h = await harness();
    await h.pointer.setInteractionLock(true);
    h.setNext(Promise.resolve(sample(false)));
    await h.pointer.setInteractionLock(false);
    const beforeStop = h.read.mock.calls.length;
    h.pointer.stopPolling();
    await flush();
    expect(h.read).toHaveBeenCalledTimes(beforeStop + 1);
    expect(h.writes.at(-1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps stop-polling fallback stale when a newer lock arrives", async () => {
    const h = await harness();
    await h.pointer.setInteractionLock(true);
    const old = deferred<NativePointerSnapshotV1>();
    h.setNext(old.promise);
    await h.pointer.setInteractionLock(false);
    h.pointer.stopPolling();
    await h.pointer.setInteractionLock(true);
    old.resolve(sample(false));
    await flush();
    expect(h.writes.at(-1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still refreshes on stop when release occurs during a poll's locked-policy write", async () => {
    const h = await harness();
    await h.pointer.forceSafeClickThrough();
    const nativeWrite = deferred<void>();
    h.setWriteGate(nativeWrite.promise);
    const lock = h.pointer.setInteractionLock(true);
    await flush();
    h.setNext(Promise.resolve(sample(false)));
    const poll = h.pointer.samplePointer();
    await flush();
    await h.pointer.setInteractionLock(false);
    nativeWrite.resolve();
    await Promise.all([lock, poll]);
    expect(h.writes.at(-1)).toBe(false);
    const beforeStop = h.read.mock.calls.length;
    h.pointer.stopPolling();
    await flush();
    expect(h.read).toHaveBeenCalledTimes(beforeStop + 1);
    expect(h.writes.at(-1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes directly to safe pass-through without adding a fallback read", async () => {
    const h = await harness();
    await h.pointer.setInteractionLock(true);
    await h.pointer.setInteractionLock(false);
    const beforeDispose = h.read.mock.calls.length;
    h.pointer.dispose();
    await flush();
    expect(h.read).toHaveBeenCalledTimes(beforeDispose);
    expect(h.writes.at(-1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
