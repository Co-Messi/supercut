import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * What a run leaves on disk: the render's temporary H.264 stream is removed
 * even when the run is interrupted, and the default output directory does
 * not collide with a Next.js static export's `out/`.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = join(root, "node_modules", ".bin", "tsx");
const dir = mkdtempSync(join(tmpdir(), "supercut-artifacts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("temporary render files", () => {
  it("are removed when the process is interrupted, and the interrupt still ends it", async () => {
    const victim = join(dir, "supercut-test.h264");
    const script = join(dir, "interrupt.mts");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
       const { removeOnExit } = await import(${JSON.stringify(join(root, "src", "render", "temp.ts"))});
       writeFileSync(process.argv[2], "partial stream");
       removeOnExit(process.argv[2]);
       writeFileSync(process.argv[2] + ".armed", "");
       process.kill(process.pid, "SIGINT");
       setTimeout(() => process.exit(7), 5000);`,
    );
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      execFile(tsx, [script, victim], { timeout: 30_000 }, (err) => {
        const e = err as (Error & { code?: number; signal?: string }) | null;
        resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, signal: e?.signal ?? null });
      });
    });
    expect(existsSync(`${victim}.armed`), "the child wrote the file and armed the cleanup").toBe(true);
    expect(existsSync(victim)).toBe(false);
    // ended by the signal, not by the 5s fallback
    expect(result.code === 7).toBe(false);
  }, 60_000);

  it("a disposed cleanup leaves the file alone (the render removes it itself on success)", async () => {
    const { removeOnExit } = await import("../src/render/temp.js");
    const keep = join(dir, "keep.h264");
    writeFileSync(keep, "x");
    removeOnExit(keep)();
    expect(readFileSync(keep, "utf8")).toBe("x");
  });
});

describe("default output directory", () => {
  it("is supercut-out/, not out/ (a Next.js static export owns out/)", () => {
    const cli = readFileSync(join(root, "src", "cli", "index.ts"), "utf8");
    expect(cli).not.toMatch(/\?\? "out\//);
    for (const d of ["supercut-out/take", "supercut-out/final.mp4", "supercut-out/generate"]) expect(cli).toContain(`"${d}"`);
  });
});
