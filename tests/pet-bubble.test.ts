import { describe, expect, it } from "vitest";
import { INTERACTION_BUBBLES, PetBubbleController } from "../src/pet-bubble";
import type { PetInteractionResponse } from "../src/pet-runtime";
import type { TimelineClock } from "../src/animation-timeline";

class Clock implements TimelineClock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(id: unknown) { this.timers.delete(id as number); }
  advance(ms: number) {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

const kinds = Object.keys(INTERACTION_BUBBLES) as PetInteractionResponse["kind"][];
const actions: Record<PetInteractionResponse["kind"], PetInteractionResponse["action"]> = {
  hello: "look", walk: "look", home: "home", wake: "wake", playful: "happy", gentle: "still", settled: "look", cooldown: "still",
};
const response = (id: number, kind: PetInteractionResponse["kind"] = "hello"): PetInteractionResponse =>
  ({ id, kind, action: actions[kind], durationMs: 1_600 });

function setup(random: () => number = () => 0) {
  const clock = new Clock();
  const shown: string[] = [];
  let text = "";
  const bubble = new PetBubbleController(value => { text = value; if (value) shown.push(value); }, clock, random);
  return { clock, shown, bubble, text: () => text };
}

describe("accepted local interaction copy", () => {
  it("contains four distinct short lines for each semantic response", () => {
    expect(kinds).toHaveLength(8);
    const copy = Object.values(INTERACTION_BUBBLES).flat();
    expect(copy).toHaveLength(32);
    expect(new Set(copy).size).toBe(32);
    for (const pool of Object.values(INTERACTION_BUBBLES)) {
      expect(pool).toHaveLength(4);
      expect(pool.every(text => [...text].length <= 8)).toBe(true);
    }
  });

  it.each(kinds)("only selects %s copy and never repeats the previous line", kind => {
    let random = 0;
    const test = setup(() => random);
    for (let id = 1; id <= 32; id++) {
      random = [0, 0, 1, 0.5][id % 4];
      test.bubble.respond(response(id, kind));
      expect(INTERACTION_BUBBLES[kind]).toContain(test.text());
      if (id > 1) expect(test.shown[id - 1]).not.toBe(test.shown[id - 2]);
      test.clock.advance(5_000);
    }
    test.bubble.dispose();
  });

  it("displays every accepted response without adding a second cooldown", () => {
    const test = setup();
    test.bubble.respond(response(1));
    test.clock.advance(5_000);
    test.bubble.respond(response(2, "walk"));
    expect(test.shown).toEqual([INTERACTION_BUBBLES.hello[0], INTERACTION_BUBBLES.walk[0]]);
    test.bubble.respond(response(3, "playful"));
    expect(test.text()).toBe(INTERACTION_BUBBLES.playful[0]);
    test.bubble.dispose();
  });

  it("keeps copy for three seconds independently of the action duration", () => {
    const test = setup();
    test.bubble.respond(response(1));
    test.clock.advance(2_999);
    expect(test.text()).toBe(INTERACTION_BUBBLES.hello[0]);
    test.clock.advance(1);
    expect(test.text()).toBe("");
    test.bubble.dispose();
  });

  it("ignores duplicate and older ids without extending the display or replaying after null", () => {
    const test = setup();
    test.bubble.respond(response(2));
    test.clock.advance(2_000);
    test.bubble.respond(response(2));
    test.bubble.respond(response(1, "playful"));
    expect(test.shown).toHaveLength(1);
    test.clock.advance(1_000);
    expect(test.text()).toBe("");
    test.bubble.respond(response(3, "wake"));
    test.bubble.respond(null);
    test.bubble.respond(response(3, "wake"));
    expect(test.text()).toBe("");
    test.bubble.dispose();
  });

  it("hides on drag and discards responses received during movement", () => {
    const test = setup();
    test.bubble.respond(response(1));
    test.bubble.update(false, true);
    expect(test.text()).toBe("");
    test.bubble.respond(response(2, "playful"));
    test.bubble.update(true, false);
    test.bubble.respond(response(2, "playful"));
    expect(test.text()).toBe("");
    test.bubble.respond(response(3));
    expect(test.text()).not.toBe("");
    test.bubble.dispose();
  });

  it("shows a closing line once and cannot replay it after interruption or disabled delivery", () => {
    const test = setup();
    test.bubble.respond(response(1, "playful"));
    test.clock.advance(2_200);
    test.bubble.respond(response(2, "cooldown"));
    expect(test.text()).toBe("先歇一会儿");
    test.clock.advance(2_000);
    test.bubble.respond(response(2, "cooldown"));
    test.clock.advance(1_000);
    expect(test.text()).toBe("");
    test.bubble.respond(response(3, "cooldown"));
    test.bubble.respond(null);
    test.bubble.respond(response(3, "cooldown"));
    expect(test.text()).toBe("");
    test.bubble.setEnabled(false);
    test.bubble.respond(response(4, "cooldown"));
    test.bubble.setEnabled(true);
    test.bubble.respond(response(4, "cooldown"));
    expect(test.text()).toBe("");
    test.bubble.dispose();
  });

  it("disabling consumes responses without mutating them and enabling never replays one", () => {
    const test = setup();
    test.bubble.respond(response(1));
    test.bubble.setEnabled(false);
    const accepted = Object.freeze(response(2, "home"));
    expect(() => test.bubble.respond(accepted)).not.toThrow();
    expect(test.text()).toBe("");
    expect(test.clock.timers.size).toBe(0);
    test.bubble.setEnabled(true);
    test.bubble.respond(accepted);
    expect(test.text()).toBe("");
    test.bubble.respond(response(3, "home"));
    expect(test.text()).toBe(INTERACTION_BUBBLES.home[0]);
    test.bubble.dispose();
  });

  it("a stale hide callback cannot clear a newer response or control message", () => {
    const test = setup();
    test.bubble.respond(response(1));
    const oldHide = [...test.clock.timers.values()].find(timer => timer.at === 3_000)!.callback;
    test.clock.advance(1_000);
    test.bubble.respond(response(2, "wake"));
    oldHide();
    expect(test.text()).toBe(INTERACTION_BUBBLES.wake[0]);
    test.bubble.control(true);
    oldHide();
    expect(test.text()).toBe("我安静一会");
    test.clock.advance(2_999);
    expect(test.text()).toBe("我安静一会");
    test.clock.advance(1);
    expect(test.text()).toBe("");
    test.bubble.dispose();
  });

  it("stale idle callbacks cannot replace interaction copy or revive a disposed controller", () => {
    const test = setup();
    test.bubble.update(true, false);
    const oldIdle = [...test.clock.timers.values()][0].callback;
    test.clock.advance(299_000);
    test.bubble.respond(response(1));
    test.clock.advance(1_000);
    oldIdle();
    expect(test.text()).toBe(INTERACTION_BUBBLES.hello[0]);
    const pending = [...test.clock.timers.values()].map(timer => timer.callback);
    test.bubble.dispose();
    pending.forEach(callback => callback());
    oldIdle();
    expect(test.text()).toBe("");
    expect(test.clock.timers.size).toBe(0);
  });

  it("a reentrant disable during render leaves no display or idle timer", () => {
    const clock = new Clock();
    let text = "";
    let bubble!: PetBubbleController;
    bubble = new PetBubbleController(value => {
      text = value;
      if (value) bubble.setEnabled(false);
    }, clock);
    bubble.respond(response(1));
    expect(text).toBe("");
    expect(clock.timers.size).toBe(0);
    bubble.dispose();
  });

  it("a reentrant replacement owns the only hide timer", () => {
    const clock = new Clock();
    let text = "";
    let bubble!: PetBubbleController;
    bubble = new PetBubbleController(value => {
      text = value;
      if (value === INTERACTION_BUBBLES.hello[0]) bubble.respond(response(2, "home"));
    }, clock, () => 0);
    bubble.respond(response(1));
    expect(text).toBe(INTERACTION_BUBBLES.home[0]);
    expect(clock.timers.size).toBe(2);
    clock.advance(3_000);
    expect(text).toBe("");
    bubble.dispose();
  });

  it("retains the five-minute idle opportunity and rare subsequent prompts", () => {
    const test = setup();
    test.bubble.update(true, false);
    test.clock.advance(300_000);
    expect(test.text()).toBe("我在这里呀");
    test.clock.advance(480_000);
    expect(test.text()).toBe("伸个懒腰吧");
    test.bubble.respond(response(1, "gentle"));
    test.clock.advance(299_999);
    expect(test.text()).toBe("");
    test.clock.advance(1);
    expect(test.text()).toBe("我在这里呀");
    test.bubble.dispose();
  });
});

it("holds the existing caption for acknowledged cooldown clicks without rerendering or changing copy", () => {
  const h = setup();
  h.bubble.respond(response(1));
  const initial = h.text();
  const stale = [...h.clock.timers.values()].map(timer => timer.callback);
  for (let i = 0; i < 50; i++) {
    h.clock.advance(200); h.bubble.acknowledgeClick();
    expect(h.text()).toBe(initial);
  }
  expect(h.shown).toHaveLength(1);
  expect(h.clock.timers.size).toBeLessThanOrEqual(2);
  stale.forEach(callback => callback());
  expect(h.text()).toBe(initial);
  h.clock.advance(3001);
  expect(h.text()).toBe("");
  h.bubble.dispose();
});

it("shows a stationary acknowledgement after copy expires but no new action is accepted", () => {
  const h = setup();
  h.bubble.respond(response(1)); h.clock.advance(3001);
  expect(h.text()).toBe("");
  h.bubble.acknowledgeClick();
  expect(INTERACTION_BUBBLES.gentle).toContain(h.text());
  h.bubble.dispose();
});

it("does not resurrect acknowledged captions after disabling, movement, or disposal", () => {
  const h = setup();
  h.bubble.setEnabled(false); h.bubble.acknowledgeClick(); expect(h.text()).toBe("");
  h.bubble.setEnabled(true); h.bubble.update(false, true); h.bubble.acknowledgeClick(); expect(h.text()).toBe("");
  h.bubble.update(true, false); h.bubble.acknowledgeClick(); expect(h.text()).not.toBe("");
  const callbacks = [...h.clock.timers.values()].map(timer => timer.callback);
  h.bubble.dispose(); h.bubble.acknowledgeClick(); callbacks.forEach(callback => callback());
  expect(h.text()).toBe("");
});
