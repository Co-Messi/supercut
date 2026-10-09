import { describe, expect, it } from "vitest";
import { makeRng, typingPlan } from "../src/capture/cursor.js";

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

describe("typingPlan: human keystroke timing", () => {
  const text = "ada@lumon.dev, weekly digest please";

  it("is deterministic for a seed", () => {
    expect(typingPlan(text, 5000, makeRng(9))).toEqual(typingPlan(text, 5000, makeRng(9)));
  });

  it("averages ~100ms per key with real variation — not a metronome", () => {
    const p = typingPlan(text, 60_000, makeRng(1));
    expect(p.keyDelays).toHaveLength([...text].length - 1);
    expect(mean(p.keyDelays)).toBeGreaterThan(85);
    expect(mean(p.keyDelays)).toBeLessThan(135);
    expect(sd(p.keyDelays)).toBeGreaterThan(15);
  });

  it("never types faster than ~45ms per key", () => {
    for (let seed = 1; seed < 30; seed++) {
      const p = typingPlan(text, 800, makeRng(seed)); // a slot far too short
      expect(Math.min(...p.keyDelays)).toBeGreaterThanOrEqual(45);
      // a short slot never collapses into a paste: the mean stays human
      expect(mean(p.keyDelays)).toBeGreaterThanOrEqual(55);
    }
  });

  it("pauses longer after spaces and punctuation", () => {
    const chars = [...text];
    const after: number[] = [];
    const other: number[] = [];
    for (let seed = 1; seed < 20; seed++) {
      const p = typingPlan(text, 60_000, makeRng(seed));
      p.keyDelays.forEach((d, i) => {
        // keyDelays[i] is the gap after character i
        (/[\s.,@!?;:]/.test(chars[i]!) ? after : other).push(d);
      });
    }
    expect(mean(after)).toBeGreaterThan(mean(other) * 1.4);
  });

  it("pauses 250-400ms before the first key and ~300ms before Enter", () => {
    for (let seed = 1; seed < 30; seed++) {
      const p = typingPlan(text, 5000, makeRng(seed));
      expect(p.beforeFirstKey).toBeGreaterThanOrEqual(250);
      expect(p.beforeFirstKey).toBeLessThanOrEqual(400);
      expect(p.beforeEnter).toBeGreaterThanOrEqual(250);
      expect(p.beforeEnter).toBeLessThanOrEqual(350);
    }
  });
});
