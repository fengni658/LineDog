import { systemTimelineClock, type TimelineClock } from "./animation-timeline";
import type { PetInteractionResponse } from "./pet-runtime";

/** Copy is selected only after Runtime has accepted the matching action. */
export const INTERACTION_BUBBLES = {
  hello: ["嗯，叫我呀", "我在呢", "看见你啦", "陪着你呀"],
  walk: ["停步看看你", "散步遇见你", "陪你待会儿", "歇脚陪陪你"],
  home: ["窝里真舒服", "一起歇会儿", "这里刚刚好", "陪你窝一会"],
  wake: ["嗯，我醒啦", "醒来见到你", "睡醒啦", "睁眼就见你"],
  playful: ["好呀一起玩", "摸摸真开心", "好开心呀", "嘿嘿喜欢你"],
  gentle: ["安静陪着你", "先歇一小会", "慢慢来呀", "乖乖待会儿"],
  settled: ["站稳啦", "平安落地啦", "脚踏实地啦", "落地见到你"],
  cooldown: ["先歇一会儿", "慢慢陪你玩", "歇会再玩呀", "让我缓口气"],
} as const satisfies Record<PetInteractionResponse["kind"], readonly string[]>;

/** @deprecated Only for older consumers; production uses respond(). */
export const CLICK_BUBBLES = ["摸摸头", "见到你真好", "陪着你呀"] as const;
export const IDLE_BUBBLES = ["我在这里呀", "伸个懒腰吧", "休息一下吧"] as const;
const IDLE_SETTLE_MS = 3_000;
const DEFAULT_DISPLAY_MS = 3_000;

/** Local presentation only: no model calls, pet transitions or persistent storage. */
export class PetBubbleController {
  enabled = true;
  private eligible = false;
  private moving = false;
  private disposed = false;
  private hideTimer?: unknown;
  private idleTimer?: unknown;
  private displayRevision = 0;
  private idleRevision = 0;
  private lastResponseId = -Infinity;
  private lastClick = -Infinity;
  private lastText = "";
  private idleShowing = false;
  private showing = false;
  private eligibleSince = Infinity;

  constructor(private readonly render: (text: string) => void,
    private readonly clock: TimelineClock = systemTimelineClock,
    private readonly random: () => number = Math.random) {
    this.scheduleIdle(300_000);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.clearIdle();
    this.hide();
    if (enabled && !this.disposed) this.scheduleIdle(300_000);
  }

  activity(): void {
    this.clearIdle();
    if (this.enabled && !this.disposed) this.scheduleIdle(300_000);
  }

  update(eligible: boolean, moving: boolean): void {
    if (this.disposed) return;
    this.moving = moving;
    const safeEligible = eligible && !moving;
    const changed = this.eligible !== safeEligible;
    this.eligible = safeEligible;
    if (changed) this.eligibleSince = safeEligible ? this.clock.now() : Infinity;
    if (moving || (!safeEligible && this.idleShowing)) this.hide();
    // Autonomous motion changes presentation eligibility, not user inactivity.
    // No prompt is queued for replay when eligibility returns.
  }

  respond(response: PetInteractionResponse | null): void {
    if (this.disposed) return;
    if (response === null) {
      this.hide();
      return;
    }
    // Runtime ids are monotonic. Consume even a disabled/unsafe response so a
    // later rerender cannot replay it after enabling bubbles or ending a drag.
    if (!Number.isSafeInteger(response.id) || response.id <= this.lastResponseId) return;
    this.lastResponseId = response.id;
    this.activity();
    if (!this.enabled || this.moving) return;
    // durationMs describes the action, which can finish before its copy.
    this.show(this.pick(INTERACTION_BUBBLES[response.kind]), false);
  }

  /** Valid clicks keep readable feedback, independently of the action cooldown. */
  acknowledgeClick(): void {
    this.activity();
    if (this.disposed || !this.enabled || this.moving) return;
    if (!this.showing || this.idleShowing) {
      this.show(this.pick(INTERACTION_BUBBLES.gentle), false);
      return;
    }
    // Keep both text and layout unchanged. Only extend this one hide deadline.
    if (this.hideTimer !== undefined) this.clock.clearTimeout(this.hideTimer);
    const revision = ++this.displayRevision;
    this.hideTimer = this.clock.setTimeout(() => {
      if (revision !== this.displayRevision) return;
      this.hideTimer = undefined;
      this.hide();
    }, DEFAULT_DISPLAY_MS);
  }

  /** @deprecated Compatibility for older callers, never used by the V1.3.5 wiring. */
  click(): void {
    this.activity();
    if (this.clock.now() - this.lastClick < 15_000 || !this.enabled || this.disposed || this.moving) return;
    this.lastClick = this.clock.now();
    this.show(this.pick(CLICK_BUBBLES), false);
  }

  control(paused: boolean): void {
    this.activity();
    this.show(paused ? "我安静一会" : "继续散步啦", false);
  }

  dispose(): void {
    this.disposed = true;
    this.clearIdle();
    this.hide();
  }

  private randomUnit(): number {
    const value = this.random();
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  private pick(texts: readonly string[]): string {
    const choices = texts.filter(text => text !== this.lastText);
    return choices[Math.min(choices.length - 1, Math.floor(this.randomUnit() * choices.length))];
  }

  private show(text: string, idle: boolean, durationMs = DEFAULT_DISPLAY_MS): void {
    if (!this.enabled || this.disposed || this.moving) return;
    if (this.hideTimer !== undefined) this.clock.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    const revision = ++this.displayRevision;
    this.lastText = text;
    this.idleShowing = idle;
    this.showing = true;
    this.render(text);
    // A render consumer can synchronously disable, interrupt or replace this
    // presentation. It must not acquire an orphan timer after that change.
    if (revision !== this.displayRevision) return;
    this.hideTimer = this.clock.setTimeout(() => {
      if (revision !== this.displayRevision) return;
      this.hideTimer = undefined;
      this.hide();
    }, durationMs);
  }

  private hide(): void {
    this.displayRevision++;
    if (this.hideTimer !== undefined) this.clock.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    this.idleShowing = false;
    this.showing = false;
    this.render("");
  }

  private clearIdle(): void {
    this.idleRevision++;
    if (this.idleTimer !== undefined) this.clock.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdle(delay: number): void {
    this.clearIdle();
    const revision = this.idleRevision;
    this.idleTimer = this.clock.setTimeout(() => {
      if (revision !== this.idleRevision) return;
      this.idleTimer = undefined;
      if (!this.enabled || this.disposed) return;
      // Drop an unsafe opportunity, including one immediately after movement
      // or pointer interaction. A fresh opportunity is sampled independently.
      if (this.eligible && this.clock.now() - this.eligibleSince >= IDLE_SETTLE_MS) {
        this.show(this.pick(IDLE_BUBBLES), true);
      }
      if (revision === this.idleRevision) this.scheduleIdle(this.nextIdleDelay());
    }, delay);
  }

  private nextIdleDelay(): number {
    return 480_000 + this.randomUnit() * 240_000;
  }
}
