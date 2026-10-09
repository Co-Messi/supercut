import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "../src/render/index.js";
import type { EventLog } from "../src/schema/index.js";

/**
 * The recorder writes identical consecutive frames once and points every
 * repeated frames-index entry at that one file. The render plan must accept
 * repeated file names and keep one source per index entry, so floor-hold
 * timing is unchanged by the dedupe.
 */

const log: EventLog = {
  version: 0,
  t_source_unified: true,
  navigation_logged: true,
  failed_scenes: [],
  viewport: { width: 1920, height: 1080, dpr: 2 },
  fps: 60,
  events: [
    { t: 0, type: "scene", name: "s1", priority: 1 },
    { t: 1200, type: "click", bbox: [100, 100, 80, 30], selector: "#x", point: [140, 115] },
  ],
};

describe("a deduped frame index plans like the full one", () => {
  // 3s at 60fps: frames 0-89 are one picture, 90-179 another
  const deduped = Array.from({ length: 180 }, (_, i) => ({
    file: i < 90 ? "frames/000000.jpg" : "frames/000001.jpg",
    t_source: Math.round(i * 16.667 * 1000) / 1000,
  }));
  const full = deduped.map((e, i) => ({ ...e, file: `frames/${String(i).padStart(6, "0")}.jpg` }));

  it("accepts repeated file names and keeps one source entry per index entry", () => {
    const plan = buildRenderPlan(log, deduped);
    expect(plan.sourceFiles).toHaveLength(deduped.length);
    expect(plan.sourceFiles).toEqual(deduped.map((e) => e.file));
    for (let f = 0; f < plan.frames; f++) {
      expect(plan.sourceFiles[plan.sourceByFrame[f]!]).toBe(deduped[plan.sourceByFrame[f]!]!.file);
    }
  });

  it("produces the same timing and camera as the undeduped index", () => {
    const a = buildRenderPlan(log, deduped);
    const b = buildRenderPlan(log, full);
    expect(a.frames).toBe(b.frames);
    expect(Array.from(a.sourceByFrame)).toEqual(Array.from(b.sourceByFrame));
    expect(Array.from(a.camera)).toEqual(Array.from(b.camera));
  });
});
