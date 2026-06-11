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
    name: "playwright chromium",
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
