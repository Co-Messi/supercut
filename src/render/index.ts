/**
 * Render orchestrator, stage 5 entry point.
 *
 *   takeDir (frames/ + events.json + frames-index.json)
 *      │
 *      ├─ gates: partial take, capture health, clock skew
 *      ├─ planTake (pure TS, plan.ts) → render-report.json beside the output
 *      ├─ localhost server: host page + take files, receives encoded stream
 *      ├─ full Chromium (channel "chromium"): draws plan, encodes H.264 annexb
 *      └─ ffmpeg as MUXER ONLY (-c copy) → final .mp4
 */
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import { MAX_BUDGET_MS, parseEventLog, type EventLog } from "../schema/index.js";
import { buildBackground, FADE_IN_MS, FADE_OUT_MS, planTake, validateFrameIndex, type FrameIndexEntry } from "./plan.js";
import { applyTakeAdjustments, hasAdjustments, type TakeAdjustments } from "./adjust.js";
import { removeOnExit } from "./temp.js";
import { chromiumInstallCommand } from "../capture/browser-install.js";
import { ENCODER_BITRATE, HOST_PAGE } from "./host-page.js";
import {
  accumulatorLine,
  bitrateLine,
  buildRenderReport,
  overLimitWarning,
  parseAccumulatorLine,
  planSummaryLine,
  type AccumulatorInfo,
  type RenderReport,
} from "./report.js";

const exec = promisify(execFile);

/** ffmpeg mux ceiling: video is stream-copied and audio is ≤60s + loudnorm, so
 *  a healthy mux finishes in seconds, a pathological input (stalling demuxer,
 *  zero-duration loop) must not hang the CLI at the last step of the pipeline */
const MUX_TIMEOUT_MS = 120_000;
/** headroom over the 1MB execFile default: unusually chatty ffmpeg stderr
 *  (loop + loudnorm diagnostics) must not kill a successful encode with
 *  ENOBUFS. Mirrors the buffer qc.ts already sets on its ffmpeg calls. */
const MUX_MAX_BUFFER = 16 * 1024 * 1024;

export interface RenderOptions {
  takeDir: string;
  outFile: string;
  /** palette name (aurora|midnight|dusk|paper) or a path to a wallpaper image */
  background?: string;
  /** bundled track name (assets/music/), a path to an audio file, or
   *  "off"/absent for a silent video (the default) */
  music?: string;
  /** ms; when unset, sized from the plan's frame count (≥5 min floor) so a
   *  long take's legitimately slow encode isn't killed by a flat ceiling */
  timeoutMs?: number;
  /** starts the render browser; defaults to full Chromium. A seam for tests
   *  and embedders (a custom executable, a remote browser). */
  launchBrowser?: () => Promise<Browser>;
  /** render a take whose events.json lists failed scenes (partial footage).
   *  Off by default; SUPERCUT_ALLOW_PARTIAL=1 opts in from the CLI. */
  allowPartial?: boolean;
  /** "8bit" forces the motion-blur accumulator's 8-bit fallback (diagnostics
   *  and tests); "auto" (the default) uses float16 where the browser has it */
  accumulator?: "auto" | "8bit";
  /** QC holds and zooms applied to the take before planning; the take on
   *  disk is not changed */
  adjust?: TakeAdjustments;
  /** the generate run this render belongs to, written into render-report.json */
  runId?: string;
}

export interface RenderResult {
  outFile: string;
  frames: number;
  /** output length in ms (frames at the plan fps) */
  durationMs: number;
  encodedBytes: number;
  wallMs: number;
  /** measured bits/second of the encoded stream (encodedBytes over plan duration) */
  deliveredBitrate: number;
  /** resolved audio track muxed under the video, or null for a silent cut */
  music: string | null;
  /** the motion-blur accumulator the host page used */
  accumulator: AccumulatorInfo | null;
  /** render-report.json beside the output */
  reportFile: string;
  /** "framed 5 of 6 beats; 1 page change (1 scene-reload)" */
  summary: string;
}

/**
 * Resolve --music: a bundled track name (fuzzy-matched against assets/music/,
 * same pattern as --bg), a path to the user's own audio file, or "off"/absent
 * → null. Throws with the available bundled names, validating here keeps a
 * bad track from ever reaching the expensive render.
 */
export function resolveMusicTrack(spec: string | undefined, musicDir?: string): string | null {
  // the off-sentinel matches like track names do: any case, surrounding space
  if (!spec || spec.trim().toLowerCase() === "off") return null;
  if (existsSync(spec) && statSync(spec).isFile()) return spec;
  const dir = musicDir ?? fileURLToPath(new URL("../../assets/music", import.meta.url));
  const requested = spec.toLowerCase().replace(/\.[a-z0-9]+$/, "");
  const bundled = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f)) : [];
  const hit = bundled.find((f) => {
    const lower = f.toLowerCase();
    return lower === spec.toLowerCase() || lower.replace(/\.[a-z0-9]+$/, "") === requested;
  });
  if (hit) return join(dir, hit);
  const names = bundled.map((f) => f.replace(/\.[a-z0-9]+$/i, ""));
  throw new Error(
    `--music "${spec}" is neither an audio file nor a bundled track, ` +
      (names.length ? `bundled tracks: ${names.join(", ")} (or "off")` : `no bundled tracks installed; pass an audio file path or "off"`),
  );
}

/** the bundled default stage: deep blue-violet waves carry far more contrast
 *  behind a white app window than the procedural pastels */
const DEFAULT_BACKGROUND = "cobalt";

/**
 * Resolve --bg: bundled wallpaper name (fuzzy-matched against
 * assets/backgrounds/, then assets/ root for muscle-memory), a procedural
 * palette name, a path to the user's own image, or nothing, which resolves
 * to the bundled cobalt wallpaper. When the bundled assets are missing (weird
 * install) the DEFAULT quietly falls back to the procedural "aurora" stage
 * rather than crashing; an explicit --bg still fails loud downstream.
 */
export function resolveBackgroundSpec(
  background: string | undefined,
  assetRoots?: string[],
): { spec: string; isImage: boolean } {
  const roots =
    assetRoots ??
    ["../../assets/backgrounds", "../../assets"].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
  let spec = background ?? DEFAULT_BACKGROUND;
  if (!existsSync(spec)) {
    const requested = spec.toLowerCase().replace(/\.[a-z0-9]+$/, "");
    for (const dir of roots) {
      if (!existsSync(dir)) continue;
      const hit = readdirSync(dir).find((f) => {
        const lower = f.toLowerCase();
        return lower === spec.toLowerCase() || lower.replace(/\.[a-z0-9]+$/, "") === requested;
      });
      if (hit) {
        spec = join(dir, hit);
        break;
      }
    }
  }
  const isImage = existsSync(spec) && statSync(spec).isFile();
  if (!isImage && background === undefined) return { spec: "aurora", isImage: false };
  return { spec, isImage };
}

/**
 * Fail now on a --bg that will fail at render time: an explicit name that is
 * neither an image file, a bundled wallpaper, nor a procedural palette. A
 * typo must die before the crawl, LLM and capture spend, not after them.
 */
export function assertBackground(background: string | undefined): void {
  if (background === undefined) return;
  const { spec, isImage } = resolveBackgroundSpec(background);
  if (!isImage) buildBackground(spec, 16, 9);
}

/** content type for a captured frame file. The recorder writes JPEG since
 *  the 60fps capture change; takes recorded before it hold PNG frames and
 *  must keep rendering. */
export function frameMimeType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/** the one command that fixes a missing render browser, pinned to the
 *  Playwright that will look for it */
const CHROMIUM_INSTALL_HINT = `run: ${chromiumInstallCommand()}`;

/**
 * A browser launch failure as a one-line, actionable error. Playwright's own
 * message for a missing executable is a multi-line banner; its first line
 * names the cause, the hint names the fix. Other launch failures (sandbox,
 * permissions) keep their cause and get the hint as a possibility only.
 */
export function launchFailure(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const first = msg.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "unknown error";
  const missing = /executable doesn't exist|no such file|ENOENT|playwright install/i.test(msg);
  const hint = missing
    ? `Chromium for rendering is not installed; ${CHROMIUM_INSTALL_HINT}`
    : `if Chromium for rendering is not installed, ${CHROMIUM_INSTALL_HINT}`;
  return new Error(`render: could not launch Chromium (${first}). ${hint}`);
}

/** gentle loudness normalization + edge fades (skipped on clips too short to
 *  fade without eating the whole track) */
export function musicFilterChain(durationS: number): string {
  const filters = ["loudnorm=I=-20:TP=-2:LRA=9"];
  if (durationS >= 2.5) {
    // the picture fades with the SAME lengths (plan.fade), so sound and
    // image open and close together
    const fin = FADE_IN_MS / 1000;
    const fout = FADE_OUT_MS / 1000;
    filters.push(`afade=t=in:st=0:d=${fin}`, `afade=t=out:st=${(durationS - fout).toFixed(3)}:d=${fout}`);
  }
  return filters.join(",");
}

export interface SkewVerdict {
  skewMs: number;
  maxEventT: number;
  lastFrameT: number;
  action: "ok" | "warn" | "fail";
}

/** residual event-vs-footage skew below this is invisible; above it the
 *  camera visibly leads the pixels (unified-clock takes only) */
const SKEW_FAIL_MS = 250;
/** legacy skew tolerance: pre-unified-clock takes stamped events on a
 *  separate wall accumulator; anything past this was already warn-worthy */
const SKEW_LEGACY_WARN_MS = 500;

/**
 * Clock-vs-frame skew gate. Unified-clock takes (the events.json carries
 * `t_source_unified: true`, the built-in recorder always writes it) stamp
 * events on the same timeline as frame `t_source`, so the event timeline
 * running well past the footage means the take is broken, fail. Legacy takes
 * (no marker) never unified their clocks, so skew is expected there and only
 * warns. Legacy-ness comes from the schema declaration, NEVER from inferring
 * it off the capture's frame rate: a starved capture must not be able to
 * reclassify itself as "legacy" and dodge the gate.
 */
export function assessSkew(log: EventLog, frameIndex: FrameIndexEntry[]): SkewVerdict {
  const lastFrameT = frameIndex.length ? frameIndex[frameIndex.length - 1]!.t_source : 0;
  let maxEventT = 0;
  for (const e of log.events) maxEventT = Math.max(maxEventT, e.t);
  const skewMs = maxEventT - lastFrameT;
  const legacy = log.t_source_unified !== true;
  let action: SkewVerdict["action"] = "ok";
  if (legacy) {
    if (skewMs > SKEW_LEGACY_WARN_MS) action = "warn";
  } else if (skewMs > SKEW_FAIL_MS) {
    action = "fail";
  }
  return { skewMs, maxEventT, lastFrameT, action };
}

export interface CaptureHealth {
  frames: number;
  /** take duration on the shared timeline: max(last frame t_source, last event t) */
  durationMs: number;
  /** duration × declared fps, what a healthy capture would have produced */
  expectedFrames: number;
  avgSourceFps: number;
  action: "ok" | "fail";
  reason?: string;
}

/** a take must carry at least this fraction of duration × fps in real frames.
 *  Healthy beacon-era captures sit near 1.0; a slow CI disk may throttle the
 *  ack-gated screencast well below 60fps, so the floor is deliberately
 *  generous, a starved capture (beacon dead, page static) sits under 0.01. */
const MIN_CAPTURE_RATIO = 0.2;
/** short takes produce few frames legitimately (startup jitter dominates);
 *  the ratio gate only engages once the take is long enough to judge */
const MIN_JUDGEABLE_MS = 2_000;
/** the longest stretch of take time with no frame at all. The built-in
 *  recorder's largest legitimate gap is a scene-entry navigation, bounded by
 *  its 10s action timeout plus a 2s load grace; anything longer is a capture
 *  that died partway (beacon lost after a navigation, rAF suspended) and would
 *  film as a long still, however healthy the frame count looks overall. */
const MAX_FRAME_GAP_MS = 15_000;

/**
 * Deterministic capture-health gate: did the capture actually capture?
 * Compares frames on disk against what the take's duration and declared fps
 * demand. This is the check the skew gate can't do, a capture that starved
 * (repaint beacon failed, page never committed frames) produces a "clean"
 * event timeline over almost no footage, and rendering it yields a slideshow
 * with a camera gliding over stills. That must be refused, not warned about.
 */
export function assessCaptureHealth(log: EventLog, frameIndex: FrameIndexEntry[]): CaptureHealth {
  // the index is only schema-validated later (buildRenderPlan); a NaN or
  // missing t_source here would make every duration NaN and every comparison
  // false, i.e. "ok". Refuse it outright.
  const badEntry = frameIndex.findIndex(
    (f) => typeof f?.t_source !== "number" || !Number.isFinite(f.t_source) || f.t_source < 0,
  );
  if (badEntry >= 0) {
    return {
      frames: frameIndex.length,
      durationMs: 0,
      expectedFrames: 0,
      avgSourceFps: 0,
      action: "fail",
      reason: `frames-index entry ${badEntry} has no valid t_source, the capture index is corrupt`,
    };
  }
  const lastFrameT = frameIndex.length ? frameIndex[frameIndex.length - 1]!.t_source : 0;
  let maxEventT = 0;
  for (const e of log.events) {
    maxEventT = Math.max(maxEventT, e.t);
    // a cursor_path container is stamped t=0 while its POINTS carry the real
    // timeline, and buildRenderPlan extends the output to the final point.
    // Judged off container `t` alone, a take whose only late timestamps are
    // cursor points would read as "under two seconds", skip the ratio gate
    // and render the held-stills slideshow this gate exists to refuse.
    // Points are schema-validated monotonic, so the last is the maximum.
    if (e.type === "cursor_path" && e.points.length > 0) {
      maxEventT = Math.max(maxEventT, e.points[e.points.length - 1]![0]);
    }
  }
  const durationMs = Math.max(lastFrameT, maxEventT);
  const expectedFrames = Math.round((durationMs / 1000) * log.fps);
  const avgSourceFps = durationMs > 0 ? (frameIndex.length / durationMs) * 1000 : 0;
  const health: CaptureHealth = {
    frames: frameIndex.length,
    durationMs,
    expectedFrames,
    avgSourceFps,
    action: "ok",
  };
  if (durationMs < MIN_JUDGEABLE_MS) return health;
  if (frameIndex.length < expectedFrames * MIN_CAPTURE_RATIO) {
    health.action = "fail";
    health.reason =
      `capture is sparse: ${frameIndex.length} frame(s) over ${(durationMs / 1000).toFixed(1)}s ` +
      `(avg ${avgSourceFps.toFixed(1)} fps source; a healthy ${log.fps}fps capture would carry ` +
      `~${expectedFrames}), the video would be stills with a camera gliding over them`;
    return health;
  }
  // coverage, not just count: the widest frameless stretch, including the
  // tail after the last frame (the index is sorted by t_source)
  let widestGap = 0;
  let gapAt = 0;
  let prev = 0;
  for (const f of [...frameIndex.map((e) => e.t_source), durationMs]) {
    if (f - prev > widestGap) {
      widestGap = f - prev;
      gapAt = prev;
    }
    prev = Math.max(prev, f);
  }
  if (widestGap > MAX_FRAME_GAP_MS) {
    health.action = "fail";
    health.reason =
      `capture has no frames for ${(widestGap / 1000).toFixed(1)}s (from ${(gapAt / 1000).toFixed(1)}s), ` +
      `the video would hold one still across that stretch`;
  }
  return health;
}

export async function renderTake(opts: RenderOptions): Promise<RenderResult> {
  const { takeDir, outFile } = opts;
  const t0 = Date.now();

  // Fail before expensive work: output dir + take shape.
  mkdirSync(dirname(outFile), { recursive: true });
  let log = parseEventLog(JSON.parse(readFileSync(join(takeDir, "events.json"), "utf8")));
  const rawIndex = JSON.parse(readFileSync(join(takeDir, "frames-index.json"), "utf8"));
  if (!Array.isArray(rawIndex)) throw new Error("frames-index.json is not an array");
  let frameIndex = rawIndex as FrameIndexEntry[]; // entries validated in buildRenderPlan
  if (hasAdjustments(opts.adjust)) {
    validateFrameIndex(frameIndex);
    const adjusted = applyTakeAdjustments(log, frameIndex, opts.adjust);
    log = parseEventLog(adjusted.log);
    frameIndex = adjusted.frameIndex;
    if (adjusted.applied.length) console.error(`[render] QC adjustments: ${adjusted.applied.join("; ")}`);
    for (const s of adjusted.skipped) console.error(`[render] QC adjustment skipped: ${s}`);
  }

  // Partial-take gate: the recorder lists the scenes it failed to perform.
  // Rendering such a take silently ships a video missing those beats.
  if (log.failed_scenes && log.failed_scenes.length > 0) {
    const names = log.failed_scenes.map((n) => JSON.stringify(n)).join(", ");
    const what = `the take is partial: scene(s) ${names} failed during capture, so the video would skip them`;
    if (opts.allowPartial || process.env.SUPERCUT_ALLOW_PARTIAL === "1") {
      console.error(`[render] WARNING: ${what} (continuing: SUPERCUT_ALLOW_PARTIAL=1)`);
    } else {
      throw new Error(
        `render: ${what}. Re-record the take, or set SUPERCUT_ALLOW_PARTIAL=1 to render the scenes that were filmed.`,
      );
    }
  }

  // Capture-health gate: refuse a take whose footage can't carry its own
  // timeline. Printed regardless of outcome so the one diagnostic that reveals
  // a starved capture, average source fps, is always on the record.
  const health = assessCaptureHealth(log, frameIndex);
  {
    console.error(
      `[render] capture health: ${health.frames} frames over ${(health.durationMs / 1000).toFixed(1)}s ` +
        `(avg ${health.avgSourceFps.toFixed(1)} fps source)`,
    );
    if (health.action === "fail") {
      if (process.env.SUPERCUT_ALLOW_SPARSE === "1") {
        console.error(`[render] WARNING: ${health.reason} (continuing: SUPERCUT_ALLOW_SPARSE=1)`);
      } else {
        throw new Error(
          `render: ${health.reason}. Re-record the take; for a genuinely sparse take ` +
            `(e.g. a pre-beacon recorder) set SUPERCUT_ALLOW_SPARSE=1 to render it anyway.`,
        );
      }
    }
  }

  const { spec: bgSpec, isImage: bgIsImage } = resolveBackgroundSpec(opts.background);
  // --music: resolved + validated here, before the plan and the browser, a
  // missing track must fail in milliseconds, not after a full encode
  const musicPath = resolveMusicTrack(opts.music);
  const { plan, diagnostics } = planTake(log, frameIndex, {
    background: bgIsImage
      ? { kind: "image", base: "#101010", blobs: [], light: true, vignette: 0.16 }
      : bgSpec,
  });
  const durationMs = (plan.frames * 1000) / plan.fps;

  const planJson = JSON.stringify(plan);

  // timeout sized from the work: the adaptive blur loop can reach dozens of
  // draw passes per frame, so a legitimately slow long render must not be
  // killed by a flat ceiling after all the capture/LLM spend that fed it.
  // 200ms/frame ≈ 12 min for a full 3600-frame take; 5 min stays the floor.
  const timeoutMs = opts.timeoutMs ?? Math.max(300_000, plan.frames * 200);

  // Clock-vs-frame skew gate (assessed in assessSkew, below).
  {
    const verdict = assessSkew(log, frameIndex);
    if (verdict.action !== "ok") {
      const msg =
        `event timeline leads footage by ${Math.round(verdict.skewMs)}ms ` +
        `(last event t=${Math.round(verdict.maxEventT)}ms, last frame t_source=${Math.round(verdict.lastFrameT)}ms), ` +
        `the camera would run ahead of the pixels`;
      if (verdict.action === "warn" || process.env.SUPERCUT_ALLOW_SKEW === "1") {
        console.error(`[render] WARNING: ${msg} (continuing)`);
      } else {
        throw new Error(`render: ${msg}. Re-record the take, or set SUPERCUT_ALLOW_SKEW=1 to force.`);
      }
    }
  }

  // The take passed every gate: say what the plan does with it, and put the
  // decisions on disk before the encode so a failed render still leaves them.
  // The 60s limit is checked on the MEASURED video. It is a warning, never a
  // trim: cutting the tail would end mid zoom-out or cut a payoff's dwell.
  console.error(planSummaryLine(diagnostics));
  const overLimit = overLimitWarning(durationMs, MAX_BUDGET_MS);
  if (overLimit) console.error(overLimit);
  const reportFile = join(dirname(outFile), "render-report.json");
  const report: RenderReport = buildRenderReport({
    takeDir,
    outFile,
    diagnostics,
    frames: plan.frames,
    fps: plan.fps,
    limitMs: MAX_BUDGET_MS,
    source: { frames: frameIndex.length, avgFps: health.avgSourceFps, failedScenes: log.failed_scenes ?? [] },
  });
  if (opts.runId) report.runId = opts.runId;
  const writeReport = (patch: Partial<RenderReport>): void => {
    Object.assign(report, patch);
    try {
      writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
    } catch (err) {
      // the report is diagnostics: never let it fail (or mask) a render
      console.error(`[render] could not write ${reportFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  writeReport({});

  const token = randomBytes(16).toString("hex");
  // the raw annexb H.264 goes to a temp path OUTSIDE the take dir: the take
  // is a read-only input, and a partial stream must never be left beside it.
  // The finally below unlinks it on success and on failure; an interrupt or
  // process.exit before then is covered by removeOnExit.
  const rawPath = join(tmpdir(), `supercut-${token}.h264`);
  const disposeTempCleanup = removeOnExit(rawPath);
  let encodedBytes = 0;
  let resultReady = false;
  let rejectResult!: (err: Error) => void;
  let resolveResult!: () => void;
  const resultReceived = new Promise<void>((r, rej) => { resolveResult = r; rejectResult = rej; });

  const server = createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
    const url = parsedUrl.pathname;
    // constant-time compare (length-checked: timingSafeEqual throws on a length
    // mismatch). Negligible value here, 128-bit per-run token, loopback-only,
    // but trivially correct.
    const tokenMatches = (got: string | string[] | undefined | null): boolean => {
      if (typeof got !== "string" || got.length !== token.length) return false;
      return timingSafeEqual(Buffer.from(got), Buffer.from(token));
    };
    const authorized =
      tokenMatches(parsedUrl.searchParams.get("t")) || tokenMatches(req.headers["x-render-token"]);
    const requireToken = (): boolean => {
      if (authorized) return true;
      res.writeHead(403);
      res.end();
      return false;
    };
    if (url === "/" || url === "/host.html") {
      // the host page is token-gated like every other route: our own browser
      // navigates to `/?t=${token}`, and no other local process may pull the
      // render harness page during a run
      if (!requireToken()) return;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(HOST_PAGE);
    } else if (url === "/take/render-plan.json") {
      if (!requireToken()) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(planJson);
    } else if (url.startsWith("/take/frames/")) {
      if (!requireToken()) return;
      try {
        const name = url.slice("/take/frames/".length).replace(/[^0-9a-zA-Z._-]/g, "");
        const buf = readFileSync(join(takeDir, "frames", name));
        res.writeHead(200, { "content-type": frameMimeType(name) });
        res.end(buf);
      } catch {
        res.writeHead(404);
        res.end();
      }
    } else if (url === "/take/bg" && bgIsImage) {
      if (!requireToken()) return;
      const ext = bgSpec.toLowerCase();
      const mime = ext.endsWith(".png") ? "image/png" : ext.endsWith(".webp") ? "image/webp" : "image/jpeg";
      res.writeHead(200, { "content-type": mime });
      res.end(readFileSync(bgSpec));
    } else if (url === "/result" && req.method === "POST") {
      // only OUR page may deliver the result (token minted per render),
      // and a runaway encoder can't OOM Node (size cap)
      if (!requireToken()) return;
      // coarse OOM backstop: a runaway or looping encoder can't grow the
      // result stream past this while it streams to disk. Pairs with the
      // in-page MAX_ENCODED_BYTES cap and the ENCODER_BITRATE ceiling.
      const MAX_RESULT_BYTES = 1.5e9;
      let received = 0;
      const sizeLimiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > MAX_RESULT_BYTES) {
            callback(new Error("encoded result exceeds 1.5GB cap"));
            return;
          }
          callback(null, chunk);
        }
      });
      pipeline(req, sizeLimiter, createWriteStream(rawPath))
        .then(() => {
          encodedBytes = received;
          resultReady = true;
          res.writeHead(200);
          res.end("ok");
          resolveResult();
        })
        .catch((err) => {
          const e = err instanceof Error ? err : new Error(String(err));
          res.writeHead(500);
          res.end(e.message);
          rejectResult(e);
        });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  // Full Chromium: the stripped headless shell has no WebCodecs.
  const launch = opts.launchBrowser ?? (() => chromium.launch({ headless: true, channel: "chromium" }));
  let browser: Browser | undefined;
  // The CLI exits via process.exitCode (never process.exit(), which can
  // truncate piped stdout), so anything still holding the event loop after
  // the render settles keeps the process alive: the listening server, the
  // watchdog timeout and the fatal-poll loop below. The inner finally owns
  // all three, and everything from the browser launch on runs inside it, so
  // every exit path (launch failure, success, timeout, in-page FATAL,
  // result-stream failure) releases them.
  let watchdog: NodeJS.Timeout | undefined;
  let raceSettled = false;
  let accumulator: AccumulatorInfo | null = null;
  // the outer try wraps the encode + mux so the temp raw file is unlinked on
  // every exit path, including an ffmpeg mux failure
  try {
    try {
      try {
        browser = await launch();
      } catch (err) {
        throw launchFailure(err);
      }
      const page = await browser.newPage();
      let fatal: string | null = null;
      page.on("console", (msg) => {
        const text = msg.text();
        if (text.startsWith("[render]")) {
          const acc = parseAccumulatorLine(text);
          if (acc) {
            // the 8-bit fallback changes the picture: it belongs in the CLI
            // log, not only in the headless page's console
            accumulator = acc;
            console.error(accumulatorLine(acc));
          } else if (text.includes("FATAL")) fatal = text;
          else if (process.env.SUPERCUT_VERBOSE) console.log(text);
        }
      });
      // a hard tab death (OOM, GPU process crash) emits no console line at
      // all, without these hooks the orchestrator waited out the full render
      // timeout for a page that could never answer
      page.on("crash", () => {
        fatal = "[render] FATAL: renderer tab crashed (out of memory or GPU process death)";
      });
      page.on("pageerror", (err) => {
        if (!fatal) fatal = `[render] FATAL: uncaught in-page error: ${err.message}`;
      });
      await page.goto(`http://127.0.0.1:${port}/?t=${token}${opts.accumulator === "8bit" ? "&accum=8bit" : ""}`);

      await Promise.race([
        resultReceived,
        new Promise<never>((_, rej) => {
          watchdog = setTimeout(() => rej(new Error(`render timed out after ${timeoutMs}ms${fatal ? ` (${fatal})` : ""}`)), timeoutMs);
        }),
        (async () => {
          // poll for an in-page fatal so we fail fast instead of waiting out
          // the timeout. The sleep timer is unref'd and the loop watches
          // raceSettled: when the race settles some OTHER way (watchdog fired,
          // result stream errored) the loop must stop too, or its 500ms ticks
          // keep the drained process alive forever on the failure path.
          for (;;) {
            await new Promise((r) => setTimeout(r, 500).unref());
            if (raceSettled) return;
            if (fatal) throw new Error(fatal);
            if (resultReady) return;
          }
        })(),
      ]);
    } finally {
      // stop the watchdog + poll loop first: any timer that survives this
      // block outlives the render and blocks natural process exit
      raceSettled = true;
      clearTimeout(watchdog);
      // a failing browser.close() must not skip server.close(), or the
      // loopback render server holds its port until process exit
      await browser?.close().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }

    if (!resultReady || encodedBytes === 0) {
      throw new Error("render produced no encoded output");
    }

    // mux raw annexb H.264 → MP4. ffmpeg is a muxer here, never an effects
    // engine (video is ALWAYS -c:v copy; music only touches the audio lane).
    // -r BEFORE -i: raw annexb has no timestamps; this assigns them at 60fps.
    // (-framerate alone can misparse to the wrong duration.)
    const muxDurationS = plan.frames / plan.fps;
    const muxArgs = ["-y", "-f", "h264", "-r", String(plan.fps), "-i", rawPath];
    if (musicPath) {
      muxArgs.push(
        // loop a short track under a long video; -t clamps the OUTPUT to the
        // exact video length so audio can never extend the cut.
        // resolve(): a relative path starting with "-" (a file literally named
        // "-loglevel") would otherwise be parsed by ffmpeg as an option.
        "-stream_loop", "-1",
        "-i", resolve(musicPath),
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-af", musicFilterChain(muxDurationS),
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
        "-t", muxDurationS.toFixed(3),
      );
    } else {
      muxArgs.push("-c", "copy");
    }
    muxArgs.push("-movflags", "+faststart", resolve(outFile));
    await exec("ffmpeg", muxArgs, { timeout: MUX_TIMEOUT_MS, maxBuffer: MUX_MAX_BUFFER });
    if (musicPath) console.error(`[render] music: ${musicPath}`);

    // the encoder is asked for ENCODER_BITRATE, which WebCodecs treats as a
    // ceiling: screen content that barely changes (a static page, a held
    // shot) needs few bits and legitimately encodes far below it. Without a
    // content measure the delivered rate cannot tell starvation from a calm
    // video, so it is reported as information, never as a warning.
    const durationS = plan.frames / plan.fps;
    const deliveredBitrate = Math.round((encodedBytes * 8) / durationS);
    console.error(bitrateLine(deliveredBitrate, ENCODER_BITRATE, durationS));

    writeReport({
      status: "rendered",
      accumulator,
      encode: {
        bytes: encodedBytes,
        deliveredMbps: Math.round(deliveredBitrate / 1e4) / 100,
        ceilingMbps: ENCODER_BITRATE / 1e6,
      },
    });
    console.error(`[render] report: ${reportFile}`);

    return {
      outFile,
      frames: plan.frames,
      durationMs,
      encodedBytes,
      wallMs: Date.now() - t0,
      deliveredBitrate,
      music: musicPath,
      accumulator,
      reportFile,
      summary: report.summary,
    };
  } catch (err) {
    writeReport({ status: "failed", error: err instanceof Error ? err.message : String(err), accumulator });
    throw err;
  } finally {
    // always remove the temp raw stream, on success or failure; guarded so
    // cleanup never masks the real error (the file may never have been written)
    try {
      unlinkSync(rawPath);
    } catch {
      /* already removed or never written, nothing to clean up */
    }
    disposeTempCleanup();
  }
}

export { buildRenderPlan, defaultLayout, planTake, SUBFRAMES } from "./plan.js";
export type { RenderPlan, Layout, FrameIndexEntry, PlanDiagnostics } from "./plan.js";
export type { AccumulatorInfo, RenderReport } from "./report.js";
