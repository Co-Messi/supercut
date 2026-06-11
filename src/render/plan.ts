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

export interface RenderPlan {
  fps: number;
  frames: number;
  layout: Layout;
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

const ZOOM_TARGET = 1.55;
const ZOOM_LEAD_MS = 600;   // camera starts moving before the click lands
const ZOOM_DWELL_MS = 1500; // stays on target after the event
const TAIL_MS = 600;
const PULSE_MS = 350;
/** critically damped spring: ~settles in ≈ 4/OMEGA seconds */
const OMEGA = 9;

export function defaultLayout(viewport: EventLog["viewport"]): Layout {
  const canvasW = 1920;
  const canvasH = 1080;
  const scale = 0.84;
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
  opts: { layout?: Layout } = {},
): RenderPlan {
  if (frameIndex.length === 0) throw new Error("render plan: empty frame index");
  const fps = log.fps;
  const frameMs = 1000 / fps;
  const layout = opts.layout ?? defaultLayout(log.viewport);
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

  const targetAt = (t: number): { z: number; fx: number; fy: number } => {
    let active: CameraSegment | undefined;
    for (const s of segments) {
      if (t >= s.start && t <= s.end) active = s; // later-starting segment wins
      if (s.start > t) break;
    }
    return active ?? { z: 1, fx: center.x, fy: center.y };
  };

  // ---- spring integration at subframe resolution ----
  const dt = frameMs / 1000 / SUBFRAMES;
  const state = { z: 1, fx: center.x, fy: center.y, vz: 0, vfx: 0, vfy: 0 };
  const camera = new Array<number>(frames * SUBFRAMES * 3);
  let w = 0;
  for (let f = 0; f < frames; f++) {
    for (let s = 0; s < SUBFRAMES; s++) {
      const t = f * frameMs + (s / SUBFRAMES) * frameMs;
      const tgt = targetAt(t);
      // critically damped: a = ω²(target − x) − 2ω·v
      state.vz += (OMEGA * OMEGA * (tgt.z - state.z) - 2 * OMEGA * state.vz) * dt;
      state.vfx += (OMEGA * OMEGA * (tgt.fx - state.fx) - 2 * OMEGA * state.vfx) * dt;
      state.vfy += (OMEGA * OMEGA * (tgt.fy - state.fy) - 2 * OMEGA * state.vfy) * dt;
      state.z += state.vz * dt;
      state.fx += state.vfx * dt;
      state.fy += state.vfy * dt;
      camera[w++] = state.z;
      camera[w++] = state.fx;
      camera[w++] = state.fy;
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
    sourceByFrame,
    camera,
    cursor,
    sourceFiles: frameIndex.map((e) => e.file),
  };
}
