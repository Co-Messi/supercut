import { describe, expect, it } from "vitest";
import { cursorPath, fittsMs, makeRng } from "../src/capture/cursor.js";

describe("seeded cursor paths", () => {
  const base = {
    from: { x: 100, y: 100 },
    to: { x: 900, y: 500 },
    targetWidth: 120,
    maxDurationMs: 800,
  };

  it("same seed → byte-identical path (determinism backbone)", () => {
    const a = cursorPath({ ...base, rng: makeRng(42) });
    const b = cursorPath({ ...base, rng: makeRng(42) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("different seed → different path", () => {
    const a = cursorPath({ ...base, rng: makeRng(1) });
    const b = cursorPath({ ...base, rng: makeRng(2) });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("starts at from and ends exactly on target", () => {
    const p = cursorPath({ ...base, rng: makeRng(7) });
    expect(p[0]).toMatchObject({ x: 100, y: 100, t: 0 });
    const last = p[p.length - 1]!;
    expect(last.x).toBeCloseTo(900, 6);
    expect(last.y).toBeCloseTo(500, 6);
  });

  it("timestamps are monotonic and within the slot", () => {
    const p = cursorPath({ ...base, rng: makeRng(7) });
    for (let i = 1; i < p.length; i++) expect(p[i]!.t).toBeGreaterThanOrEqual(p[i - 1]!.t);
    expect(p[p.length - 1]!.t).toBeLessThanOrEqual(base.maxDurationMs);
  });

  it("zero-distance travel collapses to a single point", () => {
    const p = cursorPath({ ...base, to: { x: 100, y: 100 }, rng: makeRng(7) });
    expect(p).toHaveLength(1);
  });

  it("fitts time grows with distance, shrinks with target size", () => {
    expect(fittsMs(1000, 50)).toBeGreaterThan(fittsMs(100, 50));
    expect(fittsMs(500, 20)).toBeGreaterThan(fittsMs(500, 200));
  });
});
