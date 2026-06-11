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
 * pastel-mesh look of OpenAI-style launch videos (Brayden's reference,
 * 2026-06-11). Apple wallpapers can't be bundled (copyright); users get the
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

const ZOOM_TARGET = 1.48;
const ZOOM_LEAD_MS = 600;   // camera starts moving before the click lands
const ZOOM_DWELL_MS = 1500; // stays on target after the event
/** segments closer than this bridge into ONE held zoom — the camera glides
 *  between targets instead of pumping out/in per click (Brayden: "everything
 *  is just moving too much... the screen is kind of shaking", 2026-06-11) */
const MERGE_GAP_MS = 2600;
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
  const fps = log.fps;
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
    const dwell = e.type === "click" || e.type === "hover" || e.type === "type" ? ZOOM_DWELL_MS : 0;
    lastT = Math.max(lastT, e.t + dwell);
    if (e.type === "cursor_path") {
      const last = e.points[e.points.length - 1];
      if (last) lastT = Math.max(lastT, last[0]);
    }
  }
  const frames = Math.ceil((lastT + TAIL_MS) / frameMs);

  // ---- source mapping (nearest-hold per Event-Log Schema v0) ----
  const sourceByFrame = new Array<number>(frames);
  let p = 0;
  for (let f = 0; f < frames; f++) {
    const t = f * frameMs;
    while (p + 1 < frameIndex.length && frameIndex[p + 1]!.t_source <= t) p++;
    sourceByFrame[f] = p;
  }

  // ---- camera segments from interaction events ----
  const segments: CameraSegment[] = [];
  for (const e of log.events) {
    if (e.type !== "click" && e.type !== "hover" && e.type !== "type") continue;
    const [bx, by, bw, bh] = e.bbox;
    const focus = toCanvas(layout, bx + bw / 2, by + bh / 2);
    segments.push({
      start: e.t - ZOOM_LEAD_MS,
      end: e.t + ZOOM_DWELL_MS,
      z: ZOOM_TARGET,
      fx: focus.x,
      fy: focus.y,
    });
  }
  segments.sort((a, b) => a.start - b.start);

  // bridge nearby segments: hold the zoom across short gaps so the camera
  // pans between targets instead of zooming out and back in
  for (let i = 0; i < segments.length - 1; i++) {
    const cur = segments[i]!;
    const next = segments[i + 1]!;
    if (next.start - cur.end < MERGE_GAP_MS) cur.end = next.start;
  }

  const targetAt = (t: number): { z: number; fx: number; fy: number } => {
    let active: CameraSegment | undefined;
    for (const s of segments) {
      if (t >= s.start && t <= s.end) active = s; // later-starting segment wins
      if (s.start > t) break;
    }
    return active ?? { z: 1, fx: center.x, fy: center.y };
  };

  // ---- spring integration at subframe resolution ----
  // 180° shutter: integrate 2×SUBFRAMES steps per frame but RECORD only the
  // first half — blur spans half the frame interval, halving ghost spacing
  // (the "onion ring" edge artifact Brayden spotted, 2026-06-11)
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
  const pathEvent = log.events.find((e) => e.type === "cursor_path");
  const points: [number, number, number][] =
    pathEvent && pathEvent.type === "cursor_path" ? pathEvent.points : [];
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
    camera,
    cursor,
    sourceFiles: frameIndex.map((e) => e.file),
  };
}
