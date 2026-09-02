import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);

/**
 * The CLI must EXIT when it is done — through the real entry point, not the
 * library. `renderTake` used to leave its referenced watchdog timer (>= 5 min,
 * sized from the plan) running after a successful encode; the CLI sets
 * process.exitCode and relies on natural event-loop drain (an explicit
 * process.exit() can truncate piped stdout), so the surviving timer made
 * `supercut render` print its result and then hang for minutes. A library
 * test can't see this — only spawning the actual CLI and watching the process
 * end does.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** tiny but VALID take (mirrors the badmux fixture in record.e2e): two real
 *  1x1 PNGs over a short timeline — encodes in seconds, watchdog floor is 5min */
function writeTinyTake(): string {
  const takeDir = mkdtempSync(join(tmpdir(), "supercut-cliexit-"));
  dirs.push(takeDir);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  mkdirSync(join(takeDir, "frames"), { recursive: true });
  writeFileSync(join(takeDir, "frames", "000000.png"), png);
  writeFileSync(join(takeDir, "frames", "000001.png"), png);
  writeFileSync(
    join(takeDir, "events.json"),
    JSON.stringify({
      version: 0,
      t_source_unified: true,
      viewport: { width: 1920, height: 1080, dpr: 2 },
      fps: 60,
      events: [
        { t: 0, type: "scene", name: "s1", priority: 1 },
        { t: 300, type: "click", bbox: [10, 10, 50, 20], selector: "#x", point: [20, 20] },
      ],
    }),
  );
  writeFileSync(
    join(takeDir, "frames-index.json"),
    JSON.stringify([
      { file: "frames/000000.png", t_source: 0 },
      { file: "frames/000001.png", t_source: 500 },
    ]),
  );
  return takeDir;
}

describe("CLI process exit", () => {
  it("render exits promptly after printing its result (no surviving watchdog timer)", async () => {
    const takeDir = writeTinyTake();
    const outFile = join(takeDir, "final.mp4");
    const tsx = join(root, "node_modules", ".bin", "tsx");
    const t0 = Date.now();
    // execFile resolving IS the process exiting — the whole point of the test.
    // The 120s ceiling sits far below the 300s watchdog floor: with a leaked
    // timer the child survives past it, gets killed, and this rejects.
    const { stdout } = await exec(tsx, ["src/cli/index.ts", "render", "--take", takeDir, "--out", outFile], {
      cwd: root,
      timeout: 120_000,
    });
    const elapsed = Date.now() - t0;
    expect(stdout).toMatch(/done in .*→ /);
    expect(existsSync(outFile)).toBe(true);
    // generous for slow CI (browser launch + encode + mux), but nowhere near
    // the 5-minute watchdog a leaked timer would make the process wait out
    expect(elapsed).toBeLessThan(110_000);
  }, 150_000);
});
