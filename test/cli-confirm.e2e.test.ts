import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * M-new-2: between the printed action preview and the first real click, a
 * human gets the last word. Where no human can answer (piped stdin: CI, a
 * coding agent, `| tee`), `generate` must not quietly film a model-written
 * recipe anyway — it refuses up front, before any crawl or LLM spend, unless
 * the caller opted in with --yes (or only previews with --dry-run).
 *
 * The spawned CLI's stdin is a pipe, never a TTY. The URL points at a closed
 * port, so a run that gets PAST the gate fails fast at preflight instead.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = join(root, "node_modules", ".bin", "tsx");
const cli = join(root, "src", "cli", "index.ts");
const cwd = mkdtempSync(join(tmpdir(), "supercut-cli-confirm-")); // no .env here

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function runGenerate(extra: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      tsx,
      [cli, "generate", "--url", "http://127.0.0.1:9/", "--out", join(cwd, "out"), ...extra],
      {
        cwd,
        timeout: 60_000,
        env: { ...process.env, SUPERCUT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-test", SUPERCUT_VISION: "false" },
      },
      (err, _stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ code, stderr: String(stderr) });
      },
    );
  });
}

const REFUSAL = /stdin is not a terminal/;

describe("generate without a terminal to confirm on", () => {
  it("refuses to film without --yes, before doing any work", async () => {
    const { code, stderr } = await runGenerate([]);
    expect(code).toBe(1);
    expect(stderr).toMatch(REFUSAL);
    expect(stderr).toMatch(/--yes/);
    // nothing ran: not even the reachability preflight
    expect(stderr).not.toMatch(/preflight|reach|ECONNREFUSED/i);
  }, 90_000);

  it("--yes is the explicit opt-in: the run proceeds (and here fails later, at preflight)", async () => {
    const { code, stderr } = await runGenerate(["--yes"]);
    expect(code).toBe(1);
    expect(stderr).not.toMatch(REFUSAL);
  }, 90_000);

  it("--dry-run never films, so it needs no confirmation", async () => {
    const { stderr } = await runGenerate(["--dry-run"]);
    expect(stderr).not.toMatch(REFUSAL);
  }, 90_000);
});
