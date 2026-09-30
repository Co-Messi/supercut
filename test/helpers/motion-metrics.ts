/**
 * Motion-quality metrics over a render plan — the numbers behind "does the
 * video feel natural". Shared by test/motion-quality.test.ts and by
 * tools-style scripts that score a real take (`npx tsx` this module's
 * `scoreTake`), so the regression suite and the real-output check measure
 * exactly the same thing.
 */
import type { EventLog } from "../../src/schema/index.js";
import { SUBFRAMES, type FrameIndexEntry, type RenderPlan } from "../../src/render/plan.js";

/** a source gap at least this long is a page transition (navigation /
 *  reload), never ordinary capture jitter */
export const NAV_GAP_MS = 250;
/** a navigation gap attributed to a scene marker may start this long before
 *  the marker or up to this long after it */
const MARKER_WINDOW_BEFORE_MS = 1000;
const MARKER_WINDOW_AFTER_MS = 4000;
const WIDE_Z = 1.02;

export interface MotionMetrics {
  /** max camera z at any scene marker (after the first) */
  maxZAtSceneMarker: number;
  /** max camera z at the first output frame showing a post-gap (new page) source frame */
  maxZAfterNavGap: number;
  /** min over scenes: continuous ms of z ≤ 1.02 from the scene's first new frame */
  minWideRestMs: number;
  /** per-scene wide rest, in scene order */
  wideRestMs: number[];
  /** per click: fraction of the punch completed at the click (1 = arrived);
   *  null when the camera never punched for that click */
  clickArrival: (number | null)[];
  /** min over clicks that punched */
  minClickArrival: number;
  /** max |Δz| per output frame over the final 300ms */
  tailMaxDzPerFrame: number;
  /** final camera z */
  finalZ: number;
  /** share of output frames that blend two different source frames */
  blendedShare: number;
}

export function navGaps(frameIndex: FrameIndexEntry[]): { tA: number; tB: number }[] {
  const gaps: { tA: number; tB: number }[] = [];
  for (let i = 1; i < frameIndex.length; i++) {
    const tA = frameIndex[i - 1]!.t_source;
    const tB = frameIndex[i]!.t_source;
    if (tB - tA >= NAV_GAP_MS) gaps.push({ tA, tB });
  }
  return gaps;
}

export function motionMetrics(log: EventLog, frameIndex: FrameIndexEntry[], plan: RenderPlan): MotionMetrics {
  const frameMs = 1000 / plan.fps;
  const last = plan.frames - 1;
  const frameAt = (t: number) => Math.min(last, Math.max(0, Math.round(t / frameMs)));
  const zAtFrame = (f: number) => plan.camera[f * SUBFRAMES * 3]!;
  const zAt = (t: number) => zAtFrame(frameAt(t));

  const markers = log.events.filter((e) => e.type === "scene").map((e) => e.t);
  const gaps = navGaps(frameIndex);

  let maxZAtSceneMarker = 1;
  for (const m of markers.slice(1)) maxZAtSceneMarker = Math.max(maxZAtSceneMarker, zAt(m));

  // first output frame whose floor-held source is the post-gap frame
  const firstFrameShowing = (tB: number) => Math.min(last, Math.ceil(tB / frameMs - 1e-9));
  let maxZAfterNavGap = 1;
  for (const g of gaps) maxZAfterNavGap = Math.max(maxZAfterNavGap, zAtFrame(firstFrameShowing(g.tB)));
  // a logged action-triggered navigation that left no gap: the frame after
  // its commit already shows (or is about to show) the new page
  for (const e of log.events) {
    if (e.type === "navigation") maxZAfterNavGap = Math.max(maxZAfterNavGap, zAtFrame(Math.min(last, frameAt(e.t) + 1)));
  }

  // each scene's first NEW frame: the take head for scene 1; for later scenes
  // the first frame after the nav gap attributed to the marker (or the marker
  // itself when the scene change did not reload)
  const sceneStarts = markers.map((m, i) => {
    if (i === 0) return 0;
    const g = gaps.find((g) => g.tA >= m - MARKER_WINDOW_BEFORE_MS && g.tA <= m + MARKER_WINDOW_AFTER_MS);
    return g ? g.tB : m;
  });
  const wideRestMs = sceneStarts.map((s) => {
    let f = firstFrameShowing(s);
    const f0 = f;
    while (f <= last && zAtFrame(f) <= WIDE_Z) f++;
    return (f - f0) * frameMs;
  });

  const interactions = log.events
    .filter((e) => e.type === "click" || e.type === "type" || e.type === "hover")
    .map((e) => e.t);
  const clickArrival = log.events
    .filter((e) => e.type === "click")
    .map((e) => {
      const f = frameAt(e.t);
      // the punch's settled zoom: the peak within 1s after the click, but
      // never reaching into the NEXT beat's lead-in (that zoom is not ours)
      const nextBeat = interactions.find((t) => t > e.t) ?? Infinity;
      const windowEnd = Math.min(e.t + 1000, nextBeat - 800);
      let target = zAtFrame(f);
      for (let g = f; g <= frameAt(windowEnd); g++) target = Math.max(target, zAtFrame(g));
      if (target - 1 < 0.02) return null; // never punched: skipped, fine
      return (zAtFrame(f) - 1) / (target - 1);
    });
  const punched = clickArrival.filter((a): a is number => a !== null);

  let tailMaxDzPerFrame = 0;
  for (let f = Math.max(1, last - Math.round(300 / frameMs)); f <= last; f++) {
    tailMaxDzPerFrame = Math.max(tailMaxDzPerFrame, Math.abs(zAtFrame(f) - zAtFrame(f - 1)));
  }

  let blended = 0;
  for (let f = 0; f < plan.frames; f++) {
    const b = plan.blend[f * 2]!;
    if (b >= 0 && b !== plan.sourceByFrame[f] && plan.blend[f * 2 + 1]! > 0) blended++;
  }

  return {
    maxZAtSceneMarker,
    maxZAfterNavGap,
    minWideRestMs: Math.min(...wideRestMs),
    wideRestMs,
    clickArrival,
    minClickArrival: punched.length ? Math.min(...punched) : 1,
    tailMaxDzPerFrame,
    finalZ: zAtFrame(last),
    blendedShare: blended / plan.frames,
  };
}

/** deterministic irregular source cadence: mean `intervalMs`, ±jitter */
export function sourceFrames(fromMs: number, toMs: number, intervalMs: number, seed = 7): FrameIndexEntry[] {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out: FrameIndexEntry[] = [];
  for (let t = fromMs; t <= toMs; t += intervalMs * (0.6 + rnd() * 0.8)) {
    out.push({ file: "", t_source: Math.round(t * 1000) / 1000 });
  }
  return out;
}

export function numberFrames(entries: FrameIndexEntry[]): FrameIndexEntry[] {
  return entries.map((e, i) => ({ ...e, file: `frames/${String(i).padStart(6, "0")}.jpg` }));
}
