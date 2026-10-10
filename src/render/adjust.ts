/**
 * QC adjustments applied to a recorded take at render time: a longer hold on
 * a scene's last frame, and a camera box on one of its beats. Both change only
 * how the footage is cut, so they never need the app filmed again. The inputs
 * are not modified: the take on disk stays what the recorder wrote.
 */
import type { EventLog } from "../schema/index.js";

export interface TakeAdjustments {
  /** extra ms the scene's final frame is held, inserted where its hold ends */
  holds: { scene: string; extraMs: number }[];
  /** a camera box for the scene's Nth interaction event (click, type or
   *  hover, in log order), recorded as a QC focus */
  zooms: { scene: string; focusEvent: number; bbox: [number, number, number, number] }[];
}

export interface FrameIndexEntry {
  file: string;
  t_source: number;
}

export interface AdjustedTake {
  log: EventLog;
  frameIndex: FrameIndexEntry[];
  /** human-readable list of what was applied */
  applied: string[];
  /** adjustments that could not be placed on this take, with why */
  skipped: string[];
}

export const NO_ADJUSTMENTS: TakeAdjustments = { holds: [], zooms: [] };

export function hasAdjustments(adj: TakeAdjustments | undefined): adj is TakeAdjustments {
  return !!adj && (adj.holds.length > 0 || adj.zooms.length > 0);
}

/** the scene event's position in the log and the position of the next one */
function sceneSpan(log: EventLog, name: string): { at: number; next: number } | undefined {
  const at = log.events.findIndex((e) => e.type === "scene" && e.name === name);
  if (at < 0) return undefined;
  let next = log.events.length;
  for (let i = at + 1; i < log.events.length; i++) {
    if (log.events[i]!.type === "scene") {
      next = i;
      break;
    }
  }
  return { at, next };
}

/**
 * Hold the picture at `t` for `extraMs`: every frame and event at or after `t`
 * moves later by `extraMs`, and the gap is filled at the log's frame cadence
 * with the frame showing just before `t`, so the capture-health and skew gates
 * see continuous footage rather than a stall.
 */
function insertFreeze(log: EventLog, index: FrameIndexEntry[], t: number, extraMs: number): FrameIndexEntry[] | undefined {
  const before = index.filter((e) => e.t_source < t);
  const held = before[before.length - 1];
  if (!held) return undefined;
  const cadence = 1000 / log.fps;
  const fill: FrameIndexEntry[] = [];
  for (let k = 0; k * cadence < extraMs; k++) fill.push({ file: held.file, t_source: t + k * cadence });
  const after = index.filter((e) => e.t_source >= t).map((e) => ({ file: e.file, t_source: e.t_source + extraMs }));
  for (const e of log.events) {
    if (e.type === "cursor_path") {
      e.points = e.points.map(([pt, x, y]) => [pt >= t ? pt + extraMs : pt, x, y] as [number, number, number]);
      continue;
    }
    if (e.t >= t) {
      e.t += extraMs;
      if (e.observed_t !== undefined) e.observed_t += extraMs;
    }
  }
  return [...before, ...fill, ...after];
}

export function applyTakeAdjustments(
  log: EventLog,
  frameIndex: FrameIndexEntry[],
  adj: TakeAdjustments,
): AdjustedTake {
  const out: EventLog = structuredClone(log);
  let index = frameIndex.map((e) => ({ file: e.file, t_source: e.t_source }));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const z of adj.zooms) {
    const span = sceneSpan(out, z.scene);
    const beats = span
      ? out.events.slice(span.at + 1, span.next).filter((e) => e.type === "click" || e.type === "type" || e.type === "hover")
      : [];
    const ev = beats[z.focusEvent];
    if (!ev || (ev.type !== "click" && ev.type !== "type" && ev.type !== "hover")) {
      skipped.push(`zoom on scene "${z.scene}" beat ${z.focusEvent}: no such beat in the take`);
      continue;
    }
    ev.focus_bbox = z.bbox;
    ev.focus_source = "qc";
    applied.push(`zoom on scene "${z.scene}" beat ${z.focusEvent}`);
  }

  for (const h of adj.holds) {
    const span = sceneSpan(out, h.scene);
    if (!span || !(h.extraMs > 0)) {
      skipped.push(`hold on scene "${h.scene}": no such scene in the take`);
      continue;
    }
    const nextScene = out.events[span.next];
    const lastFrameT = index.length ? index[index.length - 1]!.t_source : 0;
    // a scene's hold ends where the next scene's entry begins; the last
    // scene's ends with the footage
    const t = nextScene ? nextScene.t : lastFrameT + 1000 / out.fps;
    const next = insertFreeze(out, index, t, h.extraMs);
    if (!next) {
      skipped.push(`hold on scene "${h.scene}": no frame before its end`);
      continue;
    }
    index = next;
    applied.push(`hold +${h.extraMs}ms on scene "${h.scene}"`);
  }

  return { log: out, frameIndex: index, applied, skipped };
}
