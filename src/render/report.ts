/**
 * render-report.json: what the renderer decided and why, written next to the
 * output video. The plan's boundaries (and the evidence for each), every beat
 * framed or skipped with its reason, the measured output length against the
 * 60s limit, the capture's source fps, the blur accumulator the page used,
 * and the delivered bitrate. Pure helpers; renderTake does the I/O.
 */
import type { BeatDecision, Boundary, BoundarySource, PlanDiagnostics, SkipReason } from "./plan.js";

export interface AccumulatorInfo {
  mode: "float16" | "8bit";
  maxPasses: number;
}

/** the host page announces its accumulator as "[render] accumulator <mode> <passes>" */
export function parseAccumulatorLine(text: string): AccumulatorInfo | null {
  const m = /^\[render\] accumulator (float16|8bit) (\d+)$/.exec(text.trim());
  return m ? { mode: m[1] as AccumulatorInfo["mode"], maxPasses: Number(m[2]) } : null;
}

/** the CLI line for the accumulator: informational for float16, a warning
 *  for the 8-bit fallback, whose rounding shifts colours while the camera moves */
export function accumulatorLine(a: AccumulatorInfo): string {
  if (a.mode === "float16") return `[render] blur accumulator: float16 (up to ${a.maxPasses} passes)`;
  return (
    `[render] WARNING: this Chromium has no float16 canvas, so motion blur accumulates in 8 bits ` +
    `(up to ${a.maxPasses} passes; colours may shift by up to ${a.maxPasses / 2} levels while the camera moves)`
  );
}

const SKIP_WORDS: Record<SkipReason, string> = {
  "fills-viewport": "target fills the viewport",
  "page-just-opened": "too soon after the page opened",
  "page-changes-after": "page changes right after",
};

/** "framed 3 of 5 beats (skipped: 1 too soon after the page opened, 1 ...)" */
export function beatSummary(beats: BeatDecision[]): string {
  const framed = beats.filter((b) => b.framed).length;
  const counts = new Map<SkipReason, number>();
  for (const b of beats) if (!b.framed && b.reason) counts.set(b.reason, (counts.get(b.reason) ?? 0) + 1);
  const skipped = [...counts].map(([r, n]) => `${n} ${SKIP_WORDS[r]}`).join(", ");
  return `framed ${framed} of ${beats.length} beat${beats.length === 1 ? "" : "s"}` + (skipped ? ` (skipped: ${skipped})` : "");
}

/** "2 page changes (1 scene-reload, 1 navigation)" */
export function boundarySummary(boundaries: Boundary[]): string {
  const counts = new Map<BoundarySource, number>();
  for (const b of boundaries) counts.set(b.source, (counts.get(b.source) ?? 0) + 1);
  const n = boundaries.length;
  const parts = [...counts].map(([s, c]) => `${c} ${s}`).join(", ");
  return `${n} page change${n === 1 ? "" : "s"}` + (parts ? ` (${parts})` : "");
}

/** the one-line plan summary printed before the encode */
export function planSummaryLine(d: PlanDiagnostics): string {
  return `[render] plan: ${beatSummary(d.beats)}; ${boundarySummary(d.boundaries)}; ${(d.durationMs / 1000).toFixed(1)}s video`;
}

/** a loud warning when the measured video runs past the limit, else null */
export function overLimitWarning(durationMs: number, limitMs: number): string | null {
  if (durationMs <= limitMs) return null;
  return (
    `[render] WARNING: the video runs ${(durationMs / 1000).toFixed(1)}s, over the ${(limitMs / 1000).toFixed(0)}s limit. ` +
    `The recipe's length was an estimate; this is the measured take. Shorten actions or holds, or cut a scene, and re-record.`
  );
}

/** delivered bitrate as information: the encoder target is a ceiling, and
 *  mostly static screens legitimately encode far below it */
export function bitrateLine(deliveredBps: number, targetBps: number, durationS: number): string {
  return (
    `[render] delivered bitrate ${(deliveredBps / 1e6).toFixed(2)} Mbps over ${durationS.toFixed(1)}s ` +
    `(encoder ceiling ${(targetBps / 1e6).toFixed(0)} Mbps; static screens encode well below it)`
  );
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export interface RenderReportInput {
  takeDir: string;
  outFile: string;
  diagnostics: PlanDiagnostics;
  frames: number;
  fps: number;
  limitMs: number;
  source: { frames: number; avgFps: number; failedScenes: string[] };
}

export interface RenderReport {
  status: "planned" | "rendered" | "failed";
  error?: string;
  /** the generate run this render belongs to (director-report.json runId) */
  runId?: string;
  take: string;
  output: string;
  summary: string;
  video: { durationS: number; frames: number; fps: number; limitS: number; overLimit: boolean };
  source: { frames: number; avgFps: number; navigationLogged: boolean; failedScenes: string[] };
  boundaries: { source: BoundarySource; at: number; cut: boolean; wideBy: number; newPageAt: number }[];
  beats: {
    t: number;
    type: BeatDecision["type"];
    selector: string;
    target: BeatDecision["target"];
    framed: boolean;
    reason?: SkipReason;
    zoom?: number;
    shot?: [number, number];
  }[];
  accumulator: AccumulatorInfo | null;
  encode: { bytes: number; deliveredMbps: number; ceilingMbps: number } | null;
}

export function buildRenderReport(input: RenderReportInput): RenderReport {
  const d = input.diagnostics;
  const durationMs = (input.frames * 1000) / input.fps;
  return {
    status: "planned",
    take: input.takeDir,
    output: input.outFile,
    summary: `${beatSummary(d.beats)}; ${boundarySummary(d.boundaries)}`,
    video: {
      durationS: Math.round(durationMs) / 1000,
      frames: input.frames,
      fps: input.fps,
      limitS: input.limitMs / 1000,
      overLimit: durationMs > input.limitMs,
    },
    source: {
      frames: input.source.frames,
      avgFps: r1(input.source.avgFps),
      navigationLogged: d.navigationLogged,
      failedScenes: input.source.failedScenes,
    },
    boundaries: d.boundaries.map((b) => ({
      source: b.source,
      at: r1(b.at),
      cut: b.snap,
      wideBy: r1(b.out),
      newPageAt: r1(b.in),
    })),
    beats: d.beats.map((b) => ({
      t: r1(b.t),
      type: b.type,
      selector: b.selector,
      target: b.target,
      framed: b.framed,
      ...(b.reason ? { reason: b.reason } : {}),
      ...(b.z !== undefined ? { zoom: Math.round(b.z * 1000) / 1000 } : {}),
      ...(b.start !== undefined && b.end !== undefined ? { shot: [r1(b.start), r1(b.end)] as [number, number] } : {}),
    })),
    accumulator: null,
    encode: null,
  };
}
