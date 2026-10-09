import { describe, expect, it } from "vitest";
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

  it("uses one playwright install command everywhere", () => {
    expect(playwrightInstallHint()).toBe("npx playwright install chromium");
  });
});

describe("doctor chromium check", () => {
  it("FAILS when the resolved executable path does not exist on disk", async () => {
    const res = await chromiumInstalledCheck({
      executablePath: () => "/nonexistent/chromium/chrome",
      exists: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/npx playwright install chromium/);
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
