/**
 * Motion-quality regression suite: the measurable version of "the video
 * feels natural". Each scenario runs buildRenderPlan over an event log +
 * frame index and scores the plan with test/helpers/motion-metrics.ts:
 *
 *   - the camera is wide (z ≤ 1.05) at every scene marker and at the first
 *     frame of a new page after a navigation gap — never a zoomed stale page
 *   - each scene opens with ≥ 700ms of continuous wide rest (z ≤ 1.02)
 *   - a punch-in reaches ≥ 90% of its zoom by its click, type or hover (or
 *     is skipped), and never starts rising only after the event
 *   - the on-screen pan stays under 48px per frame outside cuts
 *   - the take ends at rest: |Δz| < 1e-4 per frame over the final 300ms
 *
 * Plan-level only: pixels are checked by test/render-pixels.e2e.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRenderPlan, type FrameIndexEntry } from "../src/render/plan.js";
import { parseEventLog, type EventLog } from "../src/schema/index.js";
import { motionMetrics, navGaps, numberFrames, sourceFrames, type MotionMetrics } from "./helpers/motion-metrics.js";

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

/** a recorded take's events + frame index (the frames themselves are not
 *  needed to score the plan) */
function recordedTake(name: string): { log: EventLog; index: FrameIndexEntry[] } {
  const dir = join(import.meta.dirname, "fixtures", "takes", name);
  return {
    log: parseEventLog(JSON.parse(readFileSync(join(dir, "events.json"), "utf8"))),
    index: JSON.parse(readFileSync(join(dir, "frames-index.json"), "utf8")) as FrameIndexEntry[],
  };
}

/** a heavy app on a navigation-logged take: the click that runs the query
 *  blocks the main thread for 600ms (no frames: the screencast follows rAF),
 *  then a nav link navigates and its load leaves a 400ms gap. Only the
 *  logged navigation is a page change; the stall must keep the payoff punch. */
function stallTake(): { log: EventLog; index: FrameIndexEntry[] } {
  const index = numberFrames([
    ...sourceFrames(0, 3000, 16.7, 21),
    ...sourceFrames(3600, 6400, 16.7, 22),
    ...sourceFrames(6800, 10000, 16.7, 23),
  ]);
  const log: EventLog = {
    version: 0,
    t_source_unified: true,
    navigation_logged: true,
    viewport,
    fps: 60,
    events: [
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 1600, type: "hover", bbox: [880, 500, 120, 40], selector: "#run" },
      {
        t: 3000, type: "click", bbox: [880, 500, 120, 40], selector: "#run", point: [940, 520],
        focus_bbox: [400, 300, 1100, 500], focus_source: "llm",
      },
      { t: 6200, type: "click", bbox: [1600, 40, 120, 30], selector: "#nav", point: [1660, 55] },
      { t: 6350, type: "navigation" },
      { t: 8400, type: "click", bbox: [300, 700, 150, 40], selector: "#c", point: [375, 720] },
      { t: 0, type: "cursor_path", points: [[0, 960, 980], [1600, 940, 520], [6200, 1660, 55], [8400, 375, 720]] },
    ],
  };
  return { log, index };
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

const scenarios: [string, () => { log: EventLog; index: FrameIndexEntry[] }][] = [
  ["synthetic multi-scene take @ ~39fps source", () => syntheticTake(25.6)],
  ["synthetic multi-scene take @ ~60fps source", () => syntheticTake(16.7)],
  // PNG frames, ~53fps, no pre-roll: the pre-JPEG recorder (main @ 013d6b8)
  ["recorded demo take, PNG capture path", () => recordedTake("demo-main")],
  // the bundled demo recipe recorded through the JPEG capture path on a 120Hz
  // display (1027 frames over 10.7s, a 425ms scene-entry reload gap, the
  // 1s pre-roll); t_source rounded to the microsecond to keep it small
  ["recorded demo take, JPEG capture path", () => recordedTake("demo-jpeg")],
  ["edge and corner targets", edgeTake],
  ["punch held into a gapless click-navigation", heldPunchNavTake],
  ["same-page stall after a focused click (navigation-logged take)", stallTake],
];

describe.each(scenarios)("motion quality: %s", (_name, make) => {
  const { log, index } = make();
  let memo: MotionMetrics | undefined;
  const m = () => (memo ??= score(log, index));

  it("camera is wide at every scene marker", () => {
    expect(m().maxZAtSceneMarker).toBeLessThanOrEqual(1.05);
  });

  it("camera is wide on the first frame of a new page after a navigation gap", () => {
    expect(m().maxZAfterNavGap).toBeLessThanOrEqual(1.05);
  });

  it("every scene opens with ≥ 700ms of continuous wide rest", () => {
    expect(m().minWideRestMs).toBeGreaterThanOrEqual(700);
  });

  it("every punch-in reaches ≥ 90% of its zoom by its click, type or hover (or is skipped)", () => {
    expect(m().minClickArrival).toBeGreaterThanOrEqual(0.9);
    expect(m().minTypeArrival).toBeGreaterThanOrEqual(0.9);
    expect(m().minHoverArrival).toBeGreaterThanOrEqual(0.9);
  });

  it("no punch starts at or after its event (the camera never chases the action)", () => {
    expect(m().maxLateRise).toBeLessThan(0.035);
  });

  it("the camera never whip-pans: under 48px of on-screen pan per frame outside cuts", () => {
    // ordinary beats peak at 10 to 15px; the widest move the planner makes
    // (a punch across the page from the far corner, edge scenario) peaks near
    // 40px. A stiffer spring, or a snap leaking into the pan, breaks this.
    expect(m().maxPanPxPerFrame).toBeLessThan(48);
  });

  it("the take ends at rest: |Δz| < 1e-4 per frame over the final 300ms", () => {
    expect(m().tailMaxDzPerFrame).toBeLessThan(1e-4);
    expect(m().finalZ).toBeLessThan(1.005);
  });

  it("zoomed shots keep the window framed: no one-sided wallpaper, covered once z·content ≥ canvas, focus centred as far as the edges allow", () => {
    expect(m().maxOneSidedWallpaperPx).toBeLessThanOrEqual(0.5);
    expect(m().maxUncoveredWhileCoverablePx).toBeLessThanOrEqual(0.5);
    expect(m().maxFocusCentringErrorPx).toBeLessThanOrEqual(1);
  });

  it("a camera snap at a page cut never motion-blurs one frame across the jump", () => {
    expect(m().maxIntraFrameDz).toBeLessThan(0.02);
  });
});

describe("the stall scenario frames its payoff", () => {
  it("the focused click's punch survives the 600ms stall", () => {
    const { log, index } = stallTake();
    const metrics = score(log, index);
    // the hover arrives, then the payoff click: both punched and arrived
    expect(metrics.hoverArrival).toHaveLength(1);
    expect(metrics.hoverArrival[0]).not.toBeNull();
    expect(metrics.clickArrival[0]).not.toBeNull();
    expect(metrics.clickArrival[0]!).toBeGreaterThanOrEqual(0.9);
  });

  it("the grader agrees: on a navigation-logged take the stall is not a page change", () => {
    const { log, index } = stallTake();
    expect(navGaps(index, log).map((g) => Math.round(g.tA / 100) * 100)).toEqual([6400]);
    // the same frames on a legacy take: the long stall reads as a page change
    expect(navGaps(index, { ...log, navigation_logged: undefined }).length).toBe(2);
  });

  it("an SPA route change that reveals the framed result is no page change: the payoff punch arrives and holds", () => {
    // a list item opens its detail route 60ms after the click, and the new
    // route takes 300ms to render (a gap right at the route change)
    const index = numberFrames([...sourceFrames(0, 3060, 16.7, 41), ...sourceFrames(3360, 7000, 16.7, 42)]);
    const log: EventLog = {
      version: 0, t_source_unified: true, navigation_logged: true, viewport, fps: 60,
      events: [
        { t: 0, type: "scene", name: "s1", priority: 1 },
        {
          t: 3000, type: "click", bbox: [100, 300, 200, 40], selector: "#item-2", point: [200, 320],
          focus_bbox: [700, 200, 600, 500], focus_source: "llm",
        },
        { t: 3060, type: "navigation", kind: "spa" },
      ],
    };
    const metrics = score(log, index);
    expect(navGaps(index, log)).toEqual([]);
    expect(metrics.clickArrival[0]).not.toBeNull();
    expect(metrics.clickArrival[0]!).toBeGreaterThanOrEqual(0.9);
    // the grader reads the route change as the planner does (not a page
    // change), so the punch framing through it is not a stale-page zoom
    expect(metrics.maxZAfterNavGap).toBeLessThanOrEqual(1.05);
    expect(metrics.maxPanPxPerFrame).toBeLessThan(48);
    expect(metrics.maxLateRise).toBeLessThan(0.035);
  });

  it("the grader anchors gaps only to scene markers after the first (as the planner does)", () => {
    // a 300ms hiccup 1s into the take: the opening marker is the take head,
    // not a page change, so this gap is no navigation
    const idx = numberFrames([...sourceFrames(0, 1000, 16.7, 31), ...sourceFrames(1300, 5000, 16.7, 32)]);
    const log: EventLog = {
      version: 0, t_source_unified: true, viewport, fps: 60,
      events: [{ t: 500, type: "scene", name: "s1", priority: 1 }],
    };
    expect(navGaps(idx, log)).toEqual([]);
  });
});
