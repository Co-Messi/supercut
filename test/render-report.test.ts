import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { renderTake } from "../src/render/index.js";
import { planTake } from "../src/render/plan.js";
import {
  accumulatorLine,
  beatSummary,
  bitrateLine,
  buildRenderReport,
  overLimitWarning,
  parseAccumulatorLine,
  planSummaryLine,
  type RenderReport,
} from "../src/render/report.js";
import { frames, makeLog, noBrowser, takeDirs } from "./helpers/takes.js";

const takes = takeDirs("supercut-report-");
afterAll(() => takes.cleanup());
afterEach(() => vi.restoreAllMocks());

const click = (t: number, extra: object = {}) => ({
  t, type: "click" as const, bbox: [600, 300, 120, 40] as [number, number, number, number], selector: `#c${t}`, point: [660, 320] as [number, number], ...extra,
});

describe("plan summary", () => {
  it("counts framed beats and names why the others were skipped", () => {
    const log = makeLog([
      { t: 0, type: "scene", name: "a", priority: 1 },
      click(400), // inside the opening establishing shot
      click(3000),
      { t: 5000, type: "click", bbox: [0, 0, 1920, 1080], selector: "#hero", point: [960, 540] },
    ]);
    const { diagnostics } = planTake(log, frames(420, 17));
    expect(beatSummary(diagnostics.beats)).toBe(
      "framed 1 of 3 beats (skipped: 1 too soon after the page opened, 1 target fills the viewport)",
    );
    expect(planSummaryLine(diagnostics)).toMatch(/^\[render\] plan: framed 1 of 3 beats .*; 0 page changes; \d+\.\ds video$/);
  });

  it("a report lists boundaries with their evidence and every beat", () => {
    const log = makeLog(
      [{ t: 0, type: "scene", name: "a", priority: 1 }, click(2000), { t: 4000, type: "navigation", kind: "spa" }],
      { navigation_logged: true },
    );
    const { plan, diagnostics } = planTake(log, frames(400, 17));
    const report = buildRenderReport({
      takeDir: "take", outFile: "out/final.mp4", diagnostics, frames: plan.frames, fps: plan.fps, limitMs: 60_000,
      source: { frames: 400, avgFps: 58.84, failedScenes: [] },
    });
    expect(report.boundaries).toEqual([{ source: "navigation", at: 4000, cut: true, wideBy: 4000, newPageAt: 4000 }]);
    expect(report.beats).toEqual([
      { t: 2000, type: "click", selector: "#c2000", target: "interaction", framed: true, zoom: 1.42, shot: [1250, 3200] },
    ]);
    expect(report.source).toEqual({ frames: 400, avgFps: 58.8, navigationLogged: true, failedScenes: [] });
    expect(report.video.overLimit).toBe(false);
    expect(report.summary).toBe("framed 1 of 1 beat; 1 page change (1 navigation)");
  });
});

describe("render log lines", () => {
  it("parses the host page's accumulator announcement", () => {
    expect(parseAccumulatorLine("[render] accumulator float16 32")).toEqual({ mode: "float16", maxPasses: 32 });
    expect(parseAccumulatorLine("[render] accumulator 8bit 4")).toEqual({ mode: "8bit", maxPasses: 4 });
    expect(parseAccumulatorLine("[render] frame 120/700")).toBeNull();
  });

  it("surfaces the 8-bit accumulator as a warning, float16 as information", () => {
    expect(accumulatorLine({ mode: "float16", maxPasses: 32 })).not.toMatch(/WARNING/);
    expect(accumulatorLine({ mode: "8bit", maxPasses: 4 })).toMatch(/^\[render\] WARNING: .*8 bits.*up to 2 levels/);
  });

  it("reports a low delivered bitrate as information, never a starvation warning", () => {
    const line = bitrateLine(1_200_000, 16_000_000, 10);
    expect(line).toBe("[render] delivered bitrate 1.20 Mbps over 10.0s (encoder ceiling 16 Mbps; static screens encode well below it)");
    expect(line).not.toMatch(/WARNING|starv/i);
  });

  it("warns only past the limit", () => {
    expect(overLimitWarning(60_000, 60_000)).toBeNull();
    expect(overLimitWarning(61_250, 60_000)).toMatch(/^\[render\] WARNING: the video runs 61\.3s, over the 60s limit/);
  });

  it("no new CLI string uses an em or en dash", () => {
    const strings = [
      accumulatorLine({ mode: "8bit", maxPasses: 4 }),
      accumulatorLine({ mode: "float16", maxPasses: 32 }),
      bitrateLine(1, 2, 3),
      overLimitWarning(70_000, 60_000)!,
    ];
    for (const s of strings) expect(s).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("renderTake writes render-report.json", () => {
  it("writes the plan report next to the output, and marks a failed render", async () => {
    const takeDir = takes.make(makeLog([{ t: 0, type: "scene", name: "a", priority: 1 }, click(2000)]), frames(240, 1000 / 60));
    const outFile = join(takeDir, "out", "final.mp4");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(renderTake({ takeDir, outFile, launchBrowser: noBrowser })).rejects.toThrow(/could not launch Chromium/);
    const reportFile = join(takeDir, "out", "render-report.json");
    expect(existsSync(reportFile)).toBe(true);
    const report = JSON.parse(readFileSync(reportFile, "utf8")) as RenderReport;
    expect(report.status).toBe("failed");
    expect(report.error).toMatch(/could not launch Chromium/);
    expect(report.summary).toBe("framed 1 of 1 beat; 0 page changes");
    expect(report.source.frames).toBe(240);
    const printed = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toContain("[render] plan: framed 1 of 1 beat");
  });

  it("warns loudly before the encode when the measured video is over 60s", async () => {
    const takeDir = takes.make(
      makeLog([{ t: 0, type: "scene", name: "a", priority: 1 }, click(2000)]),
      frames(62 * 60, 1000 / 60),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      renderTake({ takeDir, outFile: join(takeDir, "out", "final.mp4"), launchBrowser: noBrowser }),
    ).rejects.toThrow(/could not launch Chromium/);
    const printed = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toMatch(/\[render\] WARNING: the video runs 63\.0s, over the 60s limit/);
    const report = JSON.parse(readFileSync(join(takeDir, "out", "render-report.json"), "utf8")) as RenderReport;
    expect(report.video.overLimit).toBe(true);
  });
});
