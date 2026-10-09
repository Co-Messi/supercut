/**
 * Child process for test/render-launch.test.ts: renders a tiny synthetic take
 * with a browser launcher that always fails (the shape of a missing Chromium
 * install), prints the outcome as one JSON line and then simply returns.
 *
 * It never calls process.exit: the process ends only when the event loop is
 * empty, so a render server left listening after the failed launch keeps it
 * alive and the parent test sees the hang as a timeout.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTake } from "../../src/render/index.js";

const dir = mkdtempSync(join(tmpdir(), "supercut-launch-"));
try {
  mkdirSync(join(dir, "frames"), { recursive: true });
  writeFileSync(
    join(dir, "events.json"),
    JSON.stringify({
      version: 0,
      t_source_unified: true,
      viewport: { width: 1920, height: 1080, dpr: 2 },
      fps: 60,
      events: [{ t: 0, type: "scene", name: "s1", priority: 1 }],
    }),
  );
  writeFileSync(
    join(dir, "frames-index.json"),
    JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ file: `frames/${String(i).padStart(6, "0")}.png`, t_source: i * 16.7 }))),
  );
  await renderTake({
    takeDir: dir,
    outFile: join(dir, "out", "final.mp4"),
    launchBrowser: async () => {
      throw new Error(
        "browserType.launch: Executable doesn't exist at /nonexistent/chromium\n" +
          "Looks like Playwright was just installed or updated.",
      );
    },
  });
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
