import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * supercut doctor — fail-fast dependency checks.
 *
 * Mirrors the preflight that `generate` runs before any expensive work:
 * a bad environment must error in seconds, never after 10 minutes of capture.
 */

interface Check {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const checks: Check[] = [
  {
    name: "node >= 20",
    run: async () => {
      const major = Number(process.versions.node.split(".")[0]);
      return { ok: major >= 20, detail: `found ${process.versions.node}` };
    },
  },
  {
    name: "ffmpeg on PATH",
    run: async () => {
      try {
        const { stdout } = await exec("ffmpeg", ["-version"]);
        return { ok: true, detail: stdout.split("\n")[0] ?? "found" };
      } catch {
        return {
          ok: false,
          detail: "not found — install via `brew install ffmpeg` (mac) or your package manager",
        };
      }
    },
  },
  {
    name: "ffprobe on PATH",
    run: async () => {
      try {
        const { stdout } = await exec("ffprobe", ["-version"]);
        return { ok: true, detail: stdout.split("\n")[0] ?? "found" };
      } catch {
        return { ok: false, detail: "not found — ships with ffmpeg; reinstall ffmpeg" };
      }
    },
  },
  {
    name: "playwright chromium (capture)",
    run: async () => {
      try {
        const { chromium } = await import("playwright");
        const path = chromium.executablePath();
        return path
          ? { ok: true, detail: path }
          : { ok: false, detail: "run `npx playwright install chromium`" };
      } catch {
        return { ok: false, detail: "playwright not installed — run `npm install`" };
      }
    },
  },
  {
    // render needs the FULL chromium channel (the headless shell has no
    // WebCodecs) — a doctor that only checks the shell passes while render
    // cannot launch.
    //
    // A4: launching is necessary but NOT sufficient — render encodes via the
    // in-page WebCodecs VideoEncoder, so actually probe H.264 support here
    // rather than punting it to render time (the old check only launched and
    // closed, hiding a missing/unsupported codec until 10 min into a run).
    name: "Chromium + WebCodecs H.264",
    run: async () => {
      let server: import("node:http").Server | undefined;
      let browser: import("playwright").Browser | undefined;
      try {
        // import INSIDE the try: a missing/broken playwright must surface as a
        // FAILED check (doctor's whole job) — not throw past doctor() to the
        // top-level handler, which is exactly the dep-diagnosis path doctor exists for.
        const { chromium } = await import("playwright");
        const { createServer } = await import("node:http");
        // VideoEncoder is SecureContext-gated, so it's undefined on the opaque
        // about:blank origin — evaluating there would falsely FAIL. Probe over a
        // real 127.0.0.1 origin, which Chromium treats as a secure context.
        server = createServer((_req, res) => res.end("<!doctype html>"));
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        const { port } = server.address() as { port: number };
        browser = await chromium.launch({ channel: "chromium", timeout: 20_000 });
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/`);
        const supported = await page.evaluate(async () => {
          if (typeof VideoEncoder === "undefined") return false;
          const r = await VideoEncoder.isConfigSupported({
            codec: "avc1.640028",
            width: 1920,
            height: 1080,
            bitrate: 8_000_000,
            framerate: 60,
          });
          return !!r.supported;
        });
        return supported
          ? { ok: true, detail: "ok" }
          : { ok: false, detail: "FAIL — Chromium launched but WebCodecs H.264 (avc1.640028) is unsupported" };
      } catch (err) {
        return {
          ok: false,
          detail: `FAIL — ${err instanceof Error ? err.message : String(err)} (run \`npx playwright install chromium\`)`,
        };
      } finally {
        // always release the browser + server, even if import/launch threw mid-way
        await browser?.close().catch(() => {});
        if (server) await new Promise<void>((r) => server!.close(() => r()));
      }
    },
  },
];

export async function doctor(): Promise<number> {
  let failures = 0;
  for (const check of checks) {
    const { ok, detail } = await check.run();
    console.log(`${ok ? "✓" : "✗"} ${check.name} — ${detail}`);
    if (!ok) failures++;
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed — fix before running supercut generate.`);
    return 1;
  }
  console.log("\nAll checks passed.");
  return 0;
}
