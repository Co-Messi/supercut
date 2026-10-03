/**
 * Motion-quality regression suite: the measurable version of "the video
 * feels natural". Each scenario runs buildRenderPlan over an event log +
 * frame index and scores the plan with test/helpers/motion-metrics.ts:
 *
 *   - the camera is wide (z ≤ 1.05) at every scene marker and at the first
 *     frame of a new page after a navigation gap — never a zoomed stale page
 *   - each scene opens with ≥ 700ms of continuous wide rest (z ≤ 1.02)
 *   - a punch-in reaches ≥ 90% of its zoom by the click (or is skipped)
 *   - the take ends at rest: |Δz| < 1e-4 per frame over the final 300ms
 *   - < 5% of output frames blend two different source frames (every
 *     adjacent pair differs in these fixtures, so any blend is a ghost)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRenderPlan, type FrameIndexEntry } from "../src/render/plan.js";
import { parseEventLog, type EventLog } from "../src/schema/index.js";
import { motionMetrics, numberFrames, sourceFrames, type MotionMetrics } from "./helpers/motion-metrics.js";

const viewport = { width: 1920, height: 1080, dpr: 2 };

function score(log: EventLog, index: FrameIndexEntry[]): MotionMetrics {
  const m = motionMetrics(log, index, buildRenderPlan(log, index));
  console.log(`[motion] ${JSON.stringify(m)}`);
  return m;
}

/**
 * A synthetic multi-scene take at the ~39fps source cadence measured on a
 * real `generate` run: a click that NAVIGATES (source gap, no scene marker),
 * typing, a second scene whose marker precedes its reload gap, and a focused
 * payoff right before the end of the take.
 */
function syntheticTake(intervalMs: number): { log: EventLog; index: FrameIndexEntry[] } {
  const index = numberFrames([
    ...sourceFrames(0, 5300, intervalMs, 3),
    // click at 5200 navigates: no frames while the next page loads
    ...sourceFrames(5900, 8620, intervalMs, 5),
    // scene 2's reload: marker at 8600, frames resume at 9350
    ...sourceFrames(9350, 13500, intervalMs, 9),
  ]);
  const log: EventLog = {
    version: 0,
    t_source_unified: true,
    viewport,
    fps: 60,
    events: [
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 1500, type: "click", bbox: [100, 100, 120, 40], selector: "#a", point: [160, 120] },
      { t: 3000, type: "click", bbox: [600, 500, 300, 40], selector: "#email", point: [750, 520] },
      { t: 4300, type: "type", bbox: [600, 500, 300, 40], selector: "#email", textLen: 12 },
      {
        t: 5200, type: "click", bbox: [920, 500, 90, 40], selector: "#go", point: [965, 520],
        focus_bbox: [600, 480, 700, 200], focus_source: "llm",
      },
      { t: 7400, type: "click", bbox: [1500, 200, 120, 40], selector: "#b", point: [1560, 220] },
      { t: 8600, type: "scene", name: "s2", priority: 2 },
      { t: 10600, type: "click", bbox: [300, 700, 150, 40], selector: "#c", point: [375, 720] },
      {
        t: 12000, type: "hover", bbox: [48, 319, 1824, 56], selector: "#row",
        focus_bbox: [48, 319, 1824, 188], focus_source: "llm",
      },
      // a last small-target punch whose dwell runs to the end of the take
      { t: 12900, type: "click", bbox: [1200, 800, 100, 36], selector: "#d", point: [1250, 818] },
      {
        t: 0, type: "cursor_path",
        points: [[0, 960, 980], [1500, 160, 120], [3000, 750, 520], [5200, 965, 520], [7400, 1560, 220], [10600, 375, 720], [12000, 960, 347], [12900, 1250, 818]],
      },
    ],
  };
  return { log, index };
}

/** the real demo-recipe take recorded on main @ 013d6b8 (events + frame
 *  index only — the frames themselves are not needed to score the plan) */
function demoTake(): { log: EventLog; index: FrameIndexEntry[] } {
  const dir = join(import.meta.dirname, "fixtures", "takes", "demo-main");
  return {
    log: parseEventLog(JSON.parse(readFileSync(join(dir, "events.json"), "utf8"))),
    index: JSON.parse(readFileSync(join(dir, "frames-index.json"), "utf8")) as FrameIndexEntry[],
  };
}

/** small targets hugging every edge and corner of the viewport: the punch
 *  framing must keep the canvas covered instead of shoving the window off
 *  one edge with a slab of wallpaper on the other */
function edgeTake(): { log: EventLog; index: FrameIndexEntry[] } {
  const targets: [number, number][] = [
    [20, 20], [1800, 20], [20, 1030], [1800, 1030], [940, 20], [940, 1030], [20, 520], [1800, 520], [1500, 300],
  ];
  const events: EventLog["events"] = [{ t: 0, type: "scene", name: "edges", priority: 1 }];
  const path: [number, number, number][] = [[0, 960, 540]];
  targets.forEach(([x, y], i) => {
    const t = 1800 + i * 2600;
    events.push({ t, type: "click", bbox: [x, y, 100, 30], selector: `#t${i}`, point: [x + 50, y + 15] });
    path.push([t, x + 50, y + 15]);
  });
  events.push({ t: 0, type: "cursor_path", points: path });
  const end = 1800 + targets.length * 2600 + 1000;
  return {
    log: { version: 0, t_source_unified: true, viewport, fps: 60, events },
    index: numberFrames(sourceFrames(0, end, 16.7, 11)),
  };
}

/** the shape of the real gen2 take's first beat: a hover punch on a nav link,
 *  the click 370ms later, and the logged navigation 80ms after that with NO
 *  source gap (paint holding) — the camera snaps wide from a full punch */
function heldPunchNavTake(): { log: EventLog; index: FrameIndexEntry[] } {
  const events: EventLog["events"] = [
    { t: 1016.7, type: "scene", name: "s1", priority: 1 },
    { t: 1690.8, type: "hover", bbox: [1675.9, 27, 104.8, 18], selector: "#nav-dash" },
    { t: 2059.8, type: "click", bbox: [1675.9, 27, 104.8, 18], selector: "#nav-dash", point: [1728.3, 36] },
    { t: 2139.8, type: "navigation" },
    { t: 3400, type: "click", bbox: [600, 500, 120, 40], selector: "#x", point: [660, 520] },
    { t: 0, type: "cursor_path", points: [[0, 960, 980], [1690.8, 1728.3, 36], [3400, 660, 520]] },
  ];
  return {
    log: { version: 0, t_source_unified: true, viewport, fps: 60, events },
    index: numberFrames(sourceFrames(0, 6000, 16.7, 13)),
  };
}

type Check = "marker" | "navGap" | "wideRest" | "arrival" | "tail" | "blend" | "framing" | "snapBlur";

/**
 * Checks that still FAIL on the current code, per scenario. They run as
 * `it.fails` (green while the regression exists, red the moment it is fixed
 * without updating this table) — each fix commit removes its entries, so the
 * table shrinking to empty IS the before/after record.
 */
const PENDING: Record<string, Check[]> = {
  "synthetic multi-scene take @ ~39fps source": [],
  "synthetic multi-scene take @ ~60fps source": [],
  "real demo take (main @ 013d6b8)": [],
  "edge and corner targets": [],
  "punch held into a gapless click-navigation": [],
};

const scenarios: [string, () => { log: EventLog; index: FrameIndexEntry[] }][] = [
  ["synthetic multi-scene take @ ~39fps source", () => syntheticTake(25.6)],
  ["synthetic multi-scene take @ ~60fps source", () => syntheticTake(16.7)],
  ["real demo take (main @ 013d6b8)", demoTake],
  ["edge and corner targets", edgeTake],
  ["punch held into a gapless click-navigation", heldPunchNavTake],
];

describe.each(scenarios)("motion quality: %s", (name, make) => {
  const { log, index } = make();
  const check = (c: Check) => (PENDING[name]?.includes(c) ? it.fails : it);

  check("marker")("camera is wide at every scene marker", () => {
    expect(score(log, index).maxZAtSceneMarker).toBeLessThanOrEqual(1.05);
  });

  check("navGap")("camera is wide on the first frame of a new page after a navigation gap", () => {
    expect(score(log, index).maxZAfterNavGap).toBeLessThanOrEqual(1.05);
  });

  check("wideRest")("every scene opens with ≥ 700ms of continuous wide rest", () => {
    expect(score(log, index).minWideRestMs).toBeGreaterThanOrEqual(700);
  });

  check("arrival")("every punch-in reaches ≥ 90% of its zoom by the click (or is skipped)", () => {
    expect(score(log, index).minClickArrival).toBeGreaterThanOrEqual(0.9);
  });

  check("tail")("the take ends at rest: |Δz| < 1e-4 per frame over the final 300ms", () => {
    const m = score(log, index);
    expect(m.tailMaxDzPerFrame).toBeLessThan(1e-4);
    expect(m.finalZ).toBeLessThan(1.005);
  });

  check("framing")("zoomed shots keep the window framed: no one-sided wallpaper, covered once z·content ≥ canvas, focus centred as far as the edges allow", () => {
    const m = score(log, index);
    expect(m.maxOneSidedWallpaperPx).toBeLessThanOrEqual(0.5);
    expect(m.maxUncoveredWhileCoverablePx).toBeLessThanOrEqual(0.5);
    expect(m.maxFocusCentringErrorPx).toBeLessThanOrEqual(1);
  });

  check("snapBlur")("a camera snap at a page cut never motion-blurs one frame across the jump", () => {
    expect(score(log, index).maxIntraFrameDz).toBeLessThan(0.02);
  });

  check("blend")("< 5% of output frames blend two different source frames", () => {
    expect(score(log, index).blendedShare).toBeLessThan(0.05);
  });
});
