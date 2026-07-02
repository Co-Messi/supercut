/**
 * Render plan — stage 5's brain, computed in tested TS before any pixel work.
 *
 *   events.json + frames-index.json
 *        │
 *        ▼
 *   ┌─ buildRenderPlan ───────────────────────────────────────────┐
 *   │ duration → output frame count (60fps grid)                   │
 *   │ source mapping: output frame → captured frame (nearest hold) │
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
  /** output frame → index into frameIndex (nearest-hold) */
  sourceByFrame: number[];
  /** flattened [srcB, k] per output frame: when the frame time falls inside a
   *  source gap, srcB is the second source index and k its blend weight
   *  (srcB = -1, k = 0 where no blend applies) */
  blend: number[];
  /** flattened [z, fx, fy] per subframe: frames × SUBFRAMES × 3 (canvas coords) */
  camera: number[];
  /** flattened [x, y, pulse] per output frame (canvas coords; pulse 0..1) */
  cursor: number[];
  sourceFiles: string[];
}

interface CameraSegment {
  start: number;
  end: number;
  z: number;
  fx: number;
  fy: number;
}

/** MAXIMUM punch-in, reached only for small widgets — a plain bbox is inflated
 *  to a context region and fit-zoomed, so large targets zoom far less */
const ZOOM_TARGET = 1.48;
const ZOOM_LEAD_MS = 600;   // camera starts moving before the click lands
const ZOOM_DWELL_MS = 1500; // stays on target after the event
/** each scene opens wide: this long at z=1 so the viewer reads the whole page
 *  before the first punch-in (Screen-Studio establishing shot) */
const ESTABLISH_MS = 1200;
/** a plain interaction bbox is inflated to at least this fraction of the
 *  viewport before fit-zooming — the framed shot always keeps page context,
 *  and a full-width hero gets no punch at all */
const MIN_CONTEXT_FRAC = 0.55;
/** bridge nearby punch-ins only when their targets are NEAR: beyond this
 *  fraction of the content diagonal the camera widens between beats instead
 *  of dragging a tight crop across the page */
const MERGE_DIST_FRAC = 0.35;
/** scene-boundary crossfade length (last pre-nav frame → first post-nav
 *  frame) — a deliberate dissolve instead of a freeze-then-snap */
const CROSSFADE_MS = 350;
/** source gaps longer than this get temporally cross-blended so residual
 *  capture stalls read as motion, not a held still */
const BLEND_MIN_GAP_MS = 25;
/** residual gaps longer than this are held-then-faded like a navigation —
 *  dissolving linearly across a long gap reads as mush, not motion */
const RESIDUAL_BLEND_MAX_MS = 500;
/** a scene marker within this much before a source gap attributes the gap to
 *  that scene's navigation (frames keep flowing while pre-nav work — URL
 *  policy DNS checks on real networks — runs after the marker) */
const NAV_MARKER_SLACK_MS = 1000;
/** a framed RESULT (focus_bbox) is the payoff — hold on it longer than a plain
 *  interaction so the viewer reads the graph/results before the camera moves */
const FOCUS_DWELL_MS = 4200;
/** a result region should FILL the frame, not be punched-into and cropped:
 *  fit it to this fraction of the viewport (the rest is breathing room) */
const FOCUS_FILL = 0.88;
/** segments closer than this bridge into ONE held zoom — the camera glides
 *  between targets instead of pumping out/in per click. */
const MERGE_GAP_MS = 2600;
/** between two scenes (a gap too wide to fully merge) the camera relaxes to this
 *  gentle floor instead of snapping all the way back to z=1 — so it glides scene
 *  to scene rather than pumping fully out then punching back in (which read as a
 *  hard cut). Only engaged STRICTLY between segments: before the first and after
 *  the last it still settles wide to z=1. */
const GLIDE_Z = 1.1;
const TAIL_MS = 600;
const PULSE_MS = 350;
/** critically damped spring: ~settles in ≈ 4/OMEGA seconds — 6.5 is a calm,
 *  stately glide; 9 read as restless */
const OMEGA = 6.5;

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

/** map CSS px (viewport space) → canvas px (content space) */
function toCanvas(layout: Layout, cssX: number, cssY: number): { x: number; y: number } {
  const s = layout.content.w / layout.viewport.width;
  return { x: layout.content.x + cssX * s, y: layout.content.y + cssY * s };
}

export function buildRenderPlan(
  log: EventLog,
  frameIndex: FrameIndexEntry[],
  opts: { layout?: Layout; background?: string | BackgroundStyle } = {},
): RenderPlan {
  if (frameIndex.length === 0) throw new Error("render plan: empty frame index");
  // frame index is external input — one malformed entry can otherwise request
  // absurd allocations or break the nearest-hold walk.
  let prevT = -1;
  for (const [i, e] of frameIndex.entries()) {
    if (typeof e?.file !== "string" || e.file.length === 0 || typeof e?.t_source !== "number") {
      throw new Error(`render plan: frames-index entry ${i} is malformed`);
    }
    if (!Number.isFinite(e.t_source) || e.t_source < 0 || e.t_source < prevT) {
      throw new Error(`render plan: frames-index t_source not finite/monotonic at entry ${i}`);
    }
    prevT = e.t_source;
  }
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

  // ---- duration ----
  let lastT = frameIndex[frameIndex.length - 1]!.t_source;
  for (const e of log.events) {
    // a focused payoff holds for FOCUS_DWELL_MS (the camera segment below uses
    // it); reserve the SAME dwell here or the render can end mid-hold and cut the
    // result framing short on a final focused beat.
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
  const frames = Math.ceil((lastT + TAIL_MS) / frameMs);
  // hard ceiling: product max is 60s; 2 min of slack covers overruns — beyond
  // that a corrupt timestamp is asking us to allocate the moon.
  const MAX_TAKE_MS = 120_000;
  if (lastT > MAX_TAKE_MS) {
    throw new Error(
      `render plan: take spans ${Math.round(lastT)}ms > ${MAX_TAKE_MS}ms cap — corrupt timestamp in events.json or frames-index.json?`,
    );
  }

  // ---- source mapping (nearest-hold per Event-Log Schema v0) ----
  const sourceByFrame = new Array<number>(frames);
  let p = 0;
  for (let f = 0; f < frames; f++) {
    const t = f * frameMs;
    while (p + 1 < frameIndex.length && frameIndex[p + 1]!.t_source <= t) p++;
    sourceByFrame[f] = p;
  }

  // scene boundaries: the take head plus every scene marker after the first
  // (those follow a navigation — the first scene is already loaded when
  // capture starts). Each opens with an establishing shot; the nav markers
  // also drive the scene-boundary crossfade below.
  const sceneMarkers = log.events.filter((e) => e.type === "scene").map((e) => e.t);
  const navMarkers = sceneMarkers.slice(1);
  const sceneStarts = [0, ...navMarkers];

  // ---- source cross-blend: nav crossfades + residual gap smoothing ----
  // one source bitmap per output frame turns a source gap into a freeze;
  // blending toward the next source turns a navigation into a deliberate
  // dissolve and a residual capture stall into continuous motion.
  const blend = new Array<number>(frames * 2);
  for (let f = 0; f < frames; f++) {
    blend[f * 2] = -1;
    blend[f * 2 + 1] = 0;
    const t = f * frameMs;
    const a = sourceByFrame[f]!;
    if (a + 1 >= frameIndex.length) continue;
    const tA = frameIndex[a]!.t_source;
    const tB = frameIndex[a + 1]!.t_source;
    const gap = tB - tA;
    if (gap <= BLEND_MIN_GAP_MS || t <= tA) continue;
    const isNav = navMarkers.some((nt) => nt >= tA - NAV_MARKER_SLACK_MS && nt < tB);
    let k: number;
    if (isNav || gap > RESIDUAL_BLEND_MAX_MS) {
      // hold the old frame, then crossfade at the end: a long gap dissolved
      // linearly across its whole length reads as seconds of mush between two
      // different page states — a quick late fade reads as deliberate
      const fadeStart = Math.max(tA, tB - CROSSFADE_MS);
      if (t < fadeStart) continue;
      k = (t - fadeStart) / (tB - fadeStart);
    } else {
      k = (t - tA) / gap;
    }
    blend[f * 2] = a + 1;
    blend[f * 2 + 1] = Math.min(1, Math.max(0, k));
  }

  // ---- camera segments ----
  const segments: CameraSegment[] = [];
  // establishing shots: each scene opens at z=1 (focus is moot at z=1; center
  // keeps the spring target continuous)
  for (const t of sceneStarts) {
    segments.push({ start: t, end: t + ESTABLISH_MS, z: 1, fx: center.x, fy: center.y });
  }
  for (const e of log.events) {
    if (e.type !== "click" && e.type !== "hover" && e.type !== "type") continue;
    // 4b: prefer the result region (focus_bbox) when the action named one — the
    // camera holds on the payoff (graph/results), not the input that made it.
    const framed = e.focus_bbox ?? e.bbox;
    const [bx, by, bw, bh] = framed;
    // defense in depth: clamp the focus point to the viewport so a stray
    // off-frame bbox can never fly the camera off into empty background
    // (the capture stage now scrolls targets in-view, but never trust a bbox)
    const cssX = Math.min(Math.max(bx + bw / 2, 0), layout.viewport.width);
    const cssY = Math.min(Math.max(by + bh / 2, 0), layout.viewport.height);
    const focus = toCanvas(layout, cssX, cssY);
    let z: number;
    let dwell: number;
    if (e.focus_bbox) {
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
    // the establishing shot wins the scene's opening: a punch-in may not begin
    // until it has played out (but always leave a real punch window)
    const sceneStart = sceneStarts.reduce((m, t) => (t <= e.t && t > m ? t : m), 0);
    const end = e.t + dwell;
    const start = Math.min(Math.max(e.t - ZOOM_LEAD_MS, sceneStart + ESTABLISH_MS), end - 300);
    segments.push({ start, end, z, fx: focus.x, fy: focus.y });
  }
  segments.sort((a, b) => a.start - b.start);

  // bridge nearby segments so the camera pans between targets instead of
  // zooming out and back in — but only when the targets are spatially near
  // (or the current shot is already wide); far targets get a widen-out instead.
  // OVERLAPS always truncate: once a later beat starts the earlier one is
  // over — letting it outlive the later beat would drag the camera back to a
  // stale target after the later dwell ends.
  const contentDiag = Math.hypot(layout.content.w, layout.content.h);
  for (let i = 0; i < segments.length - 1; i++) {
    const cur = segments[i]!;
    const next = segments[i + 1]!;
    const gap = next.start - cur.end;
    if (gap <= 0) {
      cur.end = next.start;
      continue;
    }
    if (gap >= MERGE_GAP_MS) continue;
    const near = Math.hypot(next.fx - cur.fx, next.fy - cur.fy) < MERGE_DIST_FRAC * contentDiag;
    if (near || cur.z <= GLIDE_Z) cur.end = next.start;
  }

  const targetAt = (t: number): { z: number; fx: number; fy: number } => {
    let active: CameraSegment | undefined;
    let prevEnded: CameraSegment | undefined; // most recent segment already over
    let nextStarts = false; // a segment still lies ahead
    for (const s of segments) {
      if (t >= s.start && t <= s.end) active = s; // later-starting segment wins
      else if (s.end < t) prevEnded = s;
      if (s.start > t) { nextStarts = true; break; }
    }
    if (active) return active;
    // strictly between two scenes: glide at a gentle floor on the last focus so
    // the camera doesn't pump fully out and hard-cut into the next scene.
    if (prevEnded && nextStarts) return { z: GLIDE_Z, fx: prevEnded.fx, fy: prevEnded.fy };
    // before the first event / after the last: settle wide.
    return { z: 1, fx: center.x, fy: center.y };
  };

  // ---- spring integration at subframe resolution ----
  // 180° shutter: integrate 2×SUBFRAMES steps per frame but RECORD only the
  // first half — blur spans half the frame interval, halving ghost spacing
  // (prevents onion-ring edge artifacts)
  const STEPS = SUBFRAMES * 2;
  const dt = frameMs / 1000 / STEPS;
  const state = { z: 1, fx: center.x, fy: center.y, vz: 0, vfx: 0, vfy: 0 };
  const camera = new Array<number>(frames * SUBFRAMES * 3);
  let w = 0;
  for (let f = 0; f < frames; f++) {
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

  // ---- cursor track + click pulses ----
  // merge ALL cursor_path events (third-party recorders may emit segments)
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

  return {
    fps,
    frames,
    layout,
    background,
    sourceByFrame,
    blend,
    camera,
    cursor,
    sourceFiles: frameIndex.map((e) => e.file),
  };
}
