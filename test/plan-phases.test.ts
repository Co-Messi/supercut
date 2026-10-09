import { describe, expect, it } from "vitest";
import {
  boundaryBetween,
  bridgeSegments,
  defaultLayout,
  detectBoundaries,
  endLimit,
  ESTABLISH_MS,
  floorHoldSources,
  openingOf,
  planPunches,
  planTake,
  sourceGaps,
  takeDurationMs,
  ZOOM_OUT_MS,
  type Boundary,
  type CameraSegment,
} from "../src/render/plan.js";
import type { EventLog } from "../src/schema/index.js";
import { frames, makeLog, VIEWPORT } from "./helpers/takes.js";

/** frames every 20ms over [0, end], with no frames strictly inside (from, to) */
const withGap = (from: number, to: number, end: number) =>
  Array.from({ length: Math.ceil(end / 20) }, (_, i) => i * 20)
    .filter((t) => t <= from || t >= to)
    .map((t, i) => ({ file: `frames/${String(i).padStart(6, "0")}.jpg`, t_source: t }));

const layout = defaultLayout(VIEWPORT);
const scene = (t: number, name: string): EventLog["events"][number] => ({ t, type: "scene", name, priority: 1 });
const click = (t: number, extra: Partial<{ focus_bbox: [number, number, number, number] }> = {}): EventLog["events"][number] => ({
  t, type: "click", bbox: [600, 300, 120, 40], selector: `#c${t}`, point: [660, 320], ...extra,
});

describe("phase 1: page boundaries", () => {
  it("finds only gaps of at least NAV_GAP_MS", () => {
    expect(sourceGaps(withGap(1000, 1200, 3000))).toEqual([]);
    expect(sourceGaps(withGap(1000, 1300, 3000))).toEqual([{ tA: 1000, tB: 1300 }]);
  });

  it("labels every boundary with the evidence it came from", () => {
    const log = makeLog([
      scene(0, "a"),
      scene(2000, "b"), // reloads: gap 2100 to 2500
      scene(5000, "c"), // same URL, no gap
      { t: 9500, type: "navigation" }, // gapless commit
      { t: 11000, type: "navigation" }, // its load left a gap 11100 to 11400
    ]);
    const gapAt = (from: number, to: number) => (f: { t_source: number }) => f.t_source <= from || f.t_source >= to;
    const idx = withGap(2100, 2500, 15000).filter(gapAt(11100, 11400));
    // plus an unexplained 600ms gap at 13000: a legacy take reads it as a cut
    const stallIdx = idx.filter(gapAt(13000, 13600));
    const sources = (b: Boundary[]) => b.map((x) => `${x.source}@${x.at}`);
    expect(sources(detectBoundaries(log, stallIdx))).toEqual([
      "scene-reload@2000",
      "scene-same-url@5000",
      "navigation@9500",
      "navigation-gap@11100",
      "inferred-gap@13000",
    ]);
    // a navigation-logged take: the same gap is a same-page stall, no boundary
    expect(sources(detectBoundaries({ ...log, navigation_logged: true }, stallIdx))).toEqual([
      "scene-reload@2000",
      "scene-same-url@5000",
      "navigation@9500",
      "navigation-gap@11100",
    ]);
  });

  it("a reload boundary must be wide before the marker or the frozen frame, whichever comes first", () => {
    const [b] = detectBoundaries(makeLog([scene(0, "a"), scene(2000, "b")]), withGap(1800, 2400, 5000));
    expect(b).toMatchObject({ out: 1800 - ZOOM_OUT_MS, snap: true, source: "scene-reload" });
    expect(b!.in).toBeGreaterThanOrEqual(2400);
  });

  it("boundary queries: opening, separation", () => {
    const bs: Boundary[] = [
      { out: 1000, in: 1000, snap: true, source: "navigation", at: 1000 },
      { out: 2200, in: 3000, snap: true, source: "scene-reload", at: 3000 },
    ];
    expect(openingOf(bs, 500)).toBe(0);
    expect(openingOf(bs, 1000)).toBe(1000);
    expect(openingOf(bs, 2999)).toBe(1000);
    expect(openingOf(bs, 3500)).toBe(3000);
    expect(boundaryBetween(bs, 1100, 2900)).toBe(false);
    expect(boundaryBetween(bs, 1100, 3000)).toBe(true);
    expect(endLimit(bs, 1500)).toBe(2200);
    expect(endLimit(bs, 3500)).toBe(Infinity);
  });

  it("endLimit honours the earliest required zoom-out, not the earliest new page", () => {
    // a gapless navigation at 1500 and a same-URL scene marker at 2000 whose
    // zoom-out must be complete by 1200: sorted by `in`, the navigation comes
    // first, but a shot starting at 1000 must still be wide by 1200
    const bs: Boundary[] = [
      { out: 1500, in: 1500, snap: true, source: "navigation", at: 1500 },
      { out: 1200, in: 2000, snap: false, source: "scene-same-url", at: 2000 },
    ];
    expect(endLimit(bs, 1000)).toBe(1200);
    expect(endLimit(bs, 1600)).toBe(1200);
    expect(endLimit(bs, 2000)).toBe(Infinity);
  });
});

describe("phase 2: beats and punches", () => {
  it("reports each beat as framed or skipped with a reason", () => {
    const log = makeLog([
      scene(0, "a"),
      click(400), // inside the take-head establishing shot: cannot arrive
      { t: 2000, type: "click", bbox: [0, 0, 1920, 1080], selector: "#hero", point: [960, 540] }, // fills the viewport
      click(4000),
      click(6000), // the page changes 100ms later
      { t: 6100, type: "navigation" },
    ]);
    const boundaries = detectBoundaries(log, frames(500, 17));
    const { beats, segments } = planPunches(log, layout, boundaries);
    expect(beats.map((b) => [b.t, b.framed, b.reason])).toEqual([
      [400, false, "page-just-opened"],
      [2000, false, "fills-viewport"],
      [4000, true, undefined],
      [6000, false, "page-changes-after"],
    ]);
    // establishing shots at the take head and at the navigation, plus one punch
    expect(segments.filter((s) => s.z === 1).map((s) => s.start)).toEqual([0, 6100]);
    expect(segments.filter((s) => s.z > 1)).toHaveLength(1);
    expect(beats[2]).toMatchObject({ target: "interaction", z: expect.any(Number), start: 3250, end: 5200 });
  });

  it("a beat that names its result region frames it as the target", () => {
    const log = makeLog([scene(0, "a"), click(3000, { focus_bbox: [400, 300, 1100, 500] })]);
    const { beats } = planPunches(log, layout, []);
    expect(beats[0]).toMatchObject({ target: "result", framed: true, start: 2250, end: 5400 });
  });
});

describe("degenerate focus boxes", () => {
  // a zero-area or sliver focus_bbox (a bad QC/LLM zoom patch) fit-zooms to
  // the maximum punch into one corner. It names no result region: the beat
  // frames its control instead, with the plain dwell.
  for (const box of [
    [0, 0, 0.001, 0.001],
    [1800, 1000, 4, 300],
    [10, 10, 600, 2],
  ] as [number, number, number, number][]) {
    it(`ignores focus_bbox ${JSON.stringify(box)}`, () => {
      const log = makeLog([scene(0, "a"), click(3000, { focus_bbox: box })]);
      const plain = makeLog([scene(0, "a"), click(3000)]);
      const { beats, segments } = planPunches(log, layout, []);
      const ref = planPunches(plain, layout, []);
      expect(beats[0]).toMatchObject({ target: "interaction", framed: true, end: 3000 + 1200 });
      expect(segments).toEqual(ref.segments);
      // the take is not stretched for a 2400ms payoff that is never framed
      expect(takeDurationMs(log, frames(100, 20), segments)).toBe(takeDurationMs(plain, frames(100, 20), ref.segments));
      expect(takeDurationMs(log, frames(100, 20), [])).toBe(3000 + 1200 + 1000);
    });
  }

  it("keeps a small but real result region", () => {
    const log = makeLog([scene(0, "a"), click(3000, { focus_bbox: [900, 500, 40, 24] })]);
    expect(planPunches(log, layout, []).beats[0]).toMatchObject({ target: "result", end: 3000 + 2400 });
  });
});

describe("phase 3: bridging", () => {
  it("never bridges across a page change", () => {
    const segs: CameraSegment[] = [
      { start: 1000, end: 2000, z: 1.4, fx: 900, fy: 500 },
      { start: 3000, end: 4000, z: 1.4, fx: 920, fy: 500 },
    ];
    const bs: Boundary[] = [{ out: 2500, in: 2500, snap: true, source: "navigation", at: 2500 }];
    const across = segs.map((s) => ({ ...s }));
    bridgeSegments(across, bs, layout);
    expect(across[0]!.end).toBe(2000);
    const same = segs.map((s) => ({ ...s }));
    bridgeSegments(same, [], layout);
    expect(same[0]!.end).toBe(3000);
  });
});

describe("phase 4: duration", () => {
  it("runs past the last punch until the zoom-out settles, and past the last frame", () => {
    const log = makeLog([scene(0, "a")]);
    expect(takeDurationMs(log, frames(100, 20), [])).toBe(1980 + 1000);
    const punch: CameraSegment = { start: 1000, end: 4000, z: 1.4, fx: 0, fy: 0 };
    expect(takeDurationMs(log, frames(100, 20), [punch])).toBe(4000 + 1700);
  });
});

describe("phase 5: floor-hold source mapping", () => {
  it("holds the last frame at or before each output time", () => {
    const idx = [
      { file: "frames/0.jpg", t_source: 0 },
      { file: "frames/1.jpg", t_source: 40 },
      { file: "frames/2.jpg", t_source: 41 },
    ];
    expect(floorHoldSources(idx, 4, 1000 / 60)).toEqual([0, 0, 0, 2]);
  });
});

describe("planTake diagnostics", () => {
  it("returns the plan with its boundaries, beats and duration", () => {
    const log = makeLog([scene(0, "a"), click(2000), scene(5000, "b")], { navigation_logged: true });
    const { plan, diagnostics } = planTake(log, withGap(5000, 5400, 8000));
    expect(diagnostics.navigationLogged).toBe(true);
    expect(diagnostics.boundaries.map((b) => b.source)).toEqual(["scene-reload"]);
    expect(diagnostics.beats.filter((b) => b.framed)).toHaveLength(1);
    expect(diagnostics.durationMs).toBeCloseTo((plan.frames * 1000) / plan.fps, 6);
    expect(ESTABLISH_MS).toBeGreaterThan(0);
  });
});
