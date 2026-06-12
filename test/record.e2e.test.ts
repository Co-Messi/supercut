import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { record } from "../src/capture/index.js";
import { deterministicChecks } from "../src/director/qc.js";
import { renderTake } from "../src/render/index.js";
import { parseEventLog, parseRecipe, type Recipe } from "../src/schema/index.js";
import { startDemoApp, type DemoApp } from "./fixtures/demo-app/server.js";

const exec = promisify(execFile);

/**
 * Backbone E2E: record the fixture app for real (headless chromium,
 * screencast on) and prove the contract:
 *   - events.json validates against Event-Log Schema v0
 *   - frames exist and the index is monotonic
 *   - the SCHEDULED timeline is byte-identical across two runs (observed_t
 *     and pixels are allowed to differ; the canon is deterministic)
 */

let app: DemoApp;
const dirs: string[] = [];

function demoRecipe(url: string): Recipe {
  return parseRecipe({
    version: 0,
    app_url: url,
    music_track: "institutional-01",
    scenes: [
      {
        name: "landing-cta",
        priority: 1,
        entry: { url: `${url}/`, prelude: [] },
        depends_on: [],
        actions: [
          { kind: "click", selector: "#cta", duration_ms: 1600 },
          { kind: "type", selector: "#email", text: "ada@lumon.dev", duration_ms: 1800 },
          { kind: "click", selector: "#join", duration_ms: 1200 },
        ],
        hold_ms: 400,
      },
      {
        name: "dashboard",
        priority: 2,
        entry: { url: `${url}/dash`, prelude: [] },
        depends_on: [],
        actions: [
          { kind: "hover", selector: "#task-ship", duration_ms: 1400 },
        ],
        hold_ms: 400,
      },
    ],
  });
}

function scheduledTimeline(eventsJsonPath: string): string {
  const log = parseEventLog(JSON.parse(readFileSync(eventsJsonPath, "utf8")));
  // canonical timeline = everything except observed_t (wall-clock metadata)
  return JSON.stringify(
    log.events.map((e) => {
      const { observed_t: _drop, ...rest } = e as { observed_t?: number } & Record<string, unknown>;
      return rest;
    }),
  );
}

beforeAll(async () => {
  app = await startDemoApp();
}, 30_000);

afterAll(async () => {
  await app.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("record E2E on fixture app", () => {
  it("produces valid events.json + frames, twice, with identical scheduled timelines", async () => {
    const recipe = demoRecipe(app.url);

    const out1 = mkdtempSync(join(tmpdir(), "supercut-take1-"));
    const out2 = mkdtempSync(join(tmpdir(), "supercut-take2-"));
    dirs.push(out1, out2);

    const r1 = await record({ recipe, outDir: out1, seed: 42 });
    const r2 = await record({ recipe, outDir: out2, seed: 42 });

    // no failures on the fixture
    expect(r1.aborted).toBe(false);
    expect(r1.failedScenes).toEqual([]);

    // frames captured and index monotonic
    expect(r1.frameCount).toBeGreaterThan(60); // ≥1s of footage at minimum
    const idx = JSON.parse(readFileSync(join(out1, "frames-index.json"), "utf8")) as { t_source: number }[];
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]!.t_source).toBeGreaterThanOrEqual(idx[i - 1]!.t_source);
    }

    // schema-valid event log with the expected interaction events
    const log = parseEventLog(JSON.parse(readFileSync(join(out1, "events.json"), "utf8")));
    const types = log.events.map((e) => e.type);
    expect(types.filter((t) => t === "scene")).toHaveLength(2);
    expect(types).toContain("click");
    expect(types).toContain("type");
    expect(types).toContain("hover");
    expect(types).toContain("cursor_path");

    // determinism: scheduled timelines byte-identical across runs
    expect(scheduledTimeline(join(out1, "events.json"))).toBe(
      scheduledTimeline(join(out2, "events.json")),
    );

    // timing canon (PR #1 review): scene 2 may not start before scene 1's
    // full budget (actions 4600 + hold 400), and its first action must sit
    // at least the nav allowance after the scene marker
    const sceneEvents = log.events.filter((e) => e.type === "scene");
    const scene2T = sceneEvents[1]!.t;
    expect(scene2T).toBeGreaterThanOrEqual(5000);
    const hoverEvent = log.events.find((e) => e.type === "hover")!;
    expect(hoverEvent.t).toBeGreaterThanOrEqual(scene2T + 1000);

    // ---- render the take: full record→render pipeline proof ----
    const mp4 = join(out1, "final.mp4");
    const res = await renderTake({ takeDir: out1, outFile: mp4 });
    expect(res.frames).toBeGreaterThan(120);
    expect(statSync(mp4).size).toBeGreaterThan(100_000);

    // container sanity: h264, 1080p60, duration matches the plan
    const { stdout } = await exec("ffprobe", [
      "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", mp4,
    ]);
    const probe = JSON.parse(stdout) as {
      streams: { codec_name: string; width: number; height: number; avg_frame_rate: string }[];
      format: { duration: string };
    };
    expect(probe.streams[0]).toMatchObject({
      codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "60/1",
    });
    const expectedS = res.frames / 60;
    expect(Number(probe.format.duration)).toBeGreaterThan(expectedS - 0.5);
    expect(Number(probe.format.duration)).toBeLessThan(expectedS + 0.5);
  }, 300_000);

  it("cascades failure: broken selector fails scene, dependent scene dies with it", async () => {
    const recipe = parseRecipe({
      version: 0,
      app_url: app.url,
      music_track: "institutional-01",
      scenes: [
        {
          name: "ok-scene",
          priority: 1,
          entry: { url: `${app.url}/`, prelude: [] },
          depends_on: [],
          actions: [{ kind: "click", selector: "#cta", duration_ms: 800 }],
          hold_ms: 0,
        },
        {
          name: "broken",
          priority: 2,
          entry: { url: `${app.url}/dash`, prelude: [] },
          depends_on: [],
          actions: [{ kind: "click", selector: "#does-not-exist", duration_ms: 800 }],
          hold_ms: 0,
        },
        {
          name: "child-of-broken",
          priority: 3,
          entry: { url: `${app.url}/dash`, prelude: [] },
          depends_on: ["broken"],
          actions: [{ kind: "hover", selector: "#task-ship", duration_ms: 800 }],
          hold_ms: 0,
        },
      ],
    });

    const out = mkdtempSync(join(tmpdir(), "supercut-fail-"));
    dirs.push(out);
    // captureFrames off: this test is about failure policy, not pixels
    const res = await record({ recipe, outDir: out, seed: 1, captureFrames: false });

    expect(res.failedScenes).toContain("broken");
    expect(res.failedScenes).toContain("child-of-broken");
    // 2 of 3 scenes lost → >50% → abort
    expect(res.aborted).toBe(true);
  }, 120_000);

  it("partial failure does NOT abort and feeds a cut to QC (defends the failedScenes branch)", async () => {
    // PR #2 review: a Codex comment claimed deterministicChecks' failedScenes
    // branch is dead because record always aborts. It does NOT — one non-first
    // scene failing under the 50% threshold keeps the take alive. Prove it:
    // 1 of 3 scenes fails (no dependents) → not aborted → QC cuts just it.
    const recipe = parseRecipe({
      version: 0,
      app_url: app.url,
      music_track: "institutional-01",
      scenes: [
        { name: "intro", priority: 1, entry: { url: `${app.url}/`, prelude: [] }, depends_on: [],
          actions: [{ kind: "click", selector: "#cta", duration_ms: 800 }], hold_ms: 0 },
        { name: "bad-mid", priority: 2, entry: { url: `${app.url}/dash`, prelude: [] }, depends_on: [],
          actions: [{ kind: "click", selector: "#nonexistent-control", duration_ms: 800 }], hold_ms: 0 },
        { name: "outro", priority: 3, entry: { url: `${app.url}/dash`, prelude: [] }, depends_on: [],
          actions: [{ kind: "hover", selector: "#task-ship", duration_ms: 800 }], hold_ms: 0 },
      ],
    });

    const out = mkdtempSync(join(tmpdir(), "supercut-partial-"));
    dirs.push(out);
    const res = await record({ recipe, outDir: out, seed: 1, captureFrames: false });

    expect(res.aborted).toBe(false); // 1 of 3 ≤ 50% → take survives
    expect(res.failedScenes).toEqual(["bad-mid"]);

    const verdicts = deterministicChecks(res);
    expect(verdicts).toContainEqual(
      expect.objectContaining({ scene: "bad-mid", verdict: "cut" }),
    );
  }, 120_000);
});
