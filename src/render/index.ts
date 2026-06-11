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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
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
  /** ms; encoding 60s of footage measured ~36s in the spike — 5 min is generous */
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

  const log = parseEventLog(JSON.parse(readFileSync(join(takeDir, "events.json"), "utf8")));
  const frameIndex = JSON.parse(
    readFileSync(join(takeDir, "frames-index.json"), "utf8"),
  ) as FrameIndexEntry[];

  // --bg: palette name, or a path to the user's own wallpaper image
  const bgSpec = opts.background ?? "aurora";
  const bgIsImage = existsSync(bgSpec) && statSync(bgSpec).isFile();
  const plan = buildRenderPlan(log, frameIndex, {
    background: bgIsImage
      ? { kind: "image", base: "#101010", blobs: [], light: true, vignette: 0.16 }
      : bgSpec,
  });
  const planJson = JSON.stringify(plan);

  let resultBuf: Buffer | null = null;
  let resolveResult!: () => void;
  const resultReceived = new Promise<void>((r) => (resolveResult = r));

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/host.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(HOST_PAGE);
    } else if (url === "/take/render-plan.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(planJson);
    } else if (url.startsWith("/take/frames/")) {
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
      const ext = bgSpec.toLowerCase();
      const mime = ext.endsWith(".png") ? "image/png" : ext.endsWith(".webp") ? "image/webp" : "image/jpeg";
      res.writeHead(200, { "content-type": mime });
      res.end(readFileSync(bgSpec));
    } else if (url === "/result" && req.method === "POST") {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        resultBuf = Buffer.concat(parts);
        res.writeHead(200);
        res.end("ok");
        resolveResult();
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  // full Chromium: the stripped headless shell has no WebCodecs (spike gotcha #2)
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
    await page.goto(`http://127.0.0.1:${port}/`);

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
          if (resultBuf) return;
        }
      })(),
    ]);
  } finally {
    await browser.close();
    server.close();
  }

  if (!resultBuf || (resultBuf as Buffer).length === 0) {
    throw new Error("render produced no encoded output");
  }
  const encoded: Buffer = resultBuf;

  // mux raw annexb H.264 → MP4. ffmpeg is a muxer here, never an effects engine.
  const rawPath = join(takeDir, "encoded.h264");
  writeFileSync(rawPath, encoded);
  // -r BEFORE -i: raw annexb has no timestamps; this assigns them at 60fps.
  // (-framerate alone misparses → 120fps/wrong duration, found 2026-06-11.)
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
    encodedBytes: encoded.length,
    wallMs: Date.now() - t0,
  };
}

export { buildRenderPlan, defaultLayout, SUBFRAMES } from "./plan.js";
export type { RenderPlan, Layout, FrameIndexEntry } from "./plan.js";
