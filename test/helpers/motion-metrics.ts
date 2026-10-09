/**
 * Motion-quality metrics over a render plan: the numbers behind "does the
 * video feel natural". Shared by test/motion-quality.test.ts and by scripts
 * that score a real take, so the regression suite and a real-output check
 * measure exactly the same thing.
 *
 * Timing thresholds come from the planner itself (plan.ts exports them), so
 * the grader can never drift from the planner by a copied constant. What
 * counts as a page change is decided here from the log's evidence: scene
 * markers after the first, logged navigations, and (legacy takes only) long
 * unexplained gaps.
 */
import type { EventLog } from "../../src/schema/index.js";
import {
  cameraTransform,
  MARKER_GAP_AFTER_MS,
  MARKER_GAP_BEFORE_MS,
  NAV_EVENT_GAP_AFTER_MS,
  NAV_EVENT_GAP_BEFORE_MS,
  NAV_GAP_MS,
  SUBFRAMES,
  UNATTRIBUTED_GAP_MS,
  ZOOM_LEAD_MS,
  type FrameIndexEntry,
  type RenderPlan,
} from "../../src/render/plan.js";

const WIDE_Z = 1.02;
/** a per-frame zoom change this large is a snap (a cut resets the camera);
 *  the spring alone moves at most ~0.017 per frame */
const SNAP_DZ = 0.05;
/** an arrival window stops this long before the next beat: that beat's
 *  punch may start ZOOM_LEAD_MS early, plus a frame-rounding margin */
const NEXT_LEAD_GUARD_MS = ZOOM_LEAD_MS + 50;

type Beat = "click" | "type" | "hover";

export interface MotionMetrics {
  /** max camera z at any scene marker (after the first) */
  maxZAtSceneMarker: number;
  /** max camera z at the first output frame showing a post-gap (new page) source frame */
  maxZAfterNavGap: number;
  /** min over scenes: continuous ms of z ≤ 1.02 from the scene's first new frame */
  minWideRestMs: number;
  /** per-scene wide rest, in scene order */
  wideRestMs: number[];
  /** per beat of each kind: fraction of the punch completed at the event
   *  (1 = arrived); null when the camera never punched for it */
  clickArrival: (number | null)[];
  typeArrival: (number | null)[];
  hoverArrival: (number | null)[];
  /** min over clicks / types / hovers that punched (1 when none did) */
  minClickArrival: number;
  minTypeArrival: number;
  minHoverArrival: number;
  /** max zoom GAINED right after a beat: from the event to 400ms later, cut
   *  off where the next beat's lead-in could begin, so only this beat's own
   *  punch can contribute. An arrived punch gains < 0.02 here; a punch that
   *  only starts at/after the event (the camera chasing the action) gains
   *  ≥ 0.05 even in a short window. */
  maxLateRise: number;
  /** max on-screen pan per output frame outside snaps: how far (canvas px)
   *  the content point under the screen centre travels between frames,
   *  scaled by zoom. Measured through cameraTransform, so a focus change
   *  while wide (which the framing ramp hides) counts as no motion. */
  maxPanPxPerFrame: number;
  /** max |Δz| per output frame over the final 300ms */
  tailMaxDzPerFrame: number;
  /** final camera z */
  finalZ: number;
  /** max z range across ONE output frame's shutter samples — a camera snap
   *  that lands mid-shutter motion-blurs the whole window across the jump
   *  (one smeared frame); a moving spring spans < 0.01 */
  maxIntraFrameDz: number;
  /** framing: max px of wallpaper exposed on one side of an axis while the
   *  content overflows the canvas on the OTHER side (the window shoved off
   *  one edge with a slab of background on the opposite edge) */
  maxOneSidedWallpaperPx: number;
  /** framing: max px of wallpaper visible on any edge of an axis while the
   *  zoomed content is big enough to cover that axis (z·content ≥ canvas) */
  maxUncoveredWhileCoverablePx: number;
  /** framing: once the content covers the canvas on an axis, max px the
   *  mapped focus sits farther from the canvas centre than the closest
   *  position that keeps the canvas covered (0 = centred as far as the
   *  window edges allow) */
  maxFocusCentringErrorPx: number;
}

export interface FramingMetrics {
  maxOneSidedWallpaperPx: number;
  maxUncoveredWhileCoverablePx: number;
  maxFocusCentringErrorPx: number;
}

/** score the compositor's camera transform (the SAME function the host page
 *  embeds) over every subframe of the plan */
export function framingMetrics(plan: RenderPlan): FramingMetrics {
  const { canvasW: W, canvasH: H, content: C } = plan.layout;
  let oneSided = 0;
  let uncovered = 0;
  let centring = 0;
  for (let i = 0; i < plan.camera.length; i += 3) {
    const z = plan.camera[i]!, fx = plan.camera[i + 1]!, fy = plan.camera[i + 2]!;
    const [, offX, offY] = cameraTransform(z, fx, fy, W, H, C);
    const axes: [number, number, number, number, number][] = [
      // [canvas size, content start, content size, offset, focus]
      [W, C.x, C.w, offX, fx],
      [H, C.y, C.h, offY, fy],
    ];
    for (const [size, start, len, off, focus] of axes) {
      const lo = z * start + off; // mapped content start edge
      const hi = z * (start + len) + off; // mapped content end edge
      const gapLo = lo, gapHi = size - hi; // > 0 = wallpaper showing on that edge
      if (gapLo > 0 && gapHi < 0) oneSided = Math.max(oneSided, gapLo);
      if (gapHi > 0 && gapLo < 0) oneSided = Math.max(oneSided, gapHi);
      if (z * len >= size + 1e-6) {
        uncovered = Math.max(uncovered, gapLo, gapHi);
        // feasible covering offsets: [size − z(start+len), −z·start]; the
        // focus maps to z·focus + off — its closest feasible spot to centre
        const a = z * focus + size - z * (start + len);
        const b = z * focus - z * start;
        const best = Math.min(Math.max(size / 2, a), b);
        centring = Math.max(centring, Math.abs(z * focus + off - size / 2) - Math.abs(best - size / 2));
      }
    }
  }
  return { maxOneSidedWallpaperPx: oneSided, maxUncoveredWhileCoverablePx: uncovered, maxFocusCentringErrorPx: centring };
}

/** max on-screen pan per frame outside snaps (see MotionMetrics) */
export function maxPanPxPerFrame(plan: RenderPlan): number {
  const { canvasW: W, canvasH: H, content: C } = plan.layout;
  const at = (f: number) => {
    const i = f * SUBFRAMES * 3;
    const z = plan.camera[i]!;
    const [, offX, offY] = cameraTransform(z, plan.camera[i + 1]!, plan.camera[i + 2]!, W, H, C);
    return { z, px: (W / 2 - offX) / z, py: (H / 2 - offY) / z };
  };
  let max = 0;
  let prev = at(0);
  for (let f = 1; f < plan.frames; f++) {
    const cur = at(f);
    if (Math.abs(cur.z - prev.z) < SNAP_DZ) {
      max = Math.max(max, cur.z * Math.hypot(cur.px - prev.px, cur.py - prev.py));
    }
    prev = cur;
  }
  return max;
}

/**
 * Source gaps that are page changes, from the log's evidence: a gap ≥
 * NAV_GAP_MS starting inside a later scene marker's window or a logged
 * navigation's window (the planner's own windows). An unexplained gap is a
 * page change only on a legacy take, and only from UNATTRIBUTED_GAP_MS; on a
 * navigation-logged take it is a stall on the same page, where the camera
 * must NOT cut.
 */
export function navGaps(frameIndex: FrameIndexEntry[], log?: EventLog): { tA: number; tB: number }[] {
  const events = log?.events ?? [];
  const markers = events.filter((e) => e.type === "scene").map((e) => e.t).slice(1);
  const navs = events.filter((e) => e.type === "navigation").map((e) => e.t);
  const anchored = (tA: number) =>
    markers.some((m) => tA >= m - MARKER_GAP_BEFORE_MS && tA <= m + MARKER_GAP_AFTER_MS) ||
    navs.some((t) => tA >= t - NAV_EVENT_GAP_BEFORE_MS && tA <= t + NAV_EVENT_GAP_AFTER_MS);
  const gaps: { tA: number; tB: number }[] = [];
  for (let i = 1; i < frameIndex.length; i++) {
    const tA = frameIndex[i - 1]!.t_source;
    const tB = frameIndex[i]!.t_source;
    const len = tB - tA;
    if (len < NAV_GAP_MS) continue;
    if (anchored(tA) || (!log?.navigation_logged && len >= UNATTRIBUTED_GAP_MS)) gaps.push({ tA, tB });
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
  const gaps = navGaps(frameIndex, log);

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
    const g = gaps.find((g) => g.tA >= m - MARKER_GAP_BEFORE_MS && g.tA <= m + MARKER_GAP_AFTER_MS);
    return g ? g.tB : m;
  });
  const wideRestMs = sceneStarts.map((s) => {
    let f = firstFrameShowing(s);
    const f0 = f;
    while (f <= last && zAtFrame(f) <= WIDE_Z) f++;
    return (f - f0) * frameMs;
  });

  const isBeat = (e: EventLog["events"][number]): e is Extract<EventLog["events"][number], { type: Beat }> =>
    e.type === "click" || e.type === "type" || e.type === "hover";
  const beatTimes = log.events.filter(isBeat).map((e) => e.t);
  const nextBeatAfter = (t: number) => beatTimes.find((b) => b > t) ?? Infinity;
  /** fraction of the punch done at the event, or null when it never punched */
  const arrival = (t: number): number | null => {
    const f = frameAt(t);
    // the punch's settled zoom: the peak within 1s after the event, but never
    // reaching into the NEXT beat's lead-in (that zoom is not ours)
    const windowEnd = Math.min(t + 1000, nextBeatAfter(t) - NEXT_LEAD_GUARD_MS);
    let target = zAtFrame(f);
    for (let g = f; g <= frameAt(windowEnd); g++) target = Math.max(target, zAtFrame(g));
    if (target - 1 < 0.02) return null; // never punched: skipped, reported by the plan
    return (zAtFrame(f) - 1) / (target - 1);
  };
  const arrivals = (kind: Beat) => log.events.filter((e) => e.type === kind).map((e) => arrival(e.t));
  const minOf = (a: (number | null)[]) => {
    const punched = a.filter((x): x is number => x !== null);
    return punched.length ? Math.min(...punched) : 1;
  };
  const clickArrival = arrivals("click");
  const typeArrival = arrivals("type");
  const hoverArrival = arrivals("hover");

  let maxLateRise = 0;
  for (const t of beatTimes) {
    const end = Math.min(t + 400, nextBeatAfter(t) - ZOOM_LEAD_MS, last * frameMs);
    if (end - t < 80) continue;
    maxLateRise = Math.max(maxLateRise, zAt(end) - zAt(t));
  }

  let tailMaxDzPerFrame = 0;
  for (let f = Math.max(1, last - Math.round(300 / frameMs)); f <= last; f++) {
    tailMaxDzPerFrame = Math.max(tailMaxDzPerFrame, Math.abs(zAtFrame(f) - zAtFrame(f - 1)));
  }

  let maxIntraFrameDz = 0;
  for (let f = 0; f < plan.frames; f++) {
    let lo = Infinity, hi = -Infinity;
    for (let s = 0; s < SUBFRAMES; s++) {
      const z = plan.camera[(f * SUBFRAMES + s) * 3]!;
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
    maxIntraFrameDz = Math.max(maxIntraFrameDz, hi - lo);
  }

  return {
    maxZAtSceneMarker,
    maxIntraFrameDz,
    maxZAfterNavGap,
    minWideRestMs: Math.min(...wideRestMs),
    wideRestMs,
    clickArrival,
    typeArrival,
    hoverArrival,
    minClickArrival: minOf(clickArrival),
    minTypeArrival: minOf(typeArrival),
    minHoverArrival: minOf(hoverArrival),
    maxLateRise,
    maxPanPxPerFrame: maxPanPxPerFrame(plan),
    tailMaxDzPerFrame,
    finalZ: zAtFrame(last),
    ...framingMetrics(plan),
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
