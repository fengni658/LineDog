/** Production-chain regression and deterministic Native-delay measurement. */
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDefaultRuntimeResources, parseCharacterManifest } from "../src/pet-manifest";
import { PetRuntime } from "../src/pet-runtime";
import { PointerGestureController } from "../src/pointer-gesture";
import { PointerHitBoxController, isPointInsideHitBox, resolveHitBox } from "../src/pointer-hitbox";
import { FocusedInputGeometryAdapter } from "../src/input-avoidance";
import { bindPetPointerEvents } from "../src/pet-pointer-events";
import { PetBubbleController } from "../src/pet-bubble";
import { updatePetBubbleSurface } from "../src/pet-bubble-surface";
import { observePetInteractionLoss } from "../src/pet-interaction-lifecycle";
import { NativeWindowMotionAdapter, createMotionSnapshot } from "../src/native-motion";
import { NativePlatformAdapter, NATIVE_PLATFORM_PROTOCOL_VERSION } from "../src/native-platform";
import { ParachuteViewportAdapter } from "../src/parachute-viewport";
import { projectFrameHitBox } from "../src/pet-visual-geometry";

const resources = createDefaultRuntimeResources(parseCharacterManifest(JSON.parse(readFileSync(
  new URL("../public/character/manifest.json", import.meta.url), "utf8"))));
type Scenario = { name: string; latency: number; count: number; interval: number; hold: number;
  background?: boolean; focus?: "none" | "overlap"; mode?: "ordinary" | "paused" | "move" | "cancel" | "blur-unlock" | "blur-resync" | "capture-loss" | "drag-below" | "drag-at" | "land-completion"; };
const results: any[] = [];
afterAll(() => { if (process.env.LINEDOG_LATENCY_REPORT) writeFileSync(process.env.LINEDOG_LATENCY_REPORT, JSON.stringify({
  evidence: "Production modules; controlled Node EventTarget and simulated OS service delays. Not measured Windows latency or compositor output.", results }, null, 2)); });

export async function measure(config: Scenario) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  const events: any[] = [], clicks: any[] = [], nativeCalls: any[] = [], platformCalls: any[] = [];
  const now = () => performance.now();
  let runtime: PetRuntime | undefined, gesture: PointerGestureController | undefined, pointer: PointerHitBoxController | undefined;
  let inputId: number | undefined, ownerId: number | undefined, endingOwner: number | undefined;
  let x = 100, y = 460, cursorX = 180, cursorY = 540, revision = 0, compact = false;
  let frame = resources.idle.frames[0], hitBox: any = { x: 32, y: 28, width: 96, height: 110 };
  let captureOwner: number | undefined, captured = false, blurAt: number | undefined;
  const surface: any = { textContent: "", dataset: {}, style: {},
    get offsetWidth() { return this.dataset.compact === "true" ? 60 : 68; },
    get offsetHeight() { return this.dataset.compact === "true" ? 14 : 18; } };
  const state = () => ({ state: runtime?.state.behavior, interaction: runtime?.state.interaction,
    phase: gesture?.phase, revision: (runtime as any)?.behaviorRevision,
    responseId: (runtime as any)?.interactionResponse?.event.id,
    responseCompletionPending: (runtime as any)?.interactionResponse?.completionPending,
    happyCompletionPending: (runtime as any)?.happyCompletionPending,
    timelinePlaying: (runtime as any)?.timeline?.isPlaying, text: surface.textContent, visible: surface.dataset.visible });
  const log = (kind: string, data: any = {}, id = endingOwner) => events.push({ at: now(), kind, id, ...data, ...state() });
  const layout = () => updatePetBubbleSurface(surface, { frame, facing: runtime?.state.facing ?? "Right",
    grabBounds: hitBox, windowPosition: { x, y }, workArea: { x: 0, y: 0, width: 1000, height: 600 }, compact });
  const bubbles = new PetBubbleController(text => { const previous = surface.textContent; surface.textContent = text;
    if (!text) compact = false; layout(); log("caption-render", { changed: text !== previous, priorText: previous }); }, undefined, () => 0);
  const native = new NativePlatformAdapter(async (command: any, args: any) => {
    const call: any = { command, args, start: now(), end: undefined }; nativeCalls.push(call);
    if (config.latency) await new Promise(resolve => setTimeout(resolve, config.latency));
    call.end = now(); const common = { protocolVersion: NATIVE_PLATFORM_PROTOCOL_VERSION,
      snapshotRevision: ++revision, capturedAtMonotonicMs: now() };
    if (command === "desktop_snapshot") return { ...common, currentMonitorId: "monitor-1", windowScaleFactor: 1,
      monitorScaleFactor: 1, workArea: { x: 0, y: 0, width: 1000, height: 600 },
      windowPosition: { space: "WINDOW_TOP_LEFT_LOGICAL", x, y }, homeWindow: null };
    if (command === "pointer_snapshot") return { ...common, cursorScreenLogical: { x: cursorX, y: cursorY },
      windowOuterTopLeftLogical: { x, y }, relativeLogical: { x: cursorX - x, y: cursorY - y }, scaleFactor: 1 };
    if (command === "focused_input_snapshot") { const active = config.focus === "overlap";
      return { ...args, kind: active ? "dynamic-line" : "none", approximate: false,
        rectPhysical: active ? { left: 120, top: 490, right: 220, bottom: 520 } : null,
        textFocus: active, activeCaret: active, singleVisualBand: active,
        caretEvidenceKind: active ? "dynamic-line" : "none", busy: false }; }
    if (command === "set_overlay_position" || command === "set_overlay_frame") { x = args.x; y = args.y; return null; }
    return null;
  });
  const viewport = new ParachuteViewportAdapter(native, { onDesktopSnapshot: snapshot => {
    layout(); runtime?.handleDesktopSnapshot(createMotionSnapshot(snapshot)); }, reportError: (op, err) => log("error", { op, error: String(err) }) });
  const platform = new Proxy(viewport, { get(target, prop) { const value = Reflect.get(target, prop, target);
    if (typeof value !== "function") return value;
    return (...args: any[]) => { const row: any = { method: String(prop), requested: now(), resolved: undefined,
      owner: endingOwner ?? ownerId, phase: gesture?.phase, interaction: runtime?.state.interaction }; platformCalls.push(row);
      const p = value.apply(target, args);
      return Promise.resolve(p).then(result => { row.resolved = now(); return result; }, error => { row.resolved = now(); row.error = String(error); throw error; }); };
  } });
  const motion = new NativeWindowMotionAdapter(platform, { reportError: (op, err) => log("error", { op, error: String(err) }) });
  runtime = new PetRuntime(resources, { random: () => 0, motionPort: motion,
    onMotionSnapshotAccepted: snapshot => motion.acceptDesktopSnapshot(snapshot),
    setParachuteExpanded: expanded => viewport.setExpanded(expanded),
    onFrame: event => { const changed = frame.url !== event.frame.url; frame = event.frame;
      hitBox = projectFrameHitBox(frame, resolveHitBox(frame.hitBox, event.animationHitBox), runtime?.state.facing ?? "Right");
      pointer?.setHitBox(hitBox); layout(); log("frame", { animation: event.animationId, index: event.frameIndex, assetChanged: changed }); },
    onStateChange: s => { bubbles.update(!!runtime?.canShowIdleBubble,
      ["DRAG", "FALL", "LAND", "GO_HOME", "LEAVE_HOME"].includes(s.behavior) || s.restoreStatus === "busy"); layout(); log("state"); },
    onInteractionResponse: response => { bubbles.respond(response); compact = response?.kind === "playful";
      layout(); log("action-response", { response }); },
    onInteractionAcknowledged: () => { const previous = surface.textContent; bubbles.acknowledgeClick();
      log("acknowledge", { captionChanged: surface.textContent !== previous }); },
  });
  // Synchronous observation only: forward each original completion method once.
  // This measures response retirement without calling private behavior helpers from the driver.
  const finishResponse = (runtime as any).finishInteractionResponse;
  (runtime as any).finishInteractionResponse = function(response: any) {
    log("response-finish-attempt", { responseIdObserved: response.event.id });
    const value = Reflect.apply(finishResponse, this, [response]);
    if ((this as any).interactionResponse !== response) log("response-retired", { responseIdObserved: response.event.id });
    return value;
  };
  const runtimePort = {
    beginPointerGesture: () => { const accepted = runtime!.beginPointerGesture();
      if (accepted) ownerId = inputId; log("runtime-begin", { accepted }, inputId); return accepted; },
    canConfirmPointerClick: () => runtime!.canConfirmPointerClick(),
    promotePointerGestureToDrag: () => { const accepted = runtime!.promotePointerGestureToDrag(); log("drag-promote", { accepted }, ownerId); return accepted; },
    movePointerDrag: (...args: any[]) => (runtime!.movePointerDrag as any)(...args),
    endPointerGesture: async (options: any) => { const owned = ownerId; endingOwner = owned;
      log("runtime-end-start", { triggerHappy: options.triggerHappy }, owned);
      if (config.mode === "blur-resync" && blurAt === undefined) setTimeout(() => blur(), 1);
      const result = await runtime!.endPointerGesture(options);
      log("runtime-end-done", { acceptedAction: result }, owned);
      if (ownerId === owned) ownerId = undefined; if (endingOwner === owned) endingOwner = undefined;
      return result;
    },
  };
  pointer = new PointerHitBoxController(platform, { setPressed: pressed => log("pressed", { pressed }, ownerId) }, {
    reportError: (op, err) => log("error", { op, error: String(err) }),
    onPointerSample: sample => { runtime!.handlePointerSample(sample.relativeLogical); gesture?.handleGlobalPointerSample(sample); },
  });
  pointer.setHitBox(hitBox);
  gesture = new PointerGestureController(runtimePort, pointer, motion);
  const observedGesture = {
    begin: (id: number) => { const owned = inputId, before = gesture!.phase;
      const p = gesture!.begin(id); const accepted = before === "NONE" && ownerId === owned;
      log("gesture-begin-request", { admitted: accepted, priorPhase: before }, owned);
      return p.then(result => { log("gesture-begin-ready", { result }, owned); return result; }); },
    finish: (id: number, outcome: any) => { log("gesture-finish-request", { outcome }, inputId);
      const p = gesture!.finish(id, outcome);
      if (config.mode === "blur-unlock" && blurAt === undefined) setTimeout(() => blur(), 1);
      return p; },
    cancel: () => gesture!.cancel(),
  } as unknown as PointerGestureController;
  const target = new EventTarget() as unknown as HTMLElement;
  target.setPointerCapture = () => { captured = true; captureOwner = inputId; log("capture", {}, inputId); };
  target.hasPointerCapture = () => captured;
  target.releasePointerCapture = () => { captured = false; log("release-capture", {}, captureOwner); };
  const binding = bindPetPointerEvents(target, { gesture: () => observedGesture,
    isCoreHit: event => isPointInsideHitBox({ x: event.clientX, y: event.clientY }, hitBox),
    activity: () => bubbles.activity(), onError: error => log("error", { error: String(error) }) });
  const windowEvents = new EventTarget(), documentEvents = new EventTarget();
  const stopLoss = observePetInteractionLoss(windowEvents, documentEvents, () => "visible", () => {
    runtime!.cancelPendingClickResponses(); binding.cancel(); bubbles.respond(null); void pointer!.forceSafeClickThrough();
  });
  const blur = () => { blurAt = now(); log("blur"); windowEvents.dispatchEvent(new Event("blur")); };
  const focus = new FocusedInputGeometryAdapter({ readDesktopSnapshot: () => platform.desktopSnapshot(),
    readFocusedInputSnapshot: request => platform.focusedInputSnapshot(request),
    onFact: fact => { log("focus-fact", { fact }); runtime!.handleInputAvoidanceFact(fact); } });
  const advance = async (ms: number) => { if (ms > 0) await vi.advanceTimersByTimeAsync(ms); else await vi.advanceTimersByTimeAsync(0); };
  const init = runtime.initialize(async () => undefined); await advance(config.latency * 20 + 500); await init;
  if (config.background !== false) { pointer.startPolling(); focus.start(); }
  else { const first = pointer.samplePointer(); await advance(config.latency * 10 + 100); await first; }
  await advance(config.latency * 20 + 500);
  if (config.mode === "paused") runtime.setAutonomyPaused(true);
  const initialTimers = vi.getTimerCount(); const start = now();
  const emit = (type: string, id: number) => { inputId = id; log(type, {}, id);
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: cursorX - x, clientY: cursorY - y }); target.dispatchEvent(event); };
  for (let i = 0; i < config.count; i++) {
    let deadline = start + i * config.interval;
    if (config.mode === "land-completion" && i === 3) {
      const hello = events.find(e=>e.kind==="action-response"&&e.response?.kind==="hello");
      // First hello ends at 1600ms; HAPPY lasts 1800ms then LAND lasts 400ms.
      // Begin 300ms into LAND and hold 200ms across its completion callback.
      deadline = hello.at + 1600 + 1800 + 300;
    }
    await advance(Math.max(0, deadline - now()));
    if (config.mode === "move") { cursorX = x + 900; await advance(600); cursorX = x + 80; await advance(config.latency * 5 + 80); }
    else { cursorX = x + 80; cursorY = y + 80; }
    const row: any = { id: i + 1, down: now(), up: undefined }; clicks.push(row); emit("pointerdown", row.id);
    await advance(config.mode === "land-completion" && i === 3 ? 200 : config.hold);
    if (config.mode === "drag-below" || config.mode === "drag-at") {
      cursorX += config.mode === "drag-at" ? 12 : 11.9;
      await advance(config.latency * 5 + 100);
    }
    row.up = now(); emit(config.mode === "cancel" ? "pointercancel" : config.mode === "capture-loss" ? "lostpointercapture" : "pointerup", row.id);
  }
  const inputEnd = now(); await advance(Math.max(6000, config.latency * 60)); const settledAt = now();
  const terminal = state(), beforeDisposeTimers = vi.getTimerCount();
  const observed = events.slice();
  log("teardown"); focus.dispose(); stopLoss(); binding.dispose(); runtime.dispose(); bubbles.dispose(); pointer.dispose(); motion.dispose();
  const disposal = viewport.dispose(); await advance(Math.max(3000, config.latency * 60)); await disposal;
  const remainingTimers = vi.getTimerCount(); vi.clearAllTimers(); vi.useRealTimers();
  const pct = (values: number[]) => { const v = [...values].sort((a,b) => a-b); return v.length ? {
    n: v.length, min: v[0], median: (v[Math.floor((v.length-1)*.5)] + v[Math.ceil((v.length-1)*.5)]) / 2, p95: v[Math.ceil(v.length*.95)-1], max: v.at(-1) } : null; };
  const rows = clicks.map(click => {
    const own = observed.filter(e => e.id === click.id);
    const begins = own.filter(e => e.kind === "gesture-begin-request");
    const feedback = own.find(e => e.kind === "acknowledge" || (e.kind === "action-response" && e.response));
    const changed = own.find(e => e.kind === "caption-render" && e.changed && e.text);
    const action = own.find(e => e.kind === "action-response" && e.response);
    const firstFrame = own.find(e => e.kind === "frame" && e.index === 0);
    const ended = own.find(e => e.kind === "runtime-end-done");
    return { ...click, admitted: begins.some(e => e.admitted), beginReached: begins.length > 0,
      rejectionStage: begins.some(e=>e.admitted) ? null : begins.length === 0 ? "DOM-filter" :
        begins[0].priorPhase !== "NONE" ? "controller-busy" : "runtime-ending-busy",
      cancelled: config.mode === "cancel" || config.mode === "capture-loss", endCompleted: !!ended,
      action: action?.response.action ?? null, policyAcceptedAction: ended?.acceptedAction ?? false, acknowledged: !!feedback, textChanged: !!changed,
      feedbackKind: action ? "action" : feedback ? "same-or-static-caption" : "none",
      upToFeedbackMs: feedback ? feedback.at-click.up : null, downToFeedbackMs: feedback ? feedback.at-click.down : null,
      upToChangedCaptionMs: changed ? changed.at-click.up : null,
      upToActionFrameMs: action && firstFrame ? firstFrame.at-click.up : null,
      feedbackAt: feedback?.at, newCaptionAt: changed?.at,
      firstFrameChangedAsset: firstFrame?.assetChanged ?? false,
      upToEndMs: ended ? ended.at-click.up : null };
  });
  const changes = observed.filter(e => e.kind === "caption-render" && e.changed && e.text && e.at >= start && e.at <= inputEnd).map(e=>e.at);
  const gaps = changes.length ? [...changes.slice(1).map((t,i)=>t-changes[i]), inputEnd-changes.at(-1)] : [inputEnd-start];
  const requests = platformCalls.filter(c => c.requested >= start && c.requested <= inputEnd && c.resolved !== undefined);
  const actionLifecycles = observed.filter(e=>e.kind==="action-response"&&e.response&&e.at>=start).map(e=>{
    const retired = observed.find(end=>end.kind==="response-retired"&&end.responseIdObserved===e.response.id);
    return { responseId:e.response.id,kind:e.response.kind,action:e.response.action,start:e.at,
      retiredAt:retired?.at ?? null,durationMs:retired ? retired.at-e.at : null,
      declaredDurationMs:e.response.durationMs,unfinishedAtObservationEnd:!retired };
  });
  let blankSince:number|null=start, maxBlank=0;
  for (const e of observed.filter(e=>e.at>=start&&e.at<=inputEnd)) {
    if (e.text && blankSince!==null) { maxBlank=Math.max(maxBlank,e.at-blankSince);blankSince=null; }
    else if (!e.text && blankSince===null) blankSince=e.at;
  }
  if(blankSince!==null)maxBlank=Math.max(maxBlank,inputEnd-blankSince);
  const summary = { config, start, inputEnd, settledAt, sent: rows.length, admitted: rows.filter(r=>r.admitted).length,
    noAdmission: rows.filter(r=>!r.admitted).length, domFiltered: rows.filter(r=>!r.beginReached).length,
    ended: rows.filter(r=>r.endCompleted).length, feedbackClicks: rows.filter(r=>r.acknowledged).length,
    actionClicks: rows.filter(r=>r.action).length, policyAcceptedActions: rows.filter(r=>r.policyAcceptedAction).length,
    totalResponses: observed.filter(e=>e.kind==="action-response"&&e.response&&e.at>=start).length,
    totalCaptionChangesDuringInputs: changes.length,
    sameCaptionAcknowledgements: rows.filter(r=>r.acknowledged&&!r.textChanged).length,
    changedCaptionClicks: rows.filter(r=>r.textChanged).length,
    upToFeedbackMs: pct(rows.flatMap(r=>r.upToFeedbackMs===null?[]:[r.upToFeedbackMs])),
    downToFeedbackMs: pct(rows.flatMap(r=>r.downToFeedbackMs===null?[]:[r.downToFeedbackMs])),
    upToActionFrameMs: pct(rows.flatMap(r=>r.upToActionFrameMs===null?[]:[r.upToActionFrameMs])),
    maxNoChangedCaptionDuringInputsMs: Math.max(...gaps), maxEmptyCaptionDuringInputsMs:maxBlank,
    rejectionStages: Object.fromEntries(["DOM-filter","controller-busy","runtime-ending-busy"].map(stage=>[stage,rows.filter(r=>r.rejectionStage===stage).length])),
    actionLifecycles,
    platformRequestDurationMs: pct(requests.map(c=>c.resolved-c.requested)),
    nativeServiceMs: config.latency, terminal, initialTimers, beforeDisposeTimers, remainingTimers,
    feedbackAfterBlur: blurAt===undefined?null:observed.filter(e=>e.at>blurAt&&(e.kind==="acknowledge"||(e.kind==="action-response"&&e.response))).length,
    errors: observed.filter(e=>e.kind==="error") };
  return { summary, clicks: rows, events: observed, nativeCalls, platformCalls };
}

const scenarios: Scenario[] = [];
for (const latency of [0,7,35,120]) {
  for (const background of [false,true]) for (const hold of [10,120]) scenarios.push({ name:`isolated-L${latency}-bg${background}-hold${hold}`, latency, background, hold, count:4, interval:6000 });
  for (const interval of [50,150,400,1250]) scenarios.push({ name:`burst-L${latency}-I${interval}`, latency, hold:10, interval, count:40 });
}
for (const mode of ["paused","move","cancel","capture-loss","drag-below","drag-at","blur-unlock","blur-resync"] as const)
  scenarios.push({ name:`mode-${mode}`, mode, latency:35, hold:mode.startsWith("drag")?500:120, interval:2000, count:mode.startsWith("blur")?1:5 });
for(const latency of [7,35,120]) scenarios.push({ name:`hold-2s-L${latency}`,latency,hold:2000,interval:6000,count:4 });
for(const latency of [7,35]) scenarios.push({ name:`instant-release-L${latency}`,latency,hold:0,interval:150,count:40 });
scenarios.push({ name:"land-completion-held",mode:"land-completion",latency:0,hold:10,interval:400,count:4 });
scenarios.push({ name:"overlap-repeat",focus:"overlap",latency:35,hold:40,interval:1250,count:30 });
scenarios.push({ name:"long-120s-L7",latency:7,hold:40,interval:400,count:300 });
scenarios.push({ name:"long-120s-L35",latency:35,hold:40,interval:400,count:300 });
describe("read-only latency and reliability characterization", () => {
  it.each(scenarios)("$name", async config => {
    const result = await measure(config); results.push(result);
    expect(result.summary.errors, "invalid harness/native protocol is not a product latency result").toEqual([]);
    expect(result.summary.remainingTimers).toBe(0);
    if (config.name === "burst-L35-I150") {
      expect(result.summary.admitted).toBe(40);
      expect(result.summary.feedbackClicks).toBe(40);
      expect(result.summary.rejectionStages["controller-busy"]).toBe(0);
      expect(result.summary.rejectionStages["runtime-ending-busy"]).toBe(0);
    }
    if (config.name === "isolated-L35-bgtrue-hold10") {
      expect(result.summary.upToFeedbackMs.median).toBeLessThanOrEqual(100);
    }
    if (config.name.startsWith("long-120s")) {
      expect(result.summary.admitted).toBe(300);
      expect(result.summary.feedbackClicks).toBe(300);
      expect(result.summary.totalResponses).toBeGreaterThan(30);
      expect(result.summary.terminal.state).not.toBe("HAPPY");
      expect(result.summary.terminal.happyCompletionPending).toBe(false);
    }
  }, 30000);
});


describe("DIAGNOSTIC regression checks (red on released 1.3.7)", () => {
  it("DIAGNOSTIC HAPPY must settle after admitted repeated clicks stop", async () => {
    const result = await measure({ name:"diagnostic-happy-stuck",latency:35,hold:40,interval:400,count:25 });
    results.push(result);
    expect(result.summary.terminal.state).not.toBe("HAPPY");
  });
  it("DIAGNOSTIC HAPPY internal LAND must settle after a held completion", async () => {
    const result = await measure({ name:"diagnostic-land-stuck",mode:"land-completion",latency:0,hold:10,interval:400,count:4 });
    results.push(result);
    expect(result.summary.terminal.state).not.toBe("HAPPY");
  });
  it.each(["blur-unlock","blur-resync"] as const)("DIAGNOSTIC %s must not present an old click after cancellation", async mode => {
    const result = await measure({ name:`diagnostic-${mode}`,mode,latency:35,hold:120,interval:2000,count:1 });
    results.push(result);
    expect(result.summary.feedbackAfterBlur).toBe(0);
  });
});
