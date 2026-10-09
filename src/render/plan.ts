/**
 * Render plan — stage 5's brain, computed in tested TS before any pixel work.
 *
 *   events.json + frames-index.json
 *        │
 *        ▼
 *   ┌─ buildRenderPlan ───────────────────────────────────────────┐
 *   │ duration → output frame count (60fps grid)                   │
 *   │ source mapping: output frame → captured frame (floor hold)   │
 *   │ camera: spring-integrated zoom/focus, 8 subframes per frame  │
 *   │ cursor: interpolated track + click pulses (canvas coords)    │
 *   └──────────────────────────────────────────────────────────────┘
 *        │
 *        ▼
 *   render-plan.json ──▶ host page (dumb executor: draw + encode)
 *
 * Everything here is pure and deterministic: same inputs → same plan, so the
 * compositor's output is CI-checkable (SSIM on pre-encode frames later).
 */
import type { EventLog } from "../schema/index.js";
import { makeRng } from "../capture/cursor.js";

export const SUBFRAMES = 8;

export interface FrameIndexEntry {
  file: string;
  t_source: number;
}

export interface Layout {
  canvasW: number;
  canvasH: number;
  content: { x: number; y: number; w: number; h: number };
  cornerRadius: number;
  viewport: { width: number; height: number; dpr: number };
}

/** One soft color cloud of the procedural mesh background. */
export interface MeshBlob {
  color: string; // "r,g,b"
  cx: number;
  cy: number;
  r: number;
  phase: number;
  amp: number; // drift amplitude px
}

export interface BackgroundStyle {
  kind: "mesh" | "image";
  /** base fill behind the blobs (mesh) / behind the image while loading */
  base: string;
  blobs: MeshBlob[];
  /** light backgrounds get a soft vignette; dark ones a stronger one + key light */
  light: boolean;
  vignette: number;
}

/**
 * Curated palettes. "aurora" is the default — the soft blurred
 * pastel-mesh look of modern launch videos. Apple wallpapers cannot be
 * bundled (copyright); users get the
 * same vibe via --bg <their own image>.
 */
export const PALETTES: Record<string, { base: string; light: boolean; colors: string[] }> = {
  aurora: {
    base: "#f4ecf1",
    light: true,
    colors: ["244,164,201", "188,166,242", "247,205,168", "166,224,200", "228,168,238"],
  },
  midnight: {
    base: "#10131f",
    light: false,
    colors: ["38,52,110", "72,48,120", "24,70,110", "50,40,96", "30,58,92"],
  },
  dusk: {
    base: "#1d1426",
    light: false,
    colors: ["120,52,110", "180,86,60", "70,46,130", "150,60,90", "100,70,150"],
  },
  paper: {
    base: "#f2f0ea",
    light: true,
    colors: ["228,222,208", "214,220,228", "232,226,214", "218,212,226", "226,230,220"],
  },
};

export function buildBackground(palette: string, canvasW: number, canvasH: number): BackgroundStyle {
  const p = PALETTES[palette];
  if (!p) {
    throw new Error(
      `unknown background palette "${palette}" (have: ${Object.keys(PALETTES).join(", ")}, or pass an image file)`,
    );
  }
  // seeded from palette name → deterministic layout per palette
  let seed = 0;
  for (const ch of palette) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rng = makeRng(seed || 1);

  const anchors: [number, number][] = [
    [0.18, 0.22], [0.78, 0.16], [0.5, 0.62], [0.12, 0.82], [0.88, 0.78],
  ];
  const blobs: MeshBlob[] = p.colors.map((color, i) => {
    const [ax, ay] = anchors[i % anchors.length]!;
    return {
      color,
      cx: (ax + (rng() - 0.5) * 0.12) * canvasW,
      cy: (ay + (rng() - 0.5) * 0.12) * canvasH,
      r: (0.55 + rng() * 0.35) * canvasH,
      phase: rng() * Math.PI * 2,
      amp: 30 + rng() * 35,
    };
  });

  return {
    kind: "mesh",
    base: p.base,
    blobs,
    light: p.light,
    vignette: p.light ? 0.12 : 0.3,
  };
}

export interface RenderPlan {
  fps: number;
  frames: number;
  layout: Layout;
  background: BackgroundStyle;
  /** picture fade from / to black over the first / last N output frames
   *  (matches the music bed's afade in/out) */
  fade: { inFrames: number; outFrames: number };
  /** output frame → index into frameIndex (floor-hold: the last captured
   *  frame at or before the output time is held — not the temporally nearest) */
  sourceByFrame: number[];
  /** flattened [srcB, k] per output frame: a second source index and its
   *  blend weight. The planner never blends (srcB = -1, k = 0 everywhere,
   *  see noSourceBlend); the host page contract still carries the field. */
  blend: number[];
  /** flattened [z, fx, fy] per subframe: frames × SUBFRAMES × 3 (canvas coords) */
  camera: number[];
  /** flattened [x, y, pulse] per output frame (canvas coords; pulse 0..1) */
  cursor: number[];
  sourceFiles: string[];
}

/** a camera target held over [start, end]: z = 1 for an establishing shot,
 *  z > 1 for a punch-in on (fx, fy) in canvas coords */
export interface CameraSegment {
  start: number;
  end: number;
  z: number;
  fx: number;
  fy: number;
}

/** MAXIMUM punch-in, reached only for small widgets — a plain bbox is inflated
 *  to a context region and fit-zoomed, so large targets zoom far less */
export const ZOOM_TARGET = 1.42;
/** camera starts moving this long before the click lands: the critically
 *  damped spring covers ~95% of a punch in 750ms, so the zoom has ARRIVED
 *  when the click happens instead of chasing it */
export const ZOOM_LEAD_MS = 750;
/** time for the spring to cover 90% of a punch (ωt ≈ 3.9 at OMEGA 6.5). A
 *  punch that cannot start this long before its event is skipped: a zoom
 *  landing after the click reads as the camera lagging the action. */
export const ARRIVE_MS = 600;
export const ZOOM_DWELL_MS = 1200; // stays on target after the event
/** a punch whose hold after the event would be shorter than this (the page
 *  navigates right after the click) is skipped — an in-out pump, not a shot */
export const MIN_HOLD_AFTER_EVENT_MS = 300;
/** each scene opens wide: this long at z=1 from the first frame of the new
 *  page, so the viewer reads the whole page before the first punch-in
 *  (Screen-Studio establishing shot) */
export const ESTABLISH_MS = 800;
/** a plain interaction bbox is inflated to at least this fraction of the
 *  viewport before fit-zooming — the framed shot always keeps page context,
 *  and a full-width hero gets no punch at all */
const MIN_CONTEXT_FRAC = 0.55;
/** bridge nearby punch-ins only when their targets are NEAR: beyond this
 *  fraction of the content diagonal the camera widens between beats instead
 *  of dragging a tight crop across the page */
const MERGE_DIST_FRAC = 0.5;
/** a framed RESULT (focus_bbox) is the payoff — hold on it longer than a plain
 *  interaction so the viewer reads the graph/results before the camera moves */
export const FOCUS_DWELL_MS = 2400;
/** a result region should FILL the frame, not be punched-into and cropped:
 *  fit it to this fraction of the viewport (the rest is breathing room) */
const FOCUS_FILL = 0.88;
/** segments closer than this bridge into ONE held zoom — the camera glides
 *  between targets instead of pumping out/in per click. */
const MERGE_GAP_MS = 3400;
/** between two punches of the SAME page (too far apart to merge) the camera
 *  relaxes to this gentle floor instead of snapping all the way back to z=1.
 *  Never across a page change: the next page is a different picture, so the
 *  camera is fully wide before it. */
export const GLIDE_Z = 1.1;
/** a source gap at least this long is a page change (navigation / reload):
 *  capture drops frames while the next document loads, and ordinary capture
 *  jitter at ~60fps never comes close */
export const NAV_GAP_MS = 250;
/** a gap NOT explained by a scene marker or a logged navigation must be this
 *  long to count as a page change: action-triggered navigations are logged,
 *  and an ordinary capture hiccup on a loaded machine (up to ~400ms) must
 *  never snap the camera while the same page is still showing */
export const UNATTRIBUTED_GAP_MS = 500;
/** a navigation gap starting within this window around a scene marker is
 *  that scene's entry navigation (the marker is emitted before the goto; on
 *  real networks policy DNS checks run between them) */
export const MARKER_GAP_BEFORE_MS = 1000;
export const MARKER_GAP_AFTER_MS = 4000;
/** a logged navigation whose reload also left a source gap starting in this
 *  window is already covered by that gap's boundary */
export const NAV_EVENT_GAP_BEFORE_MS = 200;
export const NAV_EVENT_GAP_AFTER_MS = 1500;
/** zoom-out lead before a scene change: from a full punch the spring reaches
 *  z ≤ 1.02 in ~710ms, so the camera is wide when the page changes */
export const ZOOM_OUT_MS = 800;
/** minimum picture after the last event's dwell */
export const TAIL_MS = 1000;
/** the take runs at least this long past the last punch's end, so the
 *  spring's zoom-out has fully settled (|Δz| < 1e-4/frame) before the end —
 *  never finishing mid-move */
export const SETTLE_TAIL_MS = 1700;
/** picture fade from / to black — the SAME lengths as the music bed's afade
 *  in/out (musicFilterChain), so picture and sound open and close together */
export const FADE_IN_MS = 600;
export const FADE_OUT_MS = 1800;
const PULSE_MS = 350;
/** critically damped spring: settles in about 4/OMEGA seconds. 6.5 is a calm,
 *  stately glide; a stiffer spring reads as restless */
const OMEGA = 6.5;

/** what told the planner the page changed (reported in render-report.json) */
export type BoundarySource =
  /** a later scene's entry navigation, which left a frame gap */
  | "scene-reload"
  /** a later scene on the same URL that did not reload: no cut, the camera
   *  zooms out before the marker */
  | "scene-same-url"
  /** a logged navigation with no frame gap: the cut is its commit time */
  | "navigation"
  /** a logged navigation whose load left a frame gap: the gap is the cut */
  | "navigation-gap"
  /** a legacy take's long unexplained frame gap, read as a page change */
  | "inferred-gap";

/** a page change: the camera must be wide by `out` (zoom-out complete) and
 *  the new page's first frame appears at `in`. `snap` marks a real cut in
 *  the picture, so the camera state resets to wide with it. `at` is the time
 *  of the evidence (scene marker, navigation event or gap start). */
export interface Boundary {
  out: number;
  in: number;
  snap: boolean;
  source: BoundarySource;
  at: number;
}

export function defaultLayout(viewport: EventLog["viewport"]): Layout {
  const canvasW = 1920;
  const canvasH = 1080;
  const scale = 0.8;
  const w = Math.round(canvasW * scale);
  const h = Math.round((w / viewport.width) * viewport.height);
  return {
    canvasW,
    canvasH,
    content: { x: Math.round((canvasW - w) / 2), y: Math.round((canvasH - h) / 2) - 8, w, h },
    cornerRadius: 22,
    viewport,
  };
}

/**
 * The compositor's camera transform: canvas point p → z·p + [offX, offY] for
 * the spring state (z, focus fx/fy) over a W×H canvas whose content window is
 * `c`. Returns [z, offX, offY]. The host page embeds THIS function verbatim
 * (via toString — keep the body flat: no nested functions or outer
 * constants), so the plan-level framing tests score exactly what is drawn.
 *
 * Per axis:
 *  - the shot wants the focus at the canvas centre (offset size/2 − z·focus);
 *  - the offset is clamped to the window's legal range: while z·content is
 *    smaller than the canvas the window stays fully on canvas, and once it is
 *    larger the window covers the canvas — never wallpaper on one edge while
 *    the opposite edge overflows (an unclamped offset shows hundreds of px of
 *    wallpaper on one side when the focus sits near an edge);
 *  - that range is narrowed toward the plain scale-about-centre offset by a
 *    ramp g = 0 at z=1 → 1 where the content starts to cover the canvas, so a
 *    wide shot is exactly centred whatever the focus spring is doing, and a
 *    gentle in-between zoom (z≈1.1 glide) only nudges the window instead of
 *    jamming it against an edge.
 */
export function cameraTransform(
  z: number,
  fx: number,
  fy: number,
  W: number,
  H: number,
  c: { x: number; y: number; w: number; h: number },
): [number, number, number] {
  // x axis
  const tx = W / c.w;
  const gx = tx > 1 ? Math.min(1, Math.max(0, (z - 1) / (tx - 1))) : 1;
  const ax = -z * c.x;
  const bx = W - z * (c.x + c.w);
  const loX = Math.min(ax, bx);
  const hiX = Math.max(ax, bx);
  const restX = (1 - z) * (W / 2);
  let offX = Math.min(Math.max(W / 2 - z * fx, restX + gx * (loX - restX)), restX + gx * (hiX - restX));
  offX = Math.min(Math.max(offX, loX), hiX);
  // y axis
  const ty = H / c.h;
  const gy = ty > 1 ? Math.min(1, Math.max(0, (z - 1) / (ty - 1))) : 1;
  const ay = -z * c.y;
  const by = H - z * (c.y + c.h);
  const loY = Math.min(ay, by);
  const hiY = Math.max(ay, by);
  const restY = (1 - z) * (H / 2);
  let offY = Math.min(Math.max(H / 2 - z * fy, restY + gy * (loY - restY)), restY + gy * (hiY - restY));
  offY = Math.min(Math.max(offY, loY), hiY);
  return [z, offX, offY];
}

/** map CSS px (viewport space) → canvas px (content space) */
function toCanvas(layout: Layout, cssX: number, cssY: number): { x: number; y: number } {
  const s = layout.content.w / layout.viewport.width;
  return { x: layout.content.x + cssX * s, y: layout.content.y + cssY * s };
}

/** the frame index is external input: one malformed entry can otherwise
 *  request absurd allocations or break the floor-hold walk */
export function validateFrameIndex(frameIndex: FrameIndexEntry[]): void {
  if (frameIndex.length === 0) throw new Error("render plan: empty frame index");
  let prevT = -1;
  for (const [i, e] of frameIndex.entries()) {
    if (typeof e?.file !== "string" || e.file.length === 0 || typeof e?.t_source !== "number") {
      throw new Error(`render plan: frames-index entry ${i} is malformed`);
    }
    // the host page fetches `/take/${file}` — constrain it to the frames/
    // namespace (matching the server's sanitizer) so a hand-edited index can't
    // point the fetch at other take artifacts
    if (!/^frames\/[0-9a-zA-Z._-]+$/.test(e.file)) {
      throw new Error(`render plan: frames-index entry ${i} file must be "frames/<name>" (got "${e.file}")`);
    }
    if (!Number.isFinite(e.t_source) || e.t_source < 0 || e.t_source < prevT) {
      throw new Error(`render plan: frames-index t_source not finite/monotonic at entry ${i}`);
    }
    prevT = e.t_source;
  }
}

export interface SourceGap {
  tA: number;
  tB: number;
}

/** stretches with no captured frame long enough to be a page change
 *  (NAV_GAP_MS): `tA` is the last frame before, `tB` the first after */
export function sourceGaps(frameIndex: FrameIndexEntry[]): SourceGap[] {
  const gaps: SourceGap[] = [];
  for (let i = 1; i < frameIndex.length; i++) {
    const tA = frameIndex[i - 1]!.t_source;
    const tB = frameIndex[i]!.t_source;
    if (tB - tA >= NAV_GAP_MS) gaps.push({ tA, tB });
  }
  return gaps;
}

/**
 * Phase 1: page boundaries, sorted by `in`.
 *
 * The first scene is loaded when capture starts (the take head opens it).
 * Every later scene marker is a page change; the marker is emitted BEFORE the
 * goto and frames are dropped until the new page has painted, so a scene's
 * opening is anchored to its first NEW frame, not to the marker. A logged
 * navigation is a page change, cut at its gap when its load left one and at
 * its commit time otherwise. What any other frame gap means depends on the
 * take: a navigation-logged take logged every page change, so the gap is a
 * stall on the same page; a legacy take infers a page change from a long one.
 */
export function detectBoundaries(log: EventLog, frameIndex: FrameIndexEntry[]): Boundary[] {
  const sceneMarkers = log.events.filter((e) => e.type === "scene").map((e) => e.t);
  const gaps = sourceGaps(frameIndex);
  const boundaries: Boundary[] = [];
  const claimed = new Set<number>();
  for (const m of sceneMarkers.slice(1)) {
    const gi = gaps.findIndex(
      (g, i) => !claimed.has(i) && g.tA >= m - MARKER_GAP_BEFORE_MS && g.tA <= m + MARKER_GAP_AFTER_MS,
    );
    if (gi >= 0) {
      claimed.add(gi);
      const g = gaps[gi]!;
      boundaries.push({ out: Math.min(m, g.tA) - ZOOM_OUT_MS, in: g.tB, snap: true, source: "scene-reload", at: m });
    } else {
      // the scene change did not reload (same URL): there is no cut to hide
      // a snap behind, so the zoom-out completes before the marker
      boundaries.push({ out: m - ZOOM_OUT_MS, in: m, snap: false, source: "scene-same-url", at: m });
    }
  }
  const navTimes = log.events.filter((e) => e.type === "navigation").map((e) => e.t);
  const nearNavigation = (g: SourceGap, t: number) =>
    g.tA >= t - NAV_EVENT_GAP_BEFORE_MS && g.tA <= t + NAV_EVENT_GAP_AFTER_MS;
  gaps.forEach((g, i) => {
    if (claimed.has(i)) return;
    // a click-triggered navigation: widen while the old page freezes, cut wide
    if (navTimes.some((t) => nearNavigation(g, t))) {
      boundaries.push({ out: g.tA, in: g.tB, snap: true, source: "navigation-gap", at: g.tA });
    } else if (!log.navigation_logged && g.tB - g.tA >= UNATTRIBUTED_GAP_MS) {
      // legacy take: a long unexplained gap is read as a page change. A
      // navigation-logged take holds the frame and keeps the camera instead
      // (a long main-thread task stops rAF and the screencast with it).
      boundaries.push({ out: g.tA, in: g.tB, snap: true, source: "inferred-gap", at: g.tA });
    }
  });
  // an action-triggered navigation the recorder logged: a fast local one keeps
  // frames flowing (no gap to detect), so the logged commit time is the cut.
  // A slow one also left a gap, and that boundary already covers it. An SPA
  // route change (kind "spa") is the same cut: the picture is a different
  // page, so no punch may keep dwelling on the old one.
  for (const t of navTimes) {
    if (gaps.some((g) => nearNavigation(g, t))) continue;
    boundaries.push({ out: t, in: t, snap: true, source: "navigation", at: t });
  }
  boundaries.sort((x, y) => x.in - y.in);
  return boundaries;
}

/** the new-page time that opens the stretch containing t (0 = take head) */
export function openingOf(boundaries: Boundary[], t: number): number {
  return boundaries.reduce((m, b) => (b.in <= t && b.in > m ? b.in : m), 0);
}

/** true when a page change separates times a < b */
export function boundaryBetween(boundaries: Boundary[], a: number, b: number): boolean {
  return boundaries.some((x) => x.in > a && x.in <= b);
}

/** the latest end a shot starting at `start` may have: its zoom-out must be
 *  complete by the next page change */
export function endLimit(boundaries: Boundary[], start: number): number {
  for (const x of boundaries) if (x.in > start) return x.out;
  return Infinity;
}

/** why a beat got no punch-in (render-report.json) */
export type SkipReason =
  /** the framed region is so large that fitting it needs no zoom */
  | "fills-viewport"
  /** the page opened too recently: the establishing shot owns the opening,
   *  and a punch starting after it could not arrive by the event */
  | "page-just-opened"
  /** the page changes too soon after the event to hold the shot */
  | "page-changes-after";

/** one interaction beat and what the camera did with it */
export interface BeatDecision {
  t: number;
  type: "click" | "hover" | "type";
  selector: string;
  /** "result": framed the action's focus_bbox (its payoff region);
   *  "interaction": framed the control itself */
  target: "result" | "interaction";
  framed: boolean;
  reason?: SkipReason;
  /** the punch: zoom and its [start, end] before bridging */
  z?: number;
  start?: number;
  end?: number;
}

/**
 * Phase 2: camera segments. Every page opens on an establishing shot (z=1;
 * focus is moot at z=1, centre keeps the spring target continuous), then each
 * click/hover/type beat gets a punch-in on its result region (focus_bbox) or
 * its control, unless it cannot be framed (reported in `beats`).
 */
export function planPunches(
  log: EventLog,
  layout: Layout,
  boundaries: Boundary[],
): { segments: CameraSegment[]; beats: BeatDecision[] } {
  const center = { x: layout.canvasW / 2, y: layout.canvasH / 2 };
  const segments: CameraSegment[] = [];
  const beats: BeatDecision[] = [];
  for (const t of [0, ...boundaries.map((b) => b.in)]) {
    segments.push({ start: t, end: t + ESTABLISH_MS, z: 1, fx: center.x, fy: center.y });
  }
  for (const e of log.events) {
    if (e.type !== "click" && e.type !== "hover" && e.type !== "type") continue;
    // prefer the result region (focus_bbox) when the action named one: the
    // camera holds on the payoff (graph/results), not the input that made it
    const focusBox = e.focus_bbox;
    const [bx, by, bw, bh] = focusBox ?? e.bbox;
    const beat: BeatDecision = { t: e.t, type: e.type, selector: e.selector, target: focusBox ? "result" : "interaction", framed: false };
    beats.push(beat);
    // clamp the focus point to the viewport so a stray off-frame bbox can
    // never fly the camera off into empty background
    const cssX = Math.min(Math.max(bx + bw / 2, 0), layout.viewport.width);
    const cssY = Math.min(Math.max(by + bh / 2, 0), layout.viewport.height);
    const focus = toCanvas(layout, cssX, cssY);
    let z: number;
    let dwell: number;
    if (focusBox) {
      // a result region should FILL the frame (FOCUS_FILL), not be cropped
      const fitW = (FOCUS_FILL * layout.viewport.width) / Math.max(bw, 1);
      const fitH = (FOCUS_FILL * layout.viewport.height) / Math.max(bh, 1);
      z = Math.max(1, Math.min(ZOOM_TARGET, fitW, fitH));
      dwell = FOCUS_DWELL_MS;
    } else {
      // size-aware punch for a plain interaction target: inflate the bbox to a
      // context region, then fit — small widgets reach ZOOM_TARGET, big
      // sections barely zoom, a full-viewport hero stays at z=1
      const regionW = Math.max(bw, MIN_CONTEXT_FRAC * layout.viewport.width);
      const regionH = Math.max(bh, MIN_CONTEXT_FRAC * layout.viewport.height);
      const fitW = (FOCUS_FILL * layout.viewport.width) / regionW;
      const fitH = (FOCUS_FILL * layout.viewport.height) / regionH;
      z = Math.max(1, Math.min(ZOOM_TARGET, fitW, fitH));
      dwell = ZOOM_DWELL_MS;
    }
    if (z <= 1) {
      beat.reason = "fills-viewport";
      continue;
    }
    // the establishing shot owns the page's opening; a punch that then cannot
    // arrive by its event is skipped rather than landing after the click
    const start = Math.max(e.t - ZOOM_LEAD_MS, openingOf(boundaries, e.t) + ESTABLISH_MS);
    if (start > e.t - ARRIVE_MS) {
      beat.reason = "page-just-opened";
      continue;
    }
    const end = Math.min(e.t + dwell, endLimit(boundaries, start));
    if (end < e.t + MIN_HOLD_AFTER_EVENT_MS) {
      beat.reason = "page-changes-after";
      continue;
    }
    Object.assign(beat, { framed: true, z, start, end });
    segments.push({ start, end, z, fx: focus.x, fy: focus.y });
  }
  segments.sort((a, b) => a.start - b.start);
  return { segments, beats };
}

/**
 * Phase 3: bridge nearby segments so the camera pans between targets instead
 * of zooming out and back in, but only when the targets are spatially near
 * (or the current shot is already wide), and NEVER across a page change.
 * Overlaps always truncate: once a later beat starts the earlier one is over;
 * letting it outlive the later beat would drag the camera back to a stale
 * target after the later dwell ends. Mutates `segments` (sorted by start).
 */
export function bridgeSegments(segments: CameraSegment[], boundaries: Boundary[], layout: Layout): void {
  const contentDiag = Math.hypot(layout.content.w, layout.content.h);
  for (let i = 0; i < segments.length - 1; i++) {
    const cur = segments[i]!;
    const next = segments[i + 1]!;
    const gap = next.start - cur.end;
    if (gap <= 0) {
      cur.end = next.start;
      continue;
    }
    if (gap >= MERGE_GAP_MS || boundaryBetween(boundaries, cur.start, next.start)) continue;
    const near = Math.hypot(next.fx - cur.fx, next.fy - cur.fy) < MERGE_DIST_FRAC * contentDiag;
    if (near || cur.z <= GLIDE_Z) cur.end = next.start;
  }
}

/** the camera's target at time t: the active segment, a gentle glide between
 *  two punches of the same page, or wide */
export function cameraTargetAt(
  segments: CameraSegment[],
  boundaries: Boundary[],
  center: { x: number; y: number },
): (t: number) => { z: number; fx: number; fy: number } {
  return (t) => {
    let active: CameraSegment | undefined;
    let prevEnded: CameraSegment | undefined; // most recent segment already over
    let next: CameraSegment | undefined; // first segment still ahead
    for (const s of segments) {
      if (t >= s.start && t <= s.end) active = s; // later-starting segment wins
      else if (s.end < t) prevEnded = s;
      if (s.start > t) {
        next = s;
        break;
      }
    }
    if (active) return active;
    // strictly between two punches on the same page: glide at a gentle floor
    // on the last focus instead of pumping fully out and back in
    if (prevEnded && next && prevEnded.z > GLIDE_Z && !boundaryBetween(boundaries, prevEnded.end, next.start)) {
      return { z: GLIDE_Z, fx: prevEnded.fx, fy: prevEnded.fy };
    }
    // a page change ahead, before the first beat, after the last: wide
    return { z: 1, fx: center.x, fy: center.y };
  };
}

/** hard ceiling on a take's span: the product maximum is 60s, and 2 minutes
 *  of slack covers overruns. Beyond it a corrupt timestamp is asking the
 *  planner to allocate the moon. */
const MAX_TAKE_MS = 120_000;

/**
 * Phase 4: the output length in ms. The picture runs past the last frame,
 * event dwell and cursor point by TAIL_MS, and past the last punch until its
 * zoom-out has settled (SETTLE_TAIL_MS): the take never ends with the camera
 * still moving.
 */
export function takeDurationMs(log: EventLog, frameIndex: FrameIndexEntry[], segments: CameraSegment[]): number {
  let lastT = frameIndex[frameIndex.length - 1]!.t_source;
  for (const e of log.events) {
    // a focused payoff holds for FOCUS_DWELL_MS (its camera segment does);
    // reserve the SAME dwell here or the render ends mid-hold on a final
    // focused beat
    let dwell = 0;
    if (e.type === "click" || e.type === "hover" || e.type === "type") {
      dwell = e.focus_bbox ? FOCUS_DWELL_MS : ZOOM_DWELL_MS;
    }
    lastT = Math.max(lastT, e.t + dwell);
    if (e.type === "cursor_path") {
      const last = e.points[e.points.length - 1];
      if (last) lastT = Math.max(lastT, last[0]);
    }
  }
  if (lastT > MAX_TAKE_MS) {
    throw new Error(
      `render plan: take spans ${Math.round(lastT)}ms > ${MAX_TAKE_MS}ms cap — corrupt timestamp in events.json or frames-index.json?`,
    );
  }
  let lastPunchEnd = 0;
  for (const s of segments) if (s.z > 1) lastPunchEnd = Math.max(lastPunchEnd, s.end);
  return Math.max(lastT + TAIL_MS, lastPunchEnd + SETTLE_TAIL_MS);
}

/** Phase 5: output frame → source frame, floor-hold per Event-Log Schema v0
 *  (hold the last frame whose t_source is <= the output frame time) */
export function floorHoldSources(frameIndex: FrameIndexEntry[], frames: number, frameMs: number): number[] {
  const sourceByFrame = new Array<number>(frames);
  let p = 0;
  for (let f = 0; f < frames; f++) {
    const t = f * frameMs;
    while (p + 1 < frameIndex.length && frameIndex[p + 1]!.t_source <= t) p++;
    sourceByFrame[f] = p;
  }
  return sourceByFrame;
}

/**
 * The plan's blend lane, all (srcB = -1, k = 0). Mixing two DIFFERENT source
 * frames at partial weight is a double exposure (a ghost on every gap, two
 * pages superimposed at a navigation). The plan has no pixels to prove two
 * frames near-identical, and blending near-identical frames is a visual
 * no-op, so every gap is floor-held and a page change is a clean cut.
 */
function noSourceBlend(frames: number): number[] {
  const blend = new Array<number>(frames * 2);
  for (let f = 0; f < frames; f++) {
    blend[f * 2] = -1;
    blend[f * 2 + 1] = 0;
  }
  return blend;
}

/**
 * Phase 6: spring integration at subframe resolution, flattened
 * [z, fx, fy] × SUBFRAMES per output frame.
 *
 * 180° shutter: integrate 2×SUBFRAMES steps per frame but record only the
 * first half, so blur spans half the frame interval (halving ghost spacing,
 * no onion-ring edges). A snap boundary (a real cut in the picture) resets
 * the camera to wide rest with the picture, on the first FRAME at or after
 * the cut: a frame is wholly before or wholly after the jump, never a smeared
 * frame motion-blurred across it.
 */
export function integrateCamera(
  targetAt: (t: number) => { z: number; fx: number; fy: number },
  boundaries: Boundary[],
  center: { x: number; y: number },
  frames: number,
  frameMs: number,
): number[] {
  const STEPS = SUBFRAMES * 2;
  const dt = frameMs / 1000 / STEPS;
  const state = { z: 1, fx: center.x, fy: center.y, vz: 0, vfx: 0, vfy: 0 };
  const camera = new Array<number>(frames * SUBFRAMES * 3);
  const snaps = boundaries.filter((b) => b.snap).map((b) => b.in);
  let nextSnap = 0;
  let w = 0;
  for (let f = 0; f < frames; f++) {
    while (nextSnap < snaps.length && snaps[nextSnap]! <= f * frameMs) {
      nextSnap++;
      Object.assign(state, { z: 1, fx: center.x, fy: center.y, vz: 0, vfx: 0, vfy: 0 });
    }
    for (let s = 0; s < STEPS; s++) {
      const t = f * frameMs + (s / STEPS) * frameMs;
      const tgt = targetAt(t);
      // critically damped: a = ω²(target − x) − 2ω·v
      state.vz += (OMEGA * OMEGA * (tgt.z - state.z) - 2 * OMEGA * state.vz) * dt;
      state.vfx += (OMEGA * OMEGA * (tgt.fx - state.fx) - 2 * OMEGA * state.vfx) * dt;
      state.vfy += (OMEGA * OMEGA * (tgt.fy - state.fy) - 2 * OMEGA * state.vfy) * dt;
      state.z += state.vz * dt;
      state.fx += state.vfx * dt;
      state.fy += state.vfy * dt;
      if (s < SUBFRAMES) {
        camera[w++] = state.z;
        camera[w++] = state.fx;
        camera[w++] = state.fy;
      }
    }
  }
  return camera;
}

/** Phase 7: cursor track + click pulses, flattened [x, y, pulse] per output
 *  frame in canvas coords. ALL cursor_path events merge in time order
 *  (third-party recorders may emit segments). */
export function cursorTrack(log: EventLog, layout: Layout, frames: number, frameMs: number): number[] {
  const points: [number, number, number][] = log.events
    .flatMap((e) => (e.type === "cursor_path" ? e.points : []))
    .sort((a, b) => a[0] - b[0]);
  const clicks = log.events.filter((e) => e.type === "click").map((e) => e.t);
  const cursor = new Array<number>(frames * 3);
  let q = 0;
  for (let f = 0; f < frames; f++) {
    const t = f * frameMs;
    while (q + 1 < points.length && points[q + 1]![0] <= t) q++;
    let cssX: number, cssY: number;
    if (points.length === 0) {
      cssX = layout.viewport.width / 2;
      cssY = layout.viewport.height - 100;
    } else {
      const a = points[q]!;
      const b = points[Math.min(q + 1, points.length - 1)]!;
      const span = b[0] - a[0];
      const k = t <= a[0] || span <= 0 ? 0 : Math.min(1, (t - a[0]) / span);
      cssX = a[1] + (b[1] - a[1]) * k;
      cssY = a[2] + (b[2] - a[2]) * k;
    }
    const pos = toCanvas(layout, cssX, cssY);
    let pulse = 0;
    for (const ct of clicks) {
      if (t >= ct && t <= ct + PULSE_MS) pulse = Math.max(pulse, 1 - (t - ct) / PULSE_MS);
    }
    cursor[f * 3] = pos.x;
    cursor[f * 3 + 1] = pos.y;
    cursor[f * 3 + 2] = pulse;
  }
  return cursor;
}

/** what the planner decided and why: the material for render-report.json */
export interface PlanDiagnostics {
  /** the take declared navigation_logged (unexplained gaps are stalls) */
  navigationLogged: boolean;
  boundaries: Boundary[];
  beats: BeatDecision[];
  durationMs: number;
}

export interface PlanOptions {
  layout?: Layout;
  background?: string | BackgroundStyle;
}

/** the render plan plus the decisions behind it */
export function planTake(
  log: EventLog,
  frameIndex: FrameIndexEntry[],
  opts: PlanOptions = {},
): { plan: RenderPlan; diagnostics: PlanDiagnostics } {
  validateFrameIndex(frameIndex);
  const fps = log.fps;
  if (!Number.isInteger(fps) || fps < 1 || fps > 240) {
    throw new Error(`render plan: unreasonable fps ${fps}`);
  }
  const frameMs = 1000 / fps;
  const layout = opts.layout ?? defaultLayout(log.viewport);
  const background =
    typeof opts.background === "object"
      ? opts.background
      : buildBackground(opts.background ?? "aurora", layout.canvasW, layout.canvasH);
  const center = { x: layout.canvasW / 2, y: layout.canvasH / 2 };

  const boundaries = detectBoundaries(log, frameIndex);
  const { segments, beats } = planPunches(log, layout, boundaries);
  bridgeSegments(segments, boundaries, layout);
  const durationMs = takeDurationMs(log, frameIndex, segments);
  const frames = Math.ceil(durationMs / frameMs);

  const plan: RenderPlan = {
    fps,
    frames,
    layout,
    background,
    fade: {
      inFrames: Math.min(Math.round(FADE_IN_MS / frameMs), Math.floor(frames / 3)),
      outFrames: Math.min(Math.round(FADE_OUT_MS / frameMs), Math.floor(frames / 3)),
    },
    sourceByFrame: floorHoldSources(frameIndex, frames, frameMs),
    blend: noSourceBlend(frames),
    camera: integrateCamera(cameraTargetAt(segments, boundaries, center), boundaries, center, frames, frameMs),
    cursor: cursorTrack(log, layout, frames, frameMs),
    sourceFiles: frameIndex.map((e) => e.file),
  };
  return {
    plan,
    diagnostics: { navigationLogged: log.navigation_logged === true, boundaries, beats, durationMs: frames * frameMs },
  };
}

export function buildRenderPlan(log: EventLog, frameIndex: FrameIndexEntry[], opts: PlanOptions = {}): RenderPlan {
  return planTake(log, frameIndex, opts).plan;
}
