/**
 * Capture spike — decides the primary filming mechanism (design doc step 2a).
 *
 * Candidate A: CDP Page.startScreencast (event-driven, ack-throttled JPEG/PNG)
 * Candidate B: HeadlessExperimental.beginFrame + virtual time (frame-stepped PNG)
 *
 * Measures, per candidate, on an animated 1920x1080@2x page:
 *   - achieved frame rate vs the 60fps target
 *   - frame payload size (disk footprint extrapolated to a 60s take)
 *   - wall-clock cost (extrapolated to a 60s take)
 *   - frame-interval jitter (screencast) / determinism (beginFrame)
 *
 * Run: npx tsx spikes/capture-spike.ts
 * Writes: spikes/out/capture-{A,B}-sample.{jpeg,png} + console report.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type CDPSession, type Page } from "playwright";

const VIEWPORT = { width: 1920, height: 1080 };
const DPR = 2;
const SAMPLE_SECONDS = 8;
const TAKE_SECONDS = 60;

const TEST_PAGE = `<!doctype html><html><head><style>
  body { margin:0; font-family:-apple-system,sans-serif; background:#f7f5f0; overflow:hidden }
  #box { width:240px; height:140px; background:#1a73e8; border-radius:12px;
         position:absolute; top:300px; box-shadow:0 8px 30px rgba(0,0,0,.25);
         color:#fff; padding:18px; font-size:15px }
  #fine { position:absolute; top:560px; left:40px; font-size:11px; color:#333; width:900px }
  #clock { position:absolute; top:40px; left:40px; font-size:42px; font-variant-numeric:tabular-nums }
</style></head><body>
  <div id="clock">0</div>
  <div id="box">sharpness probe — the quick brown fox 0123456789</div>
  <div id="fine">${"antialiased 11px text for sharpness comparison · ".repeat(8)}</div>
  <script>
    let f = 0;
    function tick() {
      f++;
      document.getElementById("clock").textContent = String(f);
      document.getElementById("box").style.left = (200 + Math.sin(f/30)*400) + "px";
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  </script>
</body></html>`;

interface Result {
  name: string;
  ok: boolean;
  note: string;
  frames: number;
  achievedFps: number;
  avgFrameKB: number;
  takeDiskMB: number;   // extrapolated to 60s at achieved rate
  takeWallClockS: number; // extrapolated wall-clock to capture 60s of footage
  jitterMs?: number;
}

async function newPage(extraArgs: string[] = []): Promise<{ page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--force-device-scale-factor=2", ...extraArgs],
  });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DPR });
  await page.setContent(TEST_PAGE);
  await page.waitForTimeout(300);
  return { page, close: () => browser.close() };
}

async function screencastSpike(format: "jpeg" | "png", quality?: number): Promise<Result> {
  const name = `A: screencast ${format}${quality ? ` q${quality}` : ""}`;
  const { page, close } = await newPage();
  try {
    const cdp: CDPSession = await page.context().newCDPSession(page);
    const sizes: number[] = [];
    const stamps: number[] = [];
    let sample: Buffer | null = null;

    cdp.on("Page.screencastFrame", (ev) => {
      sizes.push(Buffer.byteLength(ev.data, "base64"));
      stamps.push(ev.metadata.timestamp ?? 0);
      if (!sample) sample = Buffer.from(ev.data, "base64");
      cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
    });

    const t0 = Date.now();
    await cdp.send("Page.startScreencast", {
      format,
      ...(quality ? { quality } : {}),
      maxWidth: VIEWPORT.width * DPR,
      maxHeight: VIEWPORT.height * DPR,
      everyNthFrame: 1,
    });
    await page.waitForTimeout(SAMPLE_SECONDS * 1000);
    await cdp.send("Page.stopScreencast");
    const wall = (Date.now() - t0) / 1000;

    if (sample) writeFileSync(`spikes/out/capture-A-${format}-sample.${format}`, sample);

    const fps = sizes.length / wall;
    const avgKB = sizes.reduce((a, b) => a + b, 0) / Math.max(sizes.length, 1) / 1024;
    const intervals = stamps.slice(1).map((t, i) => (t - (stamps[i] ?? 0)) * 1000);
    const mean = intervals.reduce((a, b) => a + b, 0) / Math.max(intervals.length, 1);
    const jitter = Math.sqrt(
      intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(intervals.length, 1),
    );

    return {
      name, ok: true,
      note: "real-time capture; frame rate is whatever compositor+ack pipeline sustains",
      frames: sizes.length,
      achievedFps: fps,
      avgFrameKB: avgKB,
      takeDiskMB: (fps * TAKE_SECONDS * avgKB) / 1024,
      takeWallClockS: TAKE_SECONDS, // real-time by definition
      jitterMs: jitter,
    };
  } finally {
    await close();
  }
}

async function beginFrameSpike(): Promise<Result> {
  const name = "B: beginFrame virtual-time png";
  const { page, close } = await newPage([
    "--run-all-compositor-stages-before-draw",
    "--disable-checker-imaging",
    "--enable-begin-frame-control",
  ]);
  try {
    const cdp: CDPSession = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setVirtualTimePolicy" as never, { policy: "pause" } as never);

    const FRAMES = 120; // 2s of virtual footage is enough to measure cost
    const sizes: number[] = [];
    const t0 = Date.now();
    let sample: Buffer | null = null;

    for (let i = 0; i < FRAMES; i++) {
      // advance virtual clock one frame, then draw + screenshot deterministically
      await cdp.send("Emulation.setVirtualTimePolicy" as never, {
        policy: "advance", budget: 1000 / 60,
      } as never);
      const res = (await cdp.send("HeadlessExperimental.beginFrame" as never, {
        screenshot: { format: "png" },
      } as never)) as { screenshotData?: string };
      if (res.screenshotData) {
        const buf = Buffer.from(res.screenshotData, "base64");
        sizes.push(buf.length);
        if (!sample) sample = buf;
      }
    }
    const wall = (Date.now() - t0) / 1000;
    if (sample) writeFileSync("spikes/out/capture-B-sample.png", sample);

    const captured = sizes.length;
    const costPerFrameS = wall / Math.max(captured, 1);
    const avgKB = sizes.reduce((a, b) => a + b, 0) / Math.max(captured, 1) / 1024;
    return {
      name, ok: captured > 0,
      note: captured > 0
        ? "deterministic frame-stepped capture; wall-clock scales linearly with frames"
        : "no screenshots returned — beginFrame control unsupported in this Chromium config",
      frames: captured,
      achievedFps: 60, // by construction (virtual time)
      avgFrameKB: avgKB,
      takeDiskMB: (60 * TAKE_SECONDS * avgKB) / 1024,
      takeWallClockS: costPerFrameS * 60 * TAKE_SECONDS,
    };
  } finally {
    await close();
  }
}

async function main() {
  mkdirSync("spikes/out", { recursive: true });
  const results: Result[] = [];

  for (const run of [
    () => screencastSpike("jpeg", 90),
    () => screencastSpike("png"),
    () => beginFrameSpike(),
  ]) {
    try {
      results.push(await run());
    } catch (err) {
      results.push({
        name: "candidate crashed", ok: false,
        note: err instanceof Error ? err.message : String(err),
        frames: 0, achievedFps: 0, avgFrameKB: 0, takeDiskMB: 0, takeWallClockS: 0,
      });
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

main();
