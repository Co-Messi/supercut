import { describe, expect, it } from "vitest";
import { assessSkew } from "../src/render/index.js";
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

  it("camera establishes at z=1, zooms toward the click, and returns to overview", () => {
    const plan = buildRenderPlan(clickLog, frameIndex);
    const zAt = (frame: number) => plan.camera[(frame * SUBFRAMES) * 3]!;
    // establishing shot: wide through the take's opening (t=300ms ≈ frame 18)
    expect(zAt(10)).toBeCloseTo(1, 1);
    // still ~wide when the punch window opens (establish ends at 1200ms ≈ frame 72)
    expect(zAt(72)).toBeLessThan(1.1);
    // near full zoom once the punch has settled (t≈2100ms ≈ frame 126)
    expect(zAt(126)).toBeGreaterThan(1.4);
    // returned to overview by the end (dwell 1500 + settle)
    expect(zAt(plan.frames - 1)).toBeLessThan(1.08);
  });

  it("zoom focus lands near the click target, not canvas center", () => {
    const plan = buildRenderPlan(clickLog, frameIndex);
    const layout = defaultLayout(viewport);
    const s = layout.content.w / viewport.width;
    const expected = { x: layout.content.x + 700 * s, y: layout.content.y + 330 * s };
    const i = 126 * SUBFRAMES * 3; // punch settled (see camera test above)
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

describe("frame-the-result (4b): camera prefers focus_bbox", () => {
  // a type into a tiny input at the top-right that PRODUCES a large central
  // result region — the camera must hold on the result, not the input box.
  const focusLog = makeLog([
    { t: 1000, type: "scene", name: "s1", priority: 1 },
    {
      t: 1500,
      type: "type",
      bbox: [1740, 40, 160, 40], // the input, top-right corner
      focus_bbox: [360, 240, 1200, 700], // the result region, center → (960, 590)
      selector: "#q",
      textLen: 4,
    },
    { t: 0, type: "cursor_path", points: [[0, 960, 980], [1500, 1820, 60]] },
  ]);

  it("frames the result region center, not the interaction bbox", () => {
    const plan = buildRenderPlan(focusLog, frameIndex);
    const layout = defaultLayout(viewport);
    const s = layout.content.w / viewport.width;
    const i = 126 * SUBFRAMES * 3; // punch settled (~900ms after it opens at 1200ms)
    const cx = plan.camera[i + 1]!;
    const cy = plan.camera[i + 2]!;
    // near the result-region center (960, 590), far from the input center (1820, 60)
    expect(Math.abs(cx - (layout.content.x + 960 * s))).toBeLessThan(40);
    expect(Math.abs(cy - (layout.content.y + 590 * s))).toBeLessThan(40);
    expect(Math.abs(cx - (layout.content.x + 1820 * s))).toBeGreaterThan(200);
  });

  it("fit-zooms a large region so it fills the frame instead of cropping it", () => {
    const plan = buildRenderPlan(focusLog, frameIndex);
    const zAt = (frame: number) => plan.camera[(frame * SUBFRAMES) * 3]!;
    const z = zAt(95);
    // a 1200x700 region in 1920x1080 fits at ~1.36x — gentler than the fixed
    // 1.48 punch-in (proving the fit math), but still a real zoom (>1).
    expect(z).toBeGreaterThan(1.05);
    expect(z).toBeLessThan(1.48);
  });

  it("holds on the payoff longer than a plain interaction (FOCUS_DWELL)", () => {
    const longIndex = Array.from({ length: 600 }, (_, i) => ({
      file: `frames/${String(i).padStart(6, "0")}.png`,
      t_source: i * 16,
    }));
    const plan = buildRenderPlan(focusLog, longIndex);
    const zAt = (frame: number) => plan.camera[(frame * SUBFRAMES) * 3]!;
    // still zoomed ~3s after the event (focus dwell 4200ms > plain dwell 1500ms)
    // event t=1500ms ≈ frame 90; +3000ms ≈ frame 270
    expect(zAt(270)).toBeGreaterThan(1.05);
  });
});

describe("framing: establishing shots, size-aware zoom, spatial merging", () => {
  it("opens each scene wide: z≈1 during the second scene's establishing window", () => {
    const log = makeLog([
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 1500, type: "click", bbox: [600, 300, 200, 60], selector: "#a", point: [700, 330] },
      { t: 8000, type: "scene", name: "s2", priority: 2 },
      { t: 9500, type: "click", bbox: [600, 300, 200, 60], selector: "#b", point: [700, 330] },
    ]);
    const idx = Array.from({ length: 700 }, (_, i) => ({
      file: `frames/${String(i).padStart(6, "0")}.png`,
      t_source: i * 17,
    }));
    const plan = buildRenderPlan(log, idx);
    const zAt = (frame: number) => plan.camera[(frame * SUBFRAMES) * 3]!;
    // mid-take glide between the scenes sits above 1 (still engaged)…
    expect(zAt(Math.round(6000 / (1000 / 60)))).toBeGreaterThan(1.05);
    // …but the second scene OPENS wide: ~1s into its establishing shot
    expect(zAt(Math.round(8950 / (1000 / 60)))).toBeLessThan(1.06);
    // then punches back in for its click
    expect(zAt(Math.round(10600 / (1000 / 60)))).toBeGreaterThan(1.4);
  });

  it("never punches 1.48 into a full-width hero: plain-bbox zoom is size-aware", () => {
    const hero = makeLog([
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 1500, type: "click", bbox: [0, 100, 1920, 600], selector: "#hero", point: [960, 400] },
    ]);
    const plan = buildRenderPlan(hero, frameIndex);
    const zAt = (frame: number) => plan.camera[(frame * SUBFRAMES) * 3]!;
    // a viewport-wide target fits at z ≤ 1 → stays at overview
    for (let f = 0; f < plan.frames; f += 10) expect(zAt(f)).toBeLessThan(1.05);
  });

  it("mid-size targets get a fitted punch between 1 and the max", () => {
    const mid = makeLog([
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 1500, type: "click", bbox: [400, 300, 1200, 400], selector: "#panel", point: [960, 500] },
    ]);
    const plan = buildRenderPlan(mid, frameIndex);
    const zAt = (frame: number) => plan.camera[(frame * SUBFRAMES) * 3]!;
    const z = zAt(150); // settled well after the punch opens
    expect(z).toBeGreaterThan(1.2);
    expect(z).toBeLessThan(1.48);
  });

  it("merges only nearby beats: far-apart targets widen out between punches", () => {
    const idx = Array.from({ length: 600 }, (_, i) => ({
      file: `frames/${String(i).padStart(6, "0")}.png`,
      t_source: i * 17,
    }));
    const at = (bbox: [number, number, number, number], point: [number, number]) =>
      makeLog([
        { t: 0, type: "scene", name: "s1", priority: 1 },
        { t: 1500, type: "click", bbox: [50, 50, 100, 40], selector: "#a", point: [100, 70] },
        { t: 5500, type: "click", bbox, selector: "#b", point },
      ]);
    const near = buildRenderPlan(at([300, 200, 100, 40], [350, 220]), idx);
    const far = buildRenderPlan(at([1700, 900, 100, 40], [1750, 920]), idx);
    const zAt = (plan: typeof near, frame: number) => plan.camera[(frame * SUBFRAMES) * 3]!;
    // midpoint of the gap between the two punches (~4000ms ≈ frame 240)
    const zNear = zAt(near, 240);
    const zFar = zAt(far, 240);
    expect(zNear).toBeGreaterThan(1.35); // bridged: camera stays punched-in
    expect(zFar).toBeLessThan(1.25); // far: camera widens between beats
  });

  it("a long focus dwell overlapping a later far beat never drags the camera back", () => {
    // focus beat top-left at t=2000 (FOCUS_DWELL 4200 → would run to 6200)
    // overlaps a far plain click at t=4000 (dwell ends 5500): after beat 2's
    // dwell, the camera must settle out — not re-punch across the page to
    // beat 1's stale target
    const log = makeLog([
      { t: 0, type: "scene", name: "s1", priority: 1 },
      {
        t: 2000, type: "click", bbox: [60, 60, 120, 40], selector: "#a", point: [120, 80],
        focus_bbox: [40, 40, 400, 300],
      },
      { t: 4000, type: "click", bbox: [1700, 900, 120, 40], selector: "#b", point: [1760, 920] },
    ]);
    const idx = Array.from({ length: 600 }, (_, i) => ({
      file: `frames/${String(i).padStart(6, "0")}.png`,
      t_source: i * 17,
    }));
    const plan = buildRenderPlan(log, idx);
    const layout = defaultLayout(viewport);
    const s = layout.content.w / viewport.width;
    const beat1X = layout.content.x + 240 * s; // beat 1 focus center (css 240)
    const camAt = (tMs: number) => {
      const f = Math.round(tMs / (1000 / 60));
      const i = f * SUBFRAMES * 3;
      return { z: plan.camera[i]!, fx: plan.camera[i + 1]! };
    };
    // during beat 2 the camera is on beat 2's side of the page
    expect(camAt(5200).fx).toBeGreaterThan(layout.canvasW / 2);
    // after beat 2's dwell: it settles (z falls) and NEVER pans back to beat 1
    for (let t = 5600; t <= 9000; t += 200) {
      expect(Math.abs(camAt(t).fx - beat1X)).toBeGreaterThan(200);
    }
    expect(camAt(9000).z).toBeLessThan(1.1); // settling wide, not re-punched
  });
});

describe("source cross-blend: nav crossfades + gap smoothing", () => {
  // 60fps source with a 1000ms capture hole between 2000 and 3000
  const gapIndex = [
    ...Array.from({ length: 121 }, (_, i) => ({
      file: `frames/${String(i).padStart(6, "0")}.png`,
      t_source: Math.round(i * (2000 / 120)),
    })),
    ...Array.from({ length: 60 }, (_, i) => ({
      file: `frames/${String(121 + i).padStart(6, "0")}.png`,
      t_source: 3000 + Math.round(i * (2000 / 120)),
    })),
  ];
  const frameMs = 1000 / 60;
  const blendAt = (plan: ReturnType<typeof buildRenderPlan>, tMs: number) => {
    const f = Math.round(tMs / frameMs);
    return { srcB: plan.blend[f * 2]!, k: plan.blend[f * 2 + 1]! };
  };

  it("linearly blends across a short residual (non-nav) source gap", () => {
    // 60fps source with a 400ms capture hole between 2000 and 2400
    const shortGapIndex = [
      ...Array.from({ length: 121 }, (_, i) => ({
        file: `frames/${String(i).padStart(6, "0")}.png`,
        t_source: Math.round(i * (2000 / 120)),
      })),
      ...Array.from({ length: 60 }, (_, i) => ({
        file: `frames/${String(121 + i).padStart(6, "0")}.png`,
        t_source: 2400 + Math.round(i * (2000 / 120)),
      })),
    ];
    const log = makeLog([
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 500, type: "click", bbox: [600, 300, 200, 60], selector: "#a", point: [700, 330] },
    ]);
    const plan = buildRenderPlan(log, shortGapIndex);
    // inside the gap: blends toward the NEXT source by temporal position
    expect(blendAt(plan, 2100).srcB).toBe(121);
    expect(blendAt(plan, 2100).k).toBeCloseTo(0.25, 1);
    expect(blendAt(plan, 2300).k).toBeCloseTo(0.75, 1);
    // outside the gap: no blend
    expect(blendAt(plan, 1000).srcB).toBe(-1);
    expect(blendAt(plan, 3000).srcB).toBe(-1);
  });

  it("a LONG residual gap holds then fades late — never a seconds-long linear dissolve", () => {
    // no scene marker near the gap: e.g. slow pre-nav DNS work pushed the real
    // reload gap outside naive attribution — it must still read as a quick fade
    const log = makeLog([
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 500, type: "click", bbox: [600, 300, 200, 60], selector: "#a", point: [700, 330] },
    ]);
    const plan = buildRenderPlan(log, gapIndex);
    // early/mid gap: HOLD, no mush
    expect(blendAt(plan, 2200).srcB).toBe(-1);
    expect(blendAt(plan, 2500).srcB).toBe(-1);
    // final ~350ms: quick dissolve
    expect(blendAt(plan, 2800).srcB).toBe(121);
    expect(blendAt(plan, 2800).k).toBeCloseTo((2800 - 2650) / 350, 1);
  });

  it("dense 60fps capture (~17ms spacing) never blends", () => {
    const log = makeLog([{ t: 0, type: "scene", name: "s1", priority: 1 }]);
    const dense = Array.from({ length: 200 }, (_, i) => ({
      file: `frames/${String(i).padStart(6, "0")}.png`,
      t_source: Math.round(i * 16.7),
    }));
    const plan = buildRenderPlan(log, dense);
    for (let f = 0; f < plan.frames; f++) expect(plan.blend[f * 2]).toBe(-1);
  });

  it("a nav gap holds the last pre-nav frame, then crossfades ~350ms into the new page", () => {
    const log = makeLog([
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 500, type: "click", bbox: [600, 300, 200, 60], selector: "#a", point: [700, 330] },
      { t: 1990, type: "scene", name: "s2", priority: 2 }, // right before the gap → it's a navigation
    ]);
    const plan = buildRenderPlan(log, gapIndex);
    // early in the gap: HOLD (no dissolve mush while the page reloads)
    expect(blendAt(plan, 2200).srcB).toBe(-1);
    expect(blendAt(plan, 2500).srcB).toBe(-1);
    // final 350ms: crossfade ramps into the first post-nav frame
    expect(blendAt(plan, 2800).srcB).toBe(121);
    expect(blendAt(plan, 2800).k).toBeCloseTo((2800 - 2650) / 350, 1);
    expect(blendAt(plan, 2980).k).toBeGreaterThan(0.9);
  });
});

describe("plan input bounds (PR #1 review)", () => {
  it("throws on a corrupt huge timestamp instead of allocating the moon", () => {
    const evil = makeLog([
      { t: 99_999_999, type: "scene", name: "x", priority: 1 },
    ]);
    expect(() => buildRenderPlan(evil, frameIndex)).toThrow(/cap/);
  });

  it("throws on a non-monotonic frame index", () => {
    const bad = [
      { file: "frames/000000.png", t_source: 0 },
      { file: "frames/000001.png", t_source: 500 },
      { file: "frames/000002.png", t_source: 100 },
    ];
    expect(() => buildRenderPlan(clickLog, bad)).toThrow(/monotonic/);
  });

  it("throws on malformed frame-index entries", () => {
    const bad = [{ file: "", t_source: 0 }];
    expect(() => buildRenderPlan(clickLog, bad)).toThrow(/malformed/);
  });

  it("accepts a clamped index (capture clamps jittered stamps to t_source 0)", () => {
    // CDP delivery jitter can stamp a frame before the first-processed one;
    // the executor clamps those to 0, so duplicates at 0 are a legal index
    const clamped = [
      { file: "frames/000000.png", t_source: 0 },
      { file: "frames/000001.png", t_source: 0 },
      ...frameIndex.slice(1).map((e, i) => ({ file: `frames/${String(i + 2).padStart(6, "0")}.png`, t_source: e.t_source })),
    ];
    expect(() => buildRenderPlan(clickLog, clamped)).not.toThrow();
  });

  it("skew gate: dense (beacon-era) takes fail hard past 250ms", () => {
    // 60fps source — clearly a unified-clock take
    const dense = Array.from({ length: 300 }, (_, i) => ({
      file: `frames/${String(i).padStart(6, "0")}.png`,
      t_source: Math.round(i * 16.7),
    }));
    const lastFrameT = dense[dense.length - 1]!.t_source;
    const ok = makeLog([{ t: lastFrameT + 200, type: "scene", name: "s", priority: 1 }]);
    expect(assessSkew(ok, dense).action).toBe("ok");
    const broken = makeLog([{ t: lastFrameT + 400, type: "scene", name: "s", priority: 1 }]);
    expect(assessSkew(broken, dense).action).toBe("fail");
  });

  it("skew gate: legacy sparse takes (pre-unified clock) only warn — back-compat", () => {
    // ~5fps change-driven capture: events routinely outrun the footage
    const sparse = Array.from({ length: 25 }, (_, i) => ({
      file: `frames/${String(i).padStart(6, "0")}.png`,
      t_source: i * 200,
    }));
    const lastFrameT = sparse[sparse.length - 1]!.t_source;
    const skewed = makeLog([{ t: lastFrameT + 3000, type: "scene", name: "s", priority: 1 }]);
    const verdict = assessSkew(skewed, sparse);
    expect(verdict.action).toBe("warn"); // renderable, never fatal
    expect(verdict.skewMs).toBe(3000);
    const mild = makeLog([{ t: lastFrameT + 400, type: "scene", name: "s", priority: 1 }]);
    expect(assessSkew(mild, sparse).action).toBe("ok"); // old 500ms threshold
  });

  it("merges multiple cursor_path events in time order", () => {
    const twoPaths = makeLog([
      { t: 500, type: "cursor_path", points: [[600, 500, 500], [900, 700, 700]] },
      { t: 0, type: "cursor_path", points: [[0, 100, 100], [400, 400, 400]] },
    ]);
    const plan = buildRenderPlan(twoPaths, frameIndex);
    // frame at t≈500ms must sit between the two segments' positions (~500-700 css px mapped)
    const x30 = plan.cursor[30 * 3]!;
    const x50 = plan.cursor[50 * 3]!;
    expect(x50).toBeGreaterThan(x30); // continues along the merged, sorted track
  });
});
