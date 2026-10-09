import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { chromiumInstallCommand } from "../capture/browser-install.js";

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

type Result = { ok: boolean; detail: string };

/** how to install ffmpeg with the platform's usual package manager */
export function ffmpegInstallHint(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "install it with `brew install ffmpeg`";
    case "linux":
      return "install it with `sudo apt install ffmpeg` (or your distro's package manager)";
    case "win32":
      return "install it with `winget install Gyan.FFmpeg` and reopen the terminal";
    default:
      return "install ffmpeg with your package manager";
  }
}

/** pinned to supercut's own Playwright (see capture/browser-install.ts) */
export function playwrightInstallHint(): string {
  return chromiumInstallCommand();
}

export async function ffmpegCheck(deps: {
  platform: NodeJS.Platform;
  run: () => Promise<string>;
}): Promise<Result> {
  try {
    const stdout = await deps.run();
    return { ok: true, detail: stdout.split("\n")[0] ?? "found" };
  } catch {
    return { ok: false, detail: `not found: ${ffmpegInstallHint(deps.platform)}` };
  }
}

/** `chromium.executablePath()` returns the path Playwright WOULD use whether
 *  or not a browser was ever downloaded there, so the file itself is checked. */
export async function chromiumInstalledCheck(deps: {
  executablePath: () => string;
  exists: (path: string) => boolean;
}): Promise<Result> {
  let path: string;
  try {
    path = deps.executablePath();
  } catch {
    return { ok: false, detail: "playwright is not installed: run `npm install`" };
  }
  if (!path) return { ok: false, detail: `no browser path resolved: run \`${playwrightInstallHint()}\`` };
  if (!deps.exists(path)) {
    return { ok: false, detail: `browser missing at ${path}: run \`${playwrightInstallHint()}\`` };
  }
  return { ok: true, detail: path };
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
    run: () =>
      ffmpegCheck({
        platform: process.platform,
        run: async () => (await exec("ffmpeg", ["-version"])).stdout,
      }),
  },
  {
    name: "playwright chromium (capture)",
    run: async () => {
      let chromium: typeof import("playwright").chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch {
        return { ok: false, detail: "playwright is not installed: run `npm install`" };
      }
      return chromiumInstalledCheck({ executablePath: () => chromium.executablePath(), exists: existsSync });
    },
  },
  {
    // render needs the FULL chromium channel (the headless shell has no
    // WebCodecs) — a doctor that only checks the shell passes while render
    // cannot launch.
    //
    // Launching is necessary but NOT sufficient: render encodes via the
    // in-page WebCodecs VideoEncoder, so H.264 support is probed here instead
    // of surfacing 10 minutes into a run.
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
          detail: `FAIL — ${err instanceof Error ? err.message : String(err)} (run \`${playwrightInstallHint()}\`)`,
        };
      } finally {
        // always release the browser + server, even if import/launch threw mid-way
        await browser?.close().catch(() => {});
        if (server) await new Promise<void>((r) => server!.close(() => r()));
      }
    },
  },
];

export function checkNames(): string[] {
  return checks.map((c) => c.name);
}

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
