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
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { parseEventLog } from "../schema/index.js";
import { buildRenderPlan, type FrameIndexEntry } from "./plan.js";
import { HOST_PAGE } from "./host-page.js";

const exec = promisify(execFile);

export interface RenderOptions {
  takeDir: string;
  outFile: string;
  /** palette name (aurora|midnight|dusk|paper) or a path to a wallpaper image */
  background?: string;
  /** ms; encoding 60s of footage is expected to finish well within 5 min */
  timeoutMs?: number;
}

export interface RenderResult {
  outFile: string;
  frames: number;
  encodedBytes: number;
  wallMs: number;
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

  // --bg: palette name, a bundled asset name (fuzzy-matched against assets/),
  // or a path to the user's own wallpaper image
  let bgSpec = opts.background ?? "aurora";
  if (!existsSync(bgSpec)) {
    const assetsDir = fileURLToPath(new URL("../../assets", import.meta.url));
    if (existsSync(assetsDir)) {
      const requested = bgSpec.toLowerCase().replace(/\.[a-z0-9]+$/, "");
      const hit = readdirSync(assetsDir).find((f) => {
        const lower = f.toLowerCase();
        return lower === bgSpec.toLowerCase() || lower.replace(/\.[a-z0-9]+$/, "") === requested;
      });
      if (hit) bgSpec = join(assetsDir, hit);
    }
  }
  const bgIsImage = existsSync(bgSpec) && statSync(bgSpec).isFile();
  const plan = buildRenderPlan(log, frameIndex, {
    background: bgIsImage
      ? { kind: "image", base: "#101010", blobs: [], light: true, vignette: 0.16 }
      : bgSpec,
  });
  const planJson = JSON.stringify(plan);

  const token = randomBytes(16).toString("hex");
  const rawPath = join(takeDir, "encoded.h264");
  let encodedBytes = 0;
  let resultReady = false;
  let rejectResult!: (err: Error) => void;
  let resolveResult!: () => void;
  const resultReceived = new Promise<void>((r, rej) => { resolveResult = r; rejectResult = rej; });

  const server = createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
    const url = parsedUrl.pathname;
    const authorized = parsedUrl.searchParams.get("t") === token || req.headers["x-render-token"] === token;
    const requireToken = (): boolean => {
      if (authorized) return true;
      res.writeHead(403);
      res.end();
      return false;
    };
    if (url === "/" || url === "/host.html") {
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
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }

  if (!resultReady || encodedBytes === 0) {
    throw new Error("render produced no encoded output");
  }

  // mux raw annexb H.264 → MP4. ffmpeg is a muxer here, never an effects engine.
  // -r BEFORE -i: raw annexb has no timestamps; this assigns them at 60fps.
  // (-framerate alone can misparse to the wrong duration.)
  await exec("ffmpeg", [
    "-y",
    "-f", "h264",
    "-r", String(plan.fps),
    "-i", rawPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outFile,
  ]);

  return {
    outFile,
    frames: plan.frames,
    encodedBytes,
    wallMs: Date.now() - t0,
  };
}

export { buildRenderPlan, defaultLayout, SUBFRAMES } from "./plan.js";
export type { RenderPlan, Layout, FrameIndexEntry } from "./plan.js";
