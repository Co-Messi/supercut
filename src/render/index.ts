/**
 * Render orchestrator — stage 5 entry point.
 *
 *   takeDir (frames/ + events.json + frames-index.json)
 *      │
 *      ├─ buildRenderPlan (pure TS — plan.ts)
 *      ├─ localhost server: host page + take files, receives encoded stream
 *      ├─ full Chromium (channel "chromium"): draws plan, encodes H.264 annexb
 *      └─ ffmpeg as MUXER ONLY (-c copy) → final .mp4
 */
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { parseEventLog, type EventLog } from "../schema/index.js";
import { buildRenderPlan, type FrameIndexEntry } from "./plan.js";
import { ENCODER_BITRATE, HOST_PAGE } from "./host-page.js";

const exec = promisify(execFile);

export interface RenderOptions {
  takeDir: string;
  outFile: string;
  /** palette name (aurora|midnight|dusk|paper) or a path to a wallpaper image */
  background?: string;
  /** bundled track name (assets/music/), a path to an audio file, or
   *  "off"/absent for a silent video (the default) */
  music?: string;
  /** ms; encoding 60s of footage is expected to finish well within 5 min */
  timeoutMs?: number;
}

export interface RenderResult {
  outFile: string;
  frames: number;
  encodedBytes: number;
  wallMs: number;
  /** measured bits/second of the encoded stream (encodedBytes over plan duration) */
  deliveredBitrate: number;
  /** resolved audio track muxed under the video, or null for a silent cut */
  music: string | null;
}

/**
 * Resolve --music: a bundled track name (fuzzy-matched against assets/music/,
 * same pattern as --bg), a path to the user's own audio file, or "off"/absent
 * → null. Throws with the available bundled names — validating here keeps a
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
    `--music "${spec}" is neither an audio file nor a bundled track — ` +
      (names.length ? `bundled tracks: ${names.join(", ")} (or "off")` : `no bundled tracks installed; pass an audio file path or "off"`),
  );
}

/** the bundled default stage: deep blue-violet waves carry far more contrast
 *  behind a white app window than the procedural pastels */
const DEFAULT_BACKGROUND = "cobalt";

/**
 * Resolve --bg: bundled wallpaper name (fuzzy-matched against
 * assets/backgrounds/, then assets/ root for muscle-memory), a procedural
 * palette name, a path to the user's own image — or nothing, which resolves
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

/** gentle loudness normalization + edge fades (skipped on clips too short to
 *  fade without eating the whole track) */
export function musicFilterChain(durationS: number): string {
  const filters = ["loudnorm=I=-20:TP=-2:LRA=9"];
  if (durationS >= 2.5) {
    filters.push("afade=t=in:st=0:d=0.6", `afade=t=out:st=${(durationS - 1.8).toFixed(3)}:d=1.8`);
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
/** takes below this average source fps predate the repaint beacon (change-
 *  driven capture) — their event clock was never unified with t_source, so
 *  large skew is expected and must stay renderable (events.json back-compat) */
const LEGACY_FPS_CEILING = 20;

/**
 * Clock-vs-frame skew gate. Unified-clock takes stamp events on the same
 * timeline as frame `t_source` (anchored to the first screencast frame), so
 * the event timeline running well past the footage means the take is broken —
 * fail. Legacy sparse takes keep the old non-fatal warning.
 */
export function assessSkew(log: EventLog, frameIndex: FrameIndexEntry[]): SkewVerdict {
  const lastFrameT = frameIndex.length ? frameIndex[frameIndex.length - 1]!.t_source : 0;
  const firstFrameT = frameIndex.length ? frameIndex[0]!.t_source : 0;
  let maxEventT = 0;
  for (const e of log.events) maxEventT = Math.max(maxEventT, e.t);
  const skewMs = maxEventT - lastFrameT;
  const spanMs = lastFrameT - firstFrameT;
  const avgFps = spanMs > 0 ? ((frameIndex.length - 1) / spanMs) * 1000 : 0;
  const legacy = avgFps < LEGACY_FPS_CEILING;
  let action: SkewVerdict["action"] = "ok";
  if (legacy) {
    if (skewMs > SKEW_LEGACY_WARN_MS) action = "warn";
  } else if (skewMs > SKEW_FAIL_MS) {
    action = "fail";
  }
  return { skewMs, maxEventT, lastFrameT, action };
}

export async function renderTake(opts: RenderOptions): Promise<RenderResult> {
  const { takeDir, outFile } = opts;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const t0 = Date.now();

  // Fail before expensive work: output dir + take shape.
  mkdirSync(dirname(outFile), { recursive: true });
  const log = parseEventLog(JSON.parse(readFileSync(join(takeDir, "events.json"), "utf8")));
  const rawIndex = JSON.parse(readFileSync(join(takeDir, "frames-index.json"), "utf8"));
  if (!Array.isArray(rawIndex)) throw new Error("frames-index.json is not an array");
  const frameIndex = rawIndex as FrameIndexEntry[]; // entries validated in buildRenderPlan

  const { spec: bgSpec, isImage: bgIsImage } = resolveBackgroundSpec(opts.background);
  // --music: resolved + validated here, before the plan and the browser — a
  // missing track must fail in milliseconds, not after a full encode
  const musicPath = resolveMusicTrack(opts.music);
  const plan = buildRenderPlan(log, frameIndex, {
    background: bgIsImage
      ? { kind: "image", base: "#101010", blobs: [], light: true, vignette: 0.16 }
      : bgSpec,
  });

  const planJson = JSON.stringify(plan);

  // Clock-vs-frame skew gate (assessed in assessSkew, below).
  {
    const verdict = assessSkew(log, frameIndex);
    if (verdict.action !== "ok") {
      const msg =
        `event timeline leads footage by ${Math.round(verdict.skewMs)}ms ` +
        `(last event t=${Math.round(verdict.maxEventT)}ms, last frame t_source=${Math.round(verdict.lastFrameT)}ms) — ` +
        `the camera would run ahead of the pixels`;
      if (verdict.action === "warn" || process.env.SUPERCUT_ALLOW_SKEW === "1") {
        console.error(`[render] WARNING: ${msg} (continuing)`);
      } else {
        throw new Error(`render: ${msg}. Re-record the take, or set SUPERCUT_ALLOW_SKEW=1 to force.`);
      }
    }
  }

  const token = randomBytes(16).toString("hex");
  // B2 (review): write the raw annexb H.264 to a temp path OUTSIDE the take dir.
  // Writing into takeDir mutated a read-only input and left a stale/partial
  // `encoded.h264` behind on failure. The temp file is unlinked in `finally`
  // below so it is removed on BOTH success and failure; the take dir stays
  // read-only.
  const rawPath = join(tmpdir(), `supercut-${token}.h264`);
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
    // mismatch). Negligible value here — 128-bit per-run token, loopback-only —
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
      // B1 (review): the host page is token-gated like every other route. Our
      // own browser navigates to `/?t=${token}` (below), so the token is present
      // on the legitimate request; serving HOST_PAGE unauthenticated let any
      // local process pull the render harness page during a run.
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
        res.writeHead(200, { "content-type": "image/png" });
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
      // B3 (review): coarse OOM backstop — a runaway/looping encoder can't grow
      // the result stream past this and exhaust Node's memory while we buffer it
      // to disk. Pairs with the in-page MAX_ENCODED_BYTES cap and the lowered
      // default bitrate.
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
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  // B2 (review): outer try wraps the encode + mux so the temp raw file is
  // unlinked on EVERY exit path — render timeout, in-page FATAL, "no encoded
  // output", or an ffmpeg mux failure all flow through the finally below.
  try {
    try {
      const page = await browser.newPage();
      let fatal: string | null = null;
      page.on("console", (msg) => {
        const text = msg.text();
        if (text.startsWith("[render]")) {
          if (text.includes("FATAL")) fatal = text;
          else if (process.env.SUPERCUT_VERBOSE) console.log(text);
        }
      });
      await page.goto(`http://127.0.0.1:${port}/?t=${token}`);

      await Promise.race([
        resultReceived,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`render timed out after ${timeoutMs}ms${fatal ? ` (${fatal})` : ""}`)), timeoutMs),
        ),
        (async () => {
          // poll for an in-page fatal so we fail fast instead of waiting out the timeout
          for (;;) {
            await new Promise((r) => setTimeout(r, 500));
            if (fatal) throw new Error(fatal);
            if (resultReady) return;
          }
        })(),
      ]);
    } finally {
      // guard close: if browser.close() throws, server.close() must still run,
      // else the loopback render server leaks the port until process exit.
      await browser.close().catch(() => {});
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
        // exact video length so audio can never extend the cut
        "-stream_loop", "-1",
        "-i", musicPath,
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
    muxArgs.push("-movflags", "+faststart", outFile);
    await exec("ffmpeg", muxArgs);
    if (musicPath) console.error(`[render] music: ${musicPath}`);

    // trust, then verify: the encoder is ASKED for CBR at ENCODER_BITRATE, but
    // WebCodecs implementations may deliver far less. Healthy encoders undershoot
    // on low-motion screen content (static frames simply need few bits), so only
    // severe starvation — the regime where text goes mushy — earns a warning.
    const durationS = plan.frames / plan.fps;
    const deliveredBitrate = Math.round((encodedBytes * 8) / durationS);
    console.error(
      `[render] delivered bitrate ${(deliveredBitrate / 1e6).toFixed(2)} Mbps ` +
        `(configured ${(ENCODER_BITRATE / 1e6).toFixed(0)} Mbps CBR, ${durationS.toFixed(1)}s)`,
    );
    if (deliveredBitrate < ENCODER_BITRATE * 0.25) {
      console.error(
        `[render] WARNING: delivered bitrate is below 25% of the configured target — ` +
          `the encoder is starving the stream; text/detail quality may suffer`,
      );
    }

    return {
      outFile,
      frames: plan.frames,
      encodedBytes,
      wallMs: Date.now() - t0,
      deliveredBitrate,
      music: musicPath,
    };
  } finally {
    // B2 (review): always remove the temp raw stream — success or failure.
    // Guarded so cleanup never masks the real error (e.g. file already gone).
    try {
      unlinkSync(rawPath);
    } catch {
      /* already removed or never written — nothing to clean up */
    }
  }
}

export { buildRenderPlan, defaultLayout, SUBFRAMES } from "./plan.js";
export type { RenderPlan, Layout, FrameIndexEntry } from "./plan.js";
