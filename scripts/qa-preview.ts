/** Development-only frontend fixture. Never import the Tauri bootstrap here. */
import type { TimelineClock, TimelineFrameEvent } from "../src/animation-timeline";
import { computeHomeRestPoint, computeHomeSurfaceRect } from "../src/home-cycle";
import type { LogicalPoint, MotionSnapshot, PetMotionPort, WindowTopLeftLogical } from "../src/native-motion";
import type { NativePointerSnapshotV1 } from "../src/native-platform";
import { applyParachuteVisual, createParachuteMarkup } from "../src/parachute-renderer";
import { PET_BEHAVIOR_CONFIG, RUNTIME_FOOT_BASELINE_LOGICAL_PX } from "../src/pet-behavior-core";
import { loadDefaultRuntimeResources, type DefaultRuntimeResources, type RuntimeAnimation } from "../src/pet-manifest";
import { PetBubbleController } from "../src/pet-bubble";
import { updatePetBubbleSurface } from "../src/pet-bubble-surface";
import { PetRuntime, type PetRuntimeState } from "../src/pet-runtime";
import { projectFrameHitBox } from "../src/pet-visual-geometry";
import { PointerGestureController, type PointerGestureEnd } from "../src/pointer-gesture";
import { resolveHitBox } from "../src/pointer-hitbox";
import { observeSpriteMotionPreference } from "../src/sprite-motion-preference";
import {
  applySpriteDraggingState, applySpriteFacing, applySpriteHappyFeedback,
  applySpriteSleepingState, createBrowserImageLoader, createSpriteSurfaceMarkup,
  CROSSFADE_ANIMATION_IDS, resolveSpriteFacing, SmoothSpriteFrameRenderer,
} from "../src/sprite-renderer";

const AREA = { x: 0, y: 0, width: 800, height: 600 };
const MONITOR = "qa-synthetic-monitor";
const HOME = computeHomeSurfaceRect(AREA)!;
const FAR_POINTER = { x: -10_000, y: -10_000 };
const PARACHUTE_TOP_INSET = PET_BEHAVIOR_CONFIG.parachute.viewportTopInsetLogicalPx;
const SYNTHETIC_POINTER_ID = -1;

/** Runs timers at their due time and drains promise-based motion confirmations. */
class PreviewClock implements TimelineClock {
  private time = 0;
  private sequence = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + Math.max(0, delayMs), callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  async advanceBy(deltaMs: number): Promise<void> {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new Error("Invalid clock delta");
    const target = this.time + deltaMs;
    let iterations = 0;
    while (true) {
      let selected: number | undefined;
      let due = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < due) { selected = id; due = timer.at; }
      }
      if (selected === undefined) break;
      this.time = due;
      const timer = this.timers.get(selected)!;
      this.timers.delete(selected);
      timer.callback();
      await flushMotion();
      if (++iterations > 200_000) throw new Error("Fixture timer limit reached");
      if (iterations % 500 === 0) await yieldToPage();
    }
    this.time = target;
    await flushMotion();
  }
}

async function flushMotion(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
const yieldToPage = (): Promise<void> => new Promise(resolve => window.setTimeout(resolve, 0));
function seededRandom(): () => number {
  let seed = 122;
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
}
function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing fixture element: ${id}`);
  return found as T;
}
const world = element("world");
const petWindow = element("pet-window");
petWindow.innerHTML = createParachuteMarkup() + createSpriteSurfaceMarkup();
const parachute = petWindow.querySelector<HTMLElement>(".pet-parachute")!;
const stage = element("pet-stage");
const bubbleElement = document.createElement("div");
bubbleElement.className = "pet-bubble";
bubbleElement.setAttribute("role", "status");
stage.append(bubbleElement);
const sprite = element<HTMLImageElement>("pet-sprite");
const under = element<HTMLImageElement>("pet-sprite-under");
const feedback = element("pet-feedback");
const hitbox = element("pet-hitbox");
const status = element("status");
const message = element("message");
const eventList = element("events");
const pointerDot = element("pointer-dot");
const runButton = element<HTMLButtonElement>("run");
const pauseButton = element<HTMLButtonElement>("pause");
const animationSelect = element<HTMLSelectElement>("animation");
const frameIndex = element<HTMLInputElement>("frame-index");
const facingSelect = element<HTMLSelectElement>("facing");
const failExpansion = element<HTMLInputElement>("fail-expansion");
const reduceMotion = element<HTMLInputElement>("reduce-motion");
const motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
Object.assign(element("home-window").style, { left: `${HOME.x}px`, top: `${HOME.y}px` });

let resources: DefaultRuntimeResources;
let animations: RuntimeAnimation[] = [];
let clock = new PreviewClock();
let renderer = new SmoothSpriteFrameRenderer(clock);
let runtime: PetRuntime | undefined;
let bubbles: PetBubbleController | undefined;
let bubbleCompact = false;
let gesture: PointerGestureController | undefined;
let position: WindowTopLeftLogical = { space: "WINDOW_TOP_LEFT_LOGICAL", x: 320, y: 460 };
let pointer: LogicalPoint = { ...FAR_POINTER };
let frame: TimelineFrameEvent | undefined;
let running = false;
let busy = false;
let inspection = false;
let capturedPointer: number | undefined;
let previousStateKey = "";
let motionWrites = 0;
let sampleRevision = 0;
let generation = 0;
let viewportExpanded = false;
let expansionRequests = 0;
let expansionFailures = 0;
let resizeFootDelta = 0;
let syntheticHeld = false;
const motionPreference = observeSpriteMotionPreference(motionMedia, () => {
  if (inspection) inspectFrame();
  else if (frame) renderer.render({ sprite, under }, frame.frame, false);
});

function note(text: string): void {
  const row = document.createElement("li");
  row.textContent = `${(clock.now() / 1000).toFixed(2)}s · ${text}`;
  eventList.prepend(row);
  while (eventList.children.length > 50) eventList.lastElementChild?.remove();
}
function snapshot(): MotionSnapshot {
  return {
    currentMonitorId: MONITOR, windowScaleFactor: 1, monitorScaleFactor: 1,
    workArea: { ...AREA }, windowPosition: { ...position },
    homeWindow: { ready: true, currentMonitorId: MONITOR, windowScaleFactor: 1, rect: { ...HOME } },
  };
}
function sample(): NativePointerSnapshotV1 {
  return {
    protocolVersion: "linedog.native/v1", snapshotRevision: ++sampleRevision, capturedAtMonotonicMs: clock.now(),
    cursorScreenLogical: { ...pointer }, windowOuterTopLeftLogical: { ...position },
    relativeLogical: { x: pointer.x - position.x, y: pointer.y - position.y }, scaleFactor: 1,
  };
}
function samplePointer(): void {
  const current = sample();
  runtime?.handlePointerSample(current.relativeLogical);
  gesture?.handleGlobalPointerSample(current);
  pointerDot.hidden = pointer.x < 0 || pointer.x > AREA.width || pointer.y < 0 || pointer.y > AREA.height;
  pointerDot.style.left = `${pointer.x}px`;
  pointerDot.style.top = `${pointer.y}px`;
}
function setPointer(point: LogicalPoint): void { pointer = { ...point }; samplePointer(); }
function positionPet(): void {
  // The fixture MotionPort already consumes normalized dog-canvas coordinates.
  // Only this DOM boundary converts them to the simulated outer-window frame.
  const inset = viewportExpanded ? PARACHUTE_TOP_INSET : 0;
  petWindow.style.left = `${position.x}px`;
  petWindow.style.top = `${position.y - inset}px`;
  petWindow.dataset.parachuteExpanded = String(viewportExpanded);
  Object.assign(element("foot-marker").style, {
    left: `${position.x + 80}px`, top: `${position.y + RUNTIME_FOOT_BASELINE_LOGICAL_PX}px`,
  });
}
function reducedMotion(): boolean { return motionMedia.matches || reduceMotion.checked; }
function allowsCrossfade(): boolean { return motionPreference.allowsCrossfade() && !reduceMotion.checked; }
function updateMotionPreference(): void {
  runtime?.setReducedMotion(reducedMotion());
  world.dataset.reducedMotion = String(reducedMotion());
  if (inspection) inspectFrame();
  else if (frame) renderer.render({ sprite, under }, frame.frame, false);
  refresh();
}
motionMedia.addEventListener("change", updateMotionPreference);
reduceMotion.addEventListener("change", updateMotionPreference);
function applyHitbox(event: TimelineFrameEvent): void {
  const box = projectFrameHitBox(event.frame, resolveHitBox(event.frame.hitBox, event.animationHitBox),
    stage.dataset.facing === "Left" ? "Left" : "Right");
  Object.assign(hitbox.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
}
function updateBubble(): void {
  updatePetBubbleSurface(bubbleElement, {
    frame: frame?.frame, facing: stage.dataset.facing === "Left" ? "Left" : "Right",
    grabBounds: frame ? projectFrameHitBox(frame.frame, resolveHitBox(frame.frame.hitBox, frame.animationHitBox), stage.dataset.facing === "Left" ? "Left" : "Right") : { x: 32, y: 28, width: 96, height: 110 },
    windowPosition: position, workArea: AREA, compact: bubbleCompact,
  });
}
function renderFrame(event: TimelineFrameEvent): void {
  renderer.render({ sprite, under }, event.frame,
    CROSSFADE_ANIMATION_IDS.has(event.animationId) && allowsCrossfade());
  applyHitbox(event);
  updateBubble();
}
function applyState(state: Readonly<PetRuntimeState>): void {
  stage.dataset.runtimeState = state.readiness;
  applySpriteFacing(stage, resolveSpriteFacing(state.behavior, state.facing, state.visualTransition,
    state.turnFrameMirrored, state.activeAnimationId));
  applySpriteHappyFeedback(stage, feedback, state.behavior);
  applySpriteDraggingState(stage, state.isDragging);
  applySpriteSleepingState(stage, state.behavior, state.activeAnimationId);
  applyParachuteVisual(parachute, state.parachutePhase, state.parachuteProgress);
  if (frame) applyHitbox(frame);
  bubbles?.update(!!runtime?.canShowIdleBubble, ["DRAG", "FALL", "LAND", "GO_HOME", "LEAVE_HOME"].includes(state.behavior) || state.restoreStatus === "busy");
  updateBubble();
}
function refresh(): void {
  if (!runtime) return;
  const state = runtime.state;
  const diagnostic = runtime.diagnosticState;
  const restDeadline = state.homeRestDeadlineMs;
  status.textContent = [
    `模式：${inspection ? "素材检查（非 Runtime 输出）" : "Runtime"}`,
    `时钟：${(clock.now() / 1000).toFixed(3)}s ${running ? "运行中" : "冻结"}`,
    `状态：${state.behavior} / ${diagnostic.home_stage}`,
    `等待原因：${diagnostic.wait_reason}`,
    `动画：${state.activeAnimationId} [${frame?.frameIndex ?? "—"}]`,
    `交互：${state.interaction} / 控制器 ${gesture?.phase ?? "NONE"}`,
    `朝向：${state.facing} / 展示 ${stage.dataset.facing}`,
    `规范画板：(${position.x.toFixed(2)}, ${position.y.toFixed(2)}) · 160 × 160`,
    `替身外窗：(${position.x.toFixed(2)}, ${(position.y - (viewportExpanded ? PARACHUTE_TOP_INSET : 0)).toFixed(2)}) · 160 × ${viewportExpanded ? 240 : 160}`,
    `世界脚点：(${(position.x + 80).toFixed(2)}, ${(position.y + RUNTIME_FOOT_BASELINE_LOGICAL_PX).toFixed(2)})`,
    `降落伞：${state.parachutePhase} · ${(state.parachuteProgress * 100).toFixed(1)}%`,
    `下落速度：${state.verticalVelocityLogicalPxPerSecond?.toFixed(2) ?? "—"} px/s`,
    `替身扩窗：请求 ${expansionRequests} / 失败 ${expansionFailures} · 最近缩放脚点偏移 ${resizeFootDelta.toFixed(2)}px`,
    `扩窗失败开关：${failExpansion.checked ? "开" : "关"} · 减少动态效果：${reducedMotion() ? "开" : "关"}${motionMedia.matches ? "（系统）" : ""}`,
    `往返：${state.homeRoundTripsCompleted ?? 0}/${state.homeRoundTripsTarget ?? "—"}`,
    `窝内起点：${state.homeAwakeStartedAtMs === undefined ? "—" : `${(state.homeAwakeStartedAtMs / 1000).toFixed(2)}s`}`,
    `睡眠剩余：${restDeadline === undefined ? "—" : `${Math.max(0, (restDeadline - clock.now()) / 1000).toFixed(2)}s`}`,
    `已确认替身位置写入：${motionWrites}`,
    `Native：未连接 · Model：未连接`,
  ].join("\n");
  runButton.textContent = seeking ? "停止快进" : running ? "冻结预览时钟" : "开始连续运行";
  pauseButton.textContent = state.autonomyPaused ? "恢复自主活动" : "暂停自主活动";
  for (const control of document.querySelectorAll<HTMLButtonElement>("button")) control.disabled = busy;
  runButton.disabled = false; // Also stops an in-progress seek on the next 250ms slice.
  animationSelect.disabled = busy;
  frameIndex.disabled = busy;
  failExpansion.disabled = busy;
  reduceMotion.disabled = busy;
  element<HTMLButtonElement>("regrab").disabled = busy || inspection || gesture?.phase !== "NONE" ||
    !["OPENING", "GLIDING"].includes(state.parachutePhase);
  element<HTMLButtonElement>("release-regrab").disabled = busy || !syntheticHeld;
}
function returnToRuntime(): void {
  if (!inspection || !runtime) return;
  inspection = false;
  applyState(runtime.state);
  if (frame) { renderer.render({ sprite, under }, frame.frame, false); applyHitbox(frame); }
  message.textContent = "已返回 Runtime 当前画面";
}
async function action(label: string, operation: () => Promise<void> | void): Promise<void> {
  if (busy || !runtime) return;
  busy = true;
  returnToRuntime();
  refresh();
  try { await operation(); message.textContent = label; }
  catch (error) { running = false; message.textContent = `夹具失败：${error instanceof Error ? error.message : String(error)}`; note(message.textContent); }
  finally { busy = false; refresh(); }
}

async function reset(): Promise<void> {
  running = false;
  generation++;
  releaseCapture();
  await gesture?.cancel();
  runtime?.dispose();
  bubbles?.dispose();
  renderer.dispose();
  syntheticHeld = false;
  clock = new PreviewClock();
  renderer = new SmoothSpriteFrameRenderer(clock);
  bubbles = new PetBubbleController(text => { bubbleElement.textContent = text; if (!text) bubbleCompact = false; updateBubble(); }, clock, seededRandom());
  position = { space: "WINDOW_TOP_LEFT_LOGICAL", x: 320, y: 460 };
  pointer = { ...FAR_POINTER };
  frame = undefined;
  inspection = false;
  previousStateKey = "";
  motionWrites = 0;
  viewportExpanded = false;
  expansionRequests = 0;
  expansionFailures = 0;
  resizeFootDelta = 0;
  applyParachuteVisual(parachute, "NONE", 0);
  eventList.replaceChildren();
  positionPet();
  const instance = generation;
  const motion: PetMotionPort = {
    resync: async () => snapshot(),
    readCurrentWorkArea: async () => snapshot(),
    writeWindowTopLeft: async next => {
      if (instance !== generation) return;
      position = { ...next };
      motionWrites++;
      positionPet();
    },
  };
  const random = seededRandom();
  runtime = new PetRuntime(resources, {
    clock, random, homeRandom: random, motionPort: motion,
    setParachuteExpanded: async expanded => {
      if (instance !== generation) return false;
      if (expanded) {
        expansionRequests++;
        if (failExpansion.checked || position.y - PARACHUTE_TOP_INSET < AREA.y) {
          expansionFailures++;
          note("替身拒绝扩窗；交回 Runtime 普通 FALL");
          return false;
        }
      }
      const beforeFoot = Number.parseFloat(petWindow.style.top) +
        (viewportExpanded ? PARACHUTE_TOP_INSET : 0) + RUNTIME_FOOT_BASELINE_LOGICAL_PX;
      viewportExpanded = expanded;
      positionPet();
      const afterFoot = Number.parseFloat(petWindow.style.top) +
        (viewportExpanded ? PARACHUTE_TOP_INSET : 0) + RUNTIME_FOOT_BASELINE_LOGICAL_PX;
      resizeFootDelta = afterFoot - beforeFoot;
      note(`替身${expanded ? "扩窗至 160×240" : "缩窗至 160×160"}；脚点偏移 ${resizeFootDelta.toFixed(2)}px`);
      return true;
    },
    onInteractionResponse: response => { bubbles?.respond(response); bubbleCompact = response?.kind === "playful"; updateBubble(); if (response) note(`回应：${response.kind} / ${response.action}`); },
    onFrame: event => { frame = event; if (!inspection) renderFrame(event); },
    onStateChange: state => {
      if (!inspection) applyState(state);
      const key = `${state.behavior}/${state.activeAnimationId}/${state.interaction}/${state.parachutePhase}`;
      if (key !== previousStateKey) { previousStateKey = key; note(key); }
    },
    onHomeLifecycle: event => note(event.type),
  });
  runtime.setReducedMotion(reducedMotion());
  world.dataset.reducedMotion = String(reducedMotion());
  gesture = new PointerGestureController(runtime, {
    readPointerSample: async () => sample(),
    setInteractionLock: async () => undefined,
    setPointerPressed: pressed => { stage.dataset.pressed = String(pressed); },
  }, motion);
  await runtime.initialize(createBrowserImageLoader());
  runtime.handleInputAvoidanceFact({ kind: "none", approximate: false, revision: 1, monitorId: MONITOR, workArea: { ...AREA } });
  const poll = (): void => {
    if (instance !== generation) return;
    samplePointer();
    clock.setTimeout(poll, 1000 / 30);
  };
  poll();
  note("真实资源已加载；受控 MotionPort 就绪");
}

let seeking = false;
async function seek(until: () => boolean): Promise<void> {
  running = false;
  seeking = true;
  setPointer(FAR_POINTER);
  const deadline = clock.now() + 20 * 60_000;
  while (seeking && !until() && clock.now() < deadline) {
    await clock.advanceBy(250);
    refresh();
    await yieldToPage();
  }
  seeking = false;
  if (!until()) throw new Error("尚未到达目标（已停止或达到 20 分钟模拟上限）；检查暂停与等待原因");
}
function bind(id: string, label: string, operation: () => Promise<void> | void): void {
  element(id).addEventListener("click", () => { void action(label, operation); });
}
runButton.addEventListener("click", () => {
  if (seeking) { seeking = false; return; }
  if (busy) return;
  returnToRuntime(); running = !running; refresh();
});
bind("step", "已步进 33ms", async () => { running = false; await clock.advanceBy(33); });
bind("advance", "已按定时器顺序推进 10 秒", async () => { running = false; await clock.advanceBy(10_000); });
bind("rest", "已到达 REST", () => seek(() => runtime?.state.behavior === "REST"));
bind("sleep", "已到达睡眠", () => seek(() => runtime?.diagnosticState.home_stage === "SLEEP"));
bind("reset", "已重置；点击开始可重复相同自然周期", reset);
bind("pause", "自主活动策略已切换；预览时钟独立运行", () => runtime?.setAutonomyPaused(!runtime.state.autonomyPaused));
bind("near", "已发送靠近样本", () => setPointer({ x: position.x + 80, y: position.y + 80 }));
bind("away", "已发送远离样本；LOOK 退出需推进时钟", () => setPointer(FAR_POINTER));
async function syntheticGesture(outcome: PointerGestureEnd, drop?: LogicalPoint): Promise<void> {
  if (!gesture || !runtime) return;
  setPointer({ x: position.x + 80, y: position.y + 80 });
  if (!await gesture.begin(SYNTHETIC_POINTER_ID)) throw new Error("当前 Runtime 未接受手势");
  if (drop) {
    setPointer({ x: drop.x + 80, y: drop.y + 80 });
    await flushMotion();
    await clock.advanceBy(34);
  }
  await gesture.finish(SYNTHETIC_POINTER_ID, outcome);
  setPointer(FAR_POINTER);
}
bind("click", "已通过实际手势控制器执行点击", () => syntheticGesture("pointerup"));
bind("click-three", "已执行三次有效点击", async () => { for (let i = 0; i < 3; i++) { await syntheticGesture("pointerup"); await clock.advanceBy(150); } });
bind("click-ten", "已执行十次有效点击", async () => { for (let i = 0; i < 10; i++) { await syntheticGesture("pointerup"); await clock.advanceBy(100); } });
bind("bubbles-toggle", "已切换本地气泡", () => bubbles?.setEnabled(!bubbles.enabled));
bind("cancel", "已通过实际手势控制器取消按压", () => syntheticGesture("pointercancel"));
bind("drop", "已提起并在窝垫上方释放；推进时钟观察 FALL → LAND → REST", () => {
  const rest = computeHomeRestPoint(AREA, HOME)!;
  return syntheticGesture("pointerup", { x: rest.x, y: rest.y - 90 });
});
async function dropScenario(drop: LogicalPoint): Promise<void> {
  await reset();
  runtime?.setAutonomyPaused(true);
  await syntheticGesture("pointerup", drop);
  await flushMotion();
  note(`受控松手场景：规范画板 (${drop.x}, ${drop.y})；自主活动已暂停`);
}
bind("drop-low", "低处 70px 松手已就绪；开始运行或步进观察普通下落", () =>
  dropScenario({ x: 180, y: AREA.height - RUNTIME_FOOT_BASELINE_LOGICAL_PX - 70 }));
bind("drop-high", "高处 360px 松手已就绪；开始运行或步进观察降落伞", () =>
  dropScenario({ x: 180, y: AREA.height - RUNTIME_FOOT_BASELINE_LOGICAL_PX - 360 }));
bind("drop-high-home", "窝垫上方 320px 松手已就绪；开始运行或步进观察落垫收伞", () => {
  const rest = computeHomeRestPoint(AREA, HOME)!;
  return dropScenario({ x: rest.x, y: rest.y - 320 });
});
bind("regrab", "已再次抓取并向上提起 16px；时钟冻结，点击松开二次抓取继续", async () => {
  if (!gesture || !runtime || !["OPENING", "GLIDING"].includes(runtime.state.parachutePhase)) {
    throw new Error("请先运行高处松手场景至开伞");
  }
  running = false;
  const initial = { ...position };
  setPointer({ x: initial.x + 80, y: initial.y + 80 });
  if (!await gesture.begin(SYNTHETIC_POINTER_ID)) throw new Error("当前 Runtime 未接受二次抓取");
  syntheticHeld = true;
  setPointer({ x: initial.x + 80, y: initial.y + 64 });
  await flushMotion();
  await clock.advanceBy(34);
});
bind("release-regrab", "已松开二次抓取；开始运行或步进继续观察", async () => {
  await gesture?.finish(SYNTHETIC_POINTER_ID, "pointerup");
  syntheticHeld = false;
  setPointer(FAR_POINTER);
});
failExpansion.addEventListener("change", () => {
  note(`替身扩窗失败已${failExpansion.checked ? "开启" : "关闭"}（下一次扩窗请求生效）`);
  refresh();
});
bind("runtime-view", "已返回 Runtime 当前画面", returnToRuntime);
element("repeat-frame").addEventListener("click", () => {
  if (busy || !runtime || gesture?.phase !== "NONE") return;
  inspectFrame();
  const animation = animations.find(item => item.animationId === animationSelect.value)!;
  const selected = animation.frames[Number(frameIndex.value)];
  renderer.render({ sprite, under }, selected, allowsCrossfade());
  renderer.render({ sprite, under }, selected, allowsCrossfade());
  element("frame-info").textContent += `\n同帧重复后：主层 opacity=${sprite.style.opacity}，下层 opacity=${under.style.opacity}（应为 1 / 0）`;
  message.textContent = "重复提交相同 relative URL；可检查实际 HTMLImageElement.src 绝对路径身份问题";
});
element<HTMLInputElement>("guides").addEventListener("change", event => {
  world.dataset.guides = String((event.target as HTMLInputElement).checked);
});

function inspectFrame(): void {
  if (busy || !runtime || gesture?.phase !== "NONE") return;
  running = false;
  inspection = true;
  const animation = animations.find(item => item.animationId === animationSelect.value)!;
  frameIndex.max = String(animation.frames.length - 1);
  const index = Math.min(Number(frameIndex.value), animation.frames.length - 1);
  frameIndex.value = String(index);
  const selected = animation.frames[index];
  const facing = facingSelect.value === "Left" ? "Left" : "Right";
  applySpriteFacing(stage, facing);
  applySpriteHappyFeedback(stage, feedback, animation.animationId === "happy" ? "HAPPY" : "IDLE");
  applySpriteDraggingState(stage, animation.animationId === "drag");
  applySpriteSleepingState(stage, animation.animationId === "sleep" ? "REST" : "IDLE", animation.animationId);
  applyParachuteVisual(parachute, "NONE", 0);
  renderer.render({ sprite, under }, selected, false);
  applyHitbox({ animationId: animation.animationId, frameIndex: index, frame: selected, animationHitBox: animation.hitBox, timestampMs: clock.now() });
  element("frame-info").textContent = `${selected.logicalAssetKey}\n${selected.durationMs}ms · visualAnchor (${selected.visualAnchor.x}, ${selected.visualAnchor.y}) · contact ${selected.groundContact}\n展示朝向 ${facing}；原始图像 ${selected.url}`;
  message.textContent = "素材检查：时钟冻结，当前图像不是 Runtime 状态输出";
  refresh();
}
animationSelect.addEventListener("change", () => { frameIndex.value = "0"; inspectFrame(); });
frameIndex.addEventListener("input", inspectFrame);
facingSelect.addEventListener("change", inspectFrame);

function pointerPosition(event: PointerEvent): LogicalPoint {
  const rect = world.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
world.addEventListener("pointermove", event => {
  if (!busy && !inspection && !syntheticHeld) { setPointer(pointerPosition(event)); refresh(); }
});
world.addEventListener("pointerleave", () => {
  if (capturedPointer === undefined && !busy && !inspection && !syntheticHeld) setPointer(FAR_POINTER);
});
hitbox.addEventListener("pointerdown", event => {
  if (event.button !== 0 || busy || inspection || syntheticHeld || capturedPointer !== undefined || !gesture) return;
  event.preventDefault();
  setPointer(pointerPosition(event));
  hitbox.setPointerCapture(event.pointerId);
  capturedPointer = event.pointerId;
  void gesture.begin(event.pointerId).then(started => {
    if (!started && capturedPointer === event.pointerId) releaseCapture();
    refresh();
  });
});
function releaseCapture(): void {
  const id = capturedPointer;
  capturedPointer = undefined;
  if (id !== undefined && hitbox.hasPointerCapture(id)) hitbox.releasePointerCapture(id);
}
async function finishPointer(event: PointerEvent, outcome: PointerGestureEnd): Promise<void> {
  if (capturedPointer !== event.pointerId) return;
  releaseCapture();
  await gesture?.finish(event.pointerId, outcome);
  refresh();
}
hitbox.addEventListener("pointerup", event => { void finishPointer(event, "pointerup"); });
hitbox.addEventListener("pointercancel", event => { void finishPointer(event, "pointercancel"); });
hitbox.addEventListener("lostpointercapture", event => { void finishPointer(event, "lostpointercapture"); });
async function cancelGesture(): Promise<void> {
  runtime?.cancelPendingClickResponses(); bubbles?.respond(null);
  releaseCapture(); await gesture?.cancel(); syntheticHeld = false; refresh();
}
window.addEventListener("keydown", event => { if (event.key === "Escape") { seeking = false; void cancelGesture(); } });
window.addEventListener("blur", () => { running = false; seeking = false; void cancelGesture(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) { running = false; seeking = false; void cancelGesture(); } });
window.addEventListener("beforeunload", () => {
  generation++; runtime?.dispose(); bubbles?.dispose(); renderer.dispose(); motionPreference.dispose();
  motionMedia.removeEventListener("change", updateMotionPreference);
});

async function initialize(): Promise<void> {
  resources = await loadDefaultRuntimeResources(url => fetch(url));
  const response = await fetch("/character/home/home-manifest.json");
  if (!response.ok) throw new Error("Home manifest 加载失败");
  const home: unknown = await response.json();
  if (!home || typeof home !== "object" || !("imageLogicalKey" in home) || home.imageLogicalKey !== "home/home.png" ||
      !("landingSurface" in home) || !home.landingSurface || typeof home.landingSurface !== "object") {
    throw new Error("Home manifest 与当前夹具不匹配");
  }
  const landing = home.landingSurface as { leftX: number; rightX: number; y: number };
  if (![landing.leftX, landing.rightX, landing.y].every(Number.isFinite)) throw new Error("Home 支撑几何无效");
  Object.assign(element("support-line").style, {
    left: `${HOME.x + landing.leftX / 2}px`, top: `${HOME.y + landing.y / 2}px`, width: `${(landing.rightX - landing.leftX) / 2}px`,
  });
  const homeImage = document.querySelector<HTMLImageElement>(".home-surface__image")!;
  homeImage.src = `/character/${home.imageLogicalKey}`;
  await createBrowserImageLoader()(homeImage.src);
  animations = Object.values(resources).filter((value): value is RuntimeAnimation => "animationId" in value);
  for (const animation of animations) {
    const option = document.createElement("option");
    option.value = animation.animationId; option.textContent = `${animation.animationId} (${animation.frames.length})`;
    animationSelect.append(option);
  }
  await reset();
  frameIndex.disabled = false;
  animationSelect.disabled = false;
  message.textContent = "就绪。选择高低松手场景，再开始运行或步进；开伞后可再次抓取。所有窗口动作都是本页替身";
  refresh();
  let previous = performance.now();
  const pump = async (now: number): Promise<void> => {
    const delta = Math.min(50, Math.max(0, now - previous));
    previous = now;
    if (running && !busy && !inspection) {
      await action("受控时钟运行中", () => clock.advanceBy(delta * Number(element<HTMLSelectElement>("speed").value)));
    }
    requestAnimationFrame(next => { void pump(next); });
  };
  requestAnimationFrame(now => { void pump(now); });
}
void initialize().catch(error => {
  message.textContent = `夹具初始化失败：${error instanceof Error ? error.message : String(error)}`;
  console.error(error);
});
