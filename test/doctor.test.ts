import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installCommandFor, playwrightCli } from "../src/capture/browser-install.js";
import {
  checkNames,
  chromiumInstalledCheck,
  ffmpegCheck,
  ffmpegInstallHint,
  playwrightInstallHint,
} from "../src/cli/doctor.js";

describe("doctor install hints", () => {
  it("names the package manager for each platform", () => {
    expect(ffmpegInstallHint("darwin")).toMatch(/brew install ffmpeg/);
    expect(ffmpegInstallHint("linux")).toMatch(/apt install ffmpeg/);
    expect(ffmpegInstallHint("win32")).toMatch(/winget install .*ffmpeg/i);
  });

  it("falls back to a generic hint on other platforms", () => {
    expect(ffmpegInstallHint("freebsd")).toMatch(/ffmpeg/);
  });

  it("uses one playwright install command everywhere: supercut's own Playwright CLI", () => {
    // browsers live in a folder per Playwright revision. Inside an app with
    // its own @playwright/test, every `npx playwright` form (even
    // `npx playwright@<version>`, when the app's tree holds a matching
    // playwright) runs the app's bin and installs the app's revision
    const require = createRequire(import.meta.url);
    const cli = join(dirname(require.resolve("playwright/package.json")), "cli.js");
    expect(existsSync(cli)).toBe(true);
    expect(playwrightInstallHint()).toBe(`node "${cli}" install chromium`);
    expect(installCommandFor("/x y/cli.js")).toBe('node "/x y/cli.js" install chromium');
    expect(installCommandFor(undefined)).toBe("npx playwright install chromium");
  });

  it("the command runs the Playwright that supercut resolves", () => {
    const require = createRequire(import.meta.url);
    const { version } = require("playwright/package.json") as { version: string };
    const out = execFileSync(process.execPath, [playwrightCli()!, "--version"], { encoding: "utf8" });
    expect(out.trim()).toBe(`Version ${version}`);
  });
});

describe("doctor chromium check", () => {
  it("FAILS when the resolved executable path does not exist on disk", async () => {
    const res = await chromiumInstalledCheck({
      executablePath: () => "/nonexistent/chromium/chrome",
      exists: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain(playwrightInstallHint());
    expect(res.detail).toContain("/nonexistent/chromium/chrome");
  });

  it("passes when the executable exists", async () => {
    const res = await chromiumInstalledCheck({ executablePath: () => "/x/chrome", exists: (p) => p === "/x/chrome" });
    expect(res).toEqual({ ok: true, detail: "/x/chrome" });
  });

  it("fails with an install hint when playwright cannot report a path", async () => {
    const res = await chromiumInstalledCheck({
      executablePath: () => {
        throw new Error("Cannot find package 'playwright'");
      },
      exists: () => true,
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/npm install/);
  });

  it("fails when playwright returns an empty path", async () => {
    const res = await chromiumInstalledCheck({ executablePath: () => "", exists: () => true });
    expect(res.ok).toBe(false);
  });
});

describe("doctor ffmpeg check", () => {
  it("reports the platform install hint when ffmpeg is missing", async () => {
    const res = await ffmpegCheck({
      platform: "win32",
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/winget/);
  });

  it("returns the first version line when ffmpeg runs", async () => {
    const res = await ffmpegCheck({ platform: "linux", run: async () => "ffmpeg version 7.0\nbuilt with x" });
    expect(res).toEqual({ ok: true, detail: "ffmpeg version 7.0" });
  });
});

describe("doctor check list", () => {
  it("does not check ffprobe (nothing in src uses it)", () => {
    expect(checkNames()).not.toContain("ffprobe on PATH");
    expect(checkNames()).toContain("ffmpeg on PATH");
  });
});
