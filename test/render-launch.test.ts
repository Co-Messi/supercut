import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromiumInstallCommand } from "../src/capture/browser-install.js";
import { launchFailure } from "../src/render/index.js";

const install = chromiumInstallCommand();

/**
 * A render whose Chromium cannot launch must fail fast with an actionable
 * message, and must not leave the loopback render server listening: the CLI
 * exits through process.exitCode (never process.exit), so a leaked server
 * keeps the process alive forever after the error is printed.
 *
 * The check runs in a child process because only a fresh event loop can show
 * that nothing is left holding it open.
 */
describe("render when Chromium cannot launch", () => {
  it("rejects with the install hint and the process exits on its own", () => {
    const root = join(import.meta.dirname, "..");
    const child = spawnSync(process.execPath, ["--import", "tsx", join(root, "test", "helpers", "render-launch-child.ts")], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    // killed by the timeout means the process hung after the failure
    expect(child.signal, `child hung; stderr:\n${child.stderr}`).toBeNull();
    expect(child.status).toBe(1);
    const line = child.stdout.trim().split("\n").pop() ?? "";
    const outcome = JSON.parse(line) as { ok: boolean; message?: string };
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(`Chromium for rendering is not installed; run: ${install}`);
  }, 40_000);

  it("keeps the cause of other launch failures and offers the install hint only as a possibility", () => {
    const missing = launchFailure(new Error("browserType.launch: Executable doesn't exist at /x/chrome\n╔═══ banner ═══╗"));
    expect(missing.message).toBe(
      "render: could not launch Chromium (browserType.launch: Executable doesn't exist at /x/chrome). " +
        `Chromium for rendering is not installed; run: ${install}`,
    );
    const sandbox = launchFailure(new Error("browserType.launch: Target page, context or browser has been closed"));
    expect(sandbox.message).toContain("Target page, context or browser has been closed");
    expect(sandbox.message).toContain(`if Chromium for rendering is not installed, run: ${install}`);
    expect(install).toMatch(/^npx playwright@\d+\.\d+\.\d+ install chromium$/);
  });
});
