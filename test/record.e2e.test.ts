import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { record } from "../src/capture/index.js";
import { parseEventLog, parseRecipe, type Recipe } from "../src/schema/index.js";
import { startDemoApp, type DemoApp } from "./fixtures/demo-app/server.js";

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
  }, 180_000);

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
});
