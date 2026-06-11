import { describe, expect, it } from "vitest";
import { buildRenderPlan, defaultLayout, SUBFRAMES } from "../src/render/plan.js";
import type { EventLog } from "../src/schema/index.js";

const viewport = { width: 1920, height: 1080, dpr: 2 };

function makeLog(events: EventLog["events"]): EventLog {
  return { version: 0, viewport, fps: 60, events };
}

const frameIndex = Array.from({ length: 100 }, (_, i) => ({
  file: `frames/${String(i).padStart(6, "0")}.png`,
  t_source: i * 33, // ~30fps source (damage-driven capture is irregular)
}));

const clickLog = makeLog([
  { t: 1000, type: "scene", name: "s1", priority: 1 },
  { t: 1500, type: "click", bbox: [600, 300, 200, 60], selector: "#cta", point: [700, 330] },
  {
    t: 0,
    type: "cursor_path",
    points: [
      [0, 960, 980],
      [1500, 700, 330],
    ],
  },
]);

describe("buildRenderPlan", () => {
  it("is deterministic: same inputs → identical plan", () => {
    const a = buildRenderPlan(clickLog, frameIndex);
    const b = buildRenderPlan(clickLog, frameIndex);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("maps output frames to source frames by nearest-hold", () => {
    const plan = buildRenderPlan(clickLog, frameIndex);
    // output frame at t=0 → source 0; t=100ms (frame 6) → source with t_source ≤ 100 → idx 3 (99ms)
    expect(plan.sourceByFrame[0]).toBe(0);
    expect(plan.sourceByFrame[6]).toBe(3);
    // never points past the last captured frame
    expect(Math.max(...plan.sourceByFrame)).toBeLessThanOrEqual(frameIndex.length - 1);
  });

  it("camera idles at z=1, zooms toward the click, and returns to overview", () => {
    const plan = buildRenderPlan(clickLog, frameIndex);
    const zAt = (frame: number) => plan.camera[(frame * SUBFRAMES) * 3]!;
    // idle well before the event (lead is 600ms; t=300ms ≈ frame 18)
    expect(zAt(10)).toBeCloseTo(1, 1);
    // near full zoom at the click moment (t=1500ms ≈ frame 90)
    expect(zAt(95)).toBeGreaterThan(1.4);
    // returned to overview by the end (dwell 1500 + settle)
    expect(zAt(plan.frames - 1)).toBeLessThan(1.08);
  });

  it("zoom focus lands near the click target, not canvas center", () => {
    const plan = buildRenderPlan(clickLog, frameIndex);
    const layout = defaultLayout(viewport);
    const s = layout.content.w / viewport.width;
    const expected = { x: layout.content.x + 700 * s, y: layout.content.y + 330 * s };
    const i = 95 * SUBFRAMES * 3;
    expect(Math.abs(plan.camera[i + 1]! - expected.x)).toBeLessThan(30);
    expect(Math.abs(plan.camera[i + 2]! - expected.y)).toBeLessThan(30);
  });

  it("interpolates the cursor between path points and pulses on click", () => {
    const plan = buildRenderPlan(clickLog, frameIndex);
    const layout = defaultLayout(viewport);
    const s = layout.content.w / viewport.width;
    // halfway through the move (t=750ms ≈ frame 45): between start and target
    const midX = plan.cursor[45 * 3]!;
    const startX = layout.content.x + 960 * s;
    const endX = layout.content.x + 700 * s;
    expect(midX).toBeLessThan(startX);
    expect(midX).toBeGreaterThan(endX);
    // pulse fires right after the click (t=1517ms ≈ frame 91) and decays
    // (window: 1500..1850ms; frame 112 = 1867ms is the first fully past it)
    expect(plan.cursor[91 * 3 + 2]!).toBeGreaterThan(0.8);
    expect(plan.cursor[112 * 3 + 2]!).toBe(0);
  });

  it("covers the full take: frames extend past the last event dwell", () => {
    const plan = buildRenderPlan(clickLog, frameIndex);
    // click at 1500 + dwell 1500 + tail 600 = 3600ms → ≥ 216 frames
    expect(plan.frames).toBeGreaterThanOrEqual(216);
  });

  it("rejects an empty frame index loudly", () => {
    expect(() => buildRenderPlan(clickLog, [])).toThrow(/empty frame index/);
  });
});
