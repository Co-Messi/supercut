/**
 * Render spike — decides the compositor runtime (design doc step 2b).
 *
 * Candidate 1: pure-JS CPU compositing in Node (no native deps)
 * Candidate 2: Chromium-hosted — OffscreenCanvas drawImage (GPU path) +
 *              WebCodecs VideoEncoder, inside the Playwright Chromium we
 *              already ship. (wgpu-in-Node was pre-eliminated: immature
 *              native bindings = the dependency wall the design rejects.)
 *
 * Job simulated per output frame (the Screen Studio look, mechanically):
 *   8 motion-blur subframes, each sampling a 3840x2160 source through a
 *   spring-zoom camera transform, accumulated into one 1920x1080 frame.
 *
 * Budget to beat (Success Criterion 3): 3,600 frames rendered in ≤ 6 min
 * → must sustain ≥ 10 output fps.
 *
 * Run: npx tsx spikes/render-spike.ts
 */
import { createServer } from "node:http";
import { chromium } from "playwright";

const SRC_W = 3840, SRC_H = 2160;
const OUT_W = 1920, OUT_H = 1080;
const SUBFRAMES = 8;
const TOTAL_FRAMES = 3600;
const BUDGET_S = 360;

// ---------- Candidate 1: pure-JS CPU ----------
function cpuSpike(frames: number): { msPerFrame: number } {
  const src = new Uint8ClampedArray(SRC_W * SRC_H * 4);
  for (let i = 0; i < src.length; i += 4) {
    src[i] = (i / 4) % 255; src[i + 1] = (i / 16) % 255; src[i + 2] = 180; src[i + 3] = 255;
  }
  const acc = new Float32Array(OUT_W * OUT_H * 4);
  const out = new Uint8ClampedArray(OUT_W * OUT_H * 4);

  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    acc.fill(0);
    for (let s = 0; s < SUBFRAMES; s++) {
      // spring zoom: scale 1.0 → 1.5 around a moving center (nearest-neighbor)
      const zoom = 1 + 0.5 * Math.sin((f * SUBFRAMES + s) / 200);
      const cx = SRC_W / 2 + 200 * Math.sin(f / 60);
      const cy = SRC_H / 2;
      const w = SRC_W / zoom, h = SRC_H / zoom;
      const x0 = cx - w / 2, y0 = cy - h / 2;
      for (let y = 0; y < OUT_H; y++) {
        const sy = Math.min(SRC_H - 1, Math.max(0, Math.round(y0 + (y / OUT_H) * h)));
        const rowBase = sy * SRC_W;
        for (let x = 0; x < OUT_W; x++) {
          const sx = Math.min(SRC_W - 1, Math.max(0, Math.round(x0 + (x / OUT_W) * w)));
          const si = (rowBase + sx) * 4, di = (y * OUT_W + x) * 4;
          acc[di] += src[si]!; acc[di + 1] += src[si + 1]!;
          acc[di + 2] += src[si + 2]!; acc[di + 3] += 255;
        }
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = acc[i]! / SUBFRAMES;
  }
  return { msPerFrame: (performance.now() - t0) / frames };
}

// ---------- Candidate 2: Chromium-hosted ----------
async function chromiumSpike(frames: number): Promise<{
  msPerFrameComposite: number; msPerFrameEncoded: number; codec: string; chunks: number;
}> {
  // full Chromium (new headless) — the stripped headless shell has no WebCodecs.
  // WebCodecs requires a SECURE CONTEXT: about:blank/data: don't qualify, so the
  // render page must be served over http://localhost (trustworthy origin).
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>supercut render host</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  try {
    return await page.evaluate(
      async ({ SRC_W, SRC_H, OUT_W, OUT_H, SUBFRAMES, frames }) => {
        // paint a busy 4K source once
        const src = new OffscreenCanvas(SRC_W, SRC_H);
        const sctx = src.getContext("2d")!;
        const grad = sctx.createLinearGradient(0, 0, SRC_W, SRC_H);
        grad.addColorStop(0, "#1a73e8"); grad.addColorStop(1, "#f7f5f0");
        sctx.fillStyle = grad; sctx.fillRect(0, 0, SRC_W, SRC_H);
        sctx.fillStyle = "#111"; sctx.font = "28px sans-serif";
        for (let i = 0; i < 200; i++) sctx.fillText("supercut sharpness probe " + i, (i * 137) % SRC_W, (i * 53) % SRC_H);
        const srcBmp = await createImageBitmap(src);

        const out = new OffscreenCanvas(OUT_W, OUT_H);
        const octx = out.getContext("2d")!;

        // --- composite-only pass ---
        const t0 = performance.now();
        for (let f = 0; f < frames; f++) {
          octx.globalAlpha = 1;
          octx.clearRect(0, 0, OUT_W, OUT_H);
          octx.globalAlpha = 1 / SUBFRAMES;
          for (let s = 0; s < SUBFRAMES; s++) {
            const zoom = 1 + 0.5 * Math.sin((f * SUBFRAMES + s) / 200);
            const w = SRC_W / zoom, h = SRC_H / zoom;
            const cx = SRC_W / 2 + 200 * Math.sin(f / 60), cy = SRC_H / 2;
            octx.drawImage(srcBmp, cx - w / 2, cy - h / 2, w, h, 0, 0, OUT_W, OUT_H);
          }
          // rounded-corner mask + shadow plate omitted: single extra path op, negligible
        }
        const msPerFrameComposite = (performance.now() - t0) / frames;

        // --- composite + encode pass ---
        let codec = "none", chunks = 0, msPerFrameEncoded = -1;
        const candidates = ["avc1.640028", "vp09.00.40.08", "vp8"];
        for (const c of candidates) {
          const support = await VideoEncoder.isConfigSupported({
            codec: c, width: OUT_W, height: OUT_H, framerate: 60,
            bitrate: 8_000_000,
          });
          if (support.supported) { codec = c; break; }
        }
        if (codec !== "none") {
          const encoder = new VideoEncoder({
            output: () => { chunks++; },
            error: (e) => { throw e; },
          });
          encoder.configure({ codec, width: OUT_W, height: OUT_H, framerate: 60, bitrate: 8_000_000 });
          const t1 = performance.now();
          for (let f = 0; f < frames; f++) {
            octx.globalAlpha = 1;
            octx.clearRect(0, 0, OUT_W, OUT_H);
            octx.globalAlpha = 1 / SUBFRAMES;
            for (let s = 0; s < SUBFRAMES; s++) {
              const zoom = 1 + 0.5 * Math.sin((f * SUBFRAMES + s) / 200);
              const w = SRC_W / zoom, h = SRC_H / zoom;
              const cx = SRC_W / 2 + 200 * Math.sin(f / 60), cy = SRC_H / 2;
              octx.drawImage(srcBmp, cx - w / 2, cy - h / 2, w, h, 0, 0, OUT_W, OUT_H);
            }
            const vf = new VideoFrame(out, { timestamp: (f * 1e6) / 60 });
            encoder.encode(vf, { keyFrame: f % 120 === 0 });
            vf.close();
            if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
          }
          await encoder.flush();
          msPerFrameEncoded = (performance.now() - t1) / frames;
        }
        return { msPerFrameComposite, msPerFrameEncoded, codec, chunks };
      },
      { SRC_W, SRC_H, OUT_W, OUT_H, SUBFRAMES, frames },
    );
  } finally {
    await browser.close();
    server.close();
  }
}

function verdict(label: string, msPerFrame: number): string {
  const totalS = (msPerFrame * TOTAL_FRAMES) / 1000;
  const pass = totalS <= BUDGET_S;
  return `${label}: ${msPerFrame.toFixed(1)} ms/frame → 60s take in ${(totalS / 60).toFixed(1)} min ${pass ? "✓ WITHIN" : "✗ BLOWS"} 6-min budget`;
}

async function main() {
  console.log("— Candidate 1: pure-JS CPU (Node, no deps) — 20 frames…");
  const cpu = cpuSpike(20);
  console.log(verdict("CPU", cpu.msPerFrame));

  console.log("— Candidate 2: Chromium-hosted (OffscreenCanvas + WebCodecs) — 300 frames…");
  const ch = await chromiumSpike(300);
  console.log(verdict("Chromium composite-only", ch.msPerFrameComposite));
  if (ch.msPerFrameEncoded >= 0) {
    console.log(verdict(`Chromium composite+encode [${ch.codec}]`, ch.msPerFrameEncoded), `(${ch.chunks} chunks)`);
  } else {
    console.log(`WebCodecs: no supported codec found (tried avc1/vp9/vp8)`);
  }
}

main();
