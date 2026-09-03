import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generate } from "../src/director/generate.js";
import { record } from "../src/capture/index.js";
import type { ChatOptions, LlmClient } from "../src/director/llm.js";
import type { EventLog } from "../src/schema/index.js";
import { startDemoApp, type DemoApp } from "./fixtures/demo-app/server.js";

/**
 * WIRING coverage for the capture-health gate at its generate call site.
 * assessCaptureHealth is well covered as a unit and through renderTake; this
 * file proves the call BETWEEN record and QC actually fires — by mocking
 * record() to hand back a starved take (the one thing a healthy fixture can
 * never produce) and running the real generate pipeline into it.
 */

vi.mock("../src/capture/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/capture/index.js")>();
  return { ...actual, record: vi.fn(actual.record) };
});

let app: DemoApp;
const dirs: string[] = [];

class ScriptedLlm implements LlmClient {
  readonly label = "scripted";
  calls = 0;
  constructor(private makeResponses: () => string[]) {}
  private responses: string[] | null = null;
  async chat(_opts: ChatOptions): Promise<string> {
    this.responses ??= this.makeResponses();
    this.calls++;
    const next = this.responses.shift();
    if (next === undefined) throw new Error("scripted LLM exhausted");
    return next;
  }
}

beforeAll(async () => {
  app = await startDemoApp();
}, 30_000);

afterAll(async () => {
  await app.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.SUPERCUT_ALLOW_SPARSE;
  vi.restoreAllMocks();
});

/** analyze + script responses against the real crawled fixture inventory */
function scriptedBrain(): ScriptedLlm {
  return new ScriptedLlm(() => [
    JSON.stringify({
      product_summary: "Lumon Metrics: a dashboard product with instant signup and live metrics.",
      product_name: "Lumon",
      headline: "Your team's numbers, live in seconds",
      tagline: "Metrics without the setup",
      music_track: "daybreak",
      money_moments: [
        { title: "Zero-friction signup", caption: "Start in one click", why: "form appears instantly", page_url: `${app.url}/`, elements: ["#cta"] },
        { title: "Live dashboard", caption: "Watch the numbers move", why: "numbers count up live", page_url: `${app.url}/dash`, elements: ["#task-ship"] },
      ],
    }),
    JSON.stringify({
      version: 0,
      app_url: app.url,
      music_track: "daybreak",
      scenes: [
        { name: "signup", priority: 1, entry: { url: `${app.url}/`, prelude: [] }, depends_on: [],
          actions: [{ kind: "click", selector: "#cta", duration_ms: 900 }], hold_ms: 0 },
        { name: "dashboard", priority: 2, entry: { url: `${app.url}/dash`, prelude: [] }, depends_on: [],
          actions: [{ kind: "hover", selector: "#task-ship", duration_ms: 900 }], hold_ms: 0 },
      ],
    }),
  ]);
}

/** swap record() for a stub that writes a STARVED take: 3 frames across a
 *  40-second event timeline — the shape a dead repaint beacon produces */
function stubSparseRecord(failedScenes: string[]): void {
  vi.mocked(record).mockImplementation(async (opts) => {
    mkdirSync(join(opts.outDir, "frames"), { recursive: true });
    const frameIndex = [
      { file: "frames/000000.png", t_source: 0 },
      { file: "frames/000001.png", t_source: 100 },
      { file: "frames/000002.png", t_source: 200 },
    ];
    const eventLog: EventLog = {
      version: 0,
      t_source_unified: true,
      viewport: { width: 1920, height: 1080, dpr: 2 },
      fps: 60,
      events: [
        { t: 0, type: "scene", name: "signup", priority: 1 },
        { t: 20_000, type: "scene", name: "dashboard", priority: 2 },
        { t: 40_000, type: "click", bbox: [10, 10, 50, 20], selector: "#x", point: [20, 20] },
      ],
    };
    writeFileSync(join(opts.outDir, "events.json"), JSON.stringify(eventLog, null, 2));
    writeFileSync(join(opts.outDir, "frames-index.json"), JSON.stringify(frameIndex));
    return {
      eventLog,
      frameCount: frameIndex.length,
      avgSourceFps: (frameIndex.length / 40_000) * 1000,
      failedScenes,
      aborted: false,
      outDir: opts.outDir,
    };
  });
}

describe("generate-path capture-health gate wiring (H1)", () => {
  it("refuses a starved take right after record, before any QC", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "supercut-health-fail-"));
    dirs.push(outDir);
    stubSparseRecord([]);

    const llm = scriptedBrain();
    await expect(
      generate({ llm, url: app.url, outDir, vision: false, allowPrivateNetwork: true, log: () => {} }),
    ).rejects.toThrow(/generate: capture is sparse.*SUPERCUT_ALLOW_SPARSE=1/s);

    expect(vi.mocked(record)).toHaveBeenCalledTimes(1);
    // analyze + script only — the run died at the gate, before QC or render
    expect(llm.calls).toBe(2);
    expect(existsSync(join(outDir, "final.mp4"))).toBe(false);
  }, 120_000);

  it("SUPERCUT_ALLOW_SPARSE=1 bypasses the gate LOUDLY and the run continues into QC", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "supercut-health-bypass-"));
    dirs.push(outDir);
    // every scene failed at capture, so the (bypassed) gate is followed by a
    // deterministic all-cut — a cheap, hermetic proof the pipeline got PAST
    // the health check rather than dying on it
    stubSparseRecord(["signup", "dashboard"]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.SUPERCUT_ALLOW_SPARSE = "1";

    const llm = scriptedBrain();
    await expect(
      generate({ llm, url: app.url, outDir, vision: false, allowPrivateNetwork: true, log: () => {} }),
    ).rejects.toThrow(/QC cut every scene/); // NOT the sparse error

    // the bypass printed the same WARNING shape the render path prints —
    // a silently disabled gate is H1's failure mode back through the opt-out
    const errOutput = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errOutput).toMatch(/\[generate\] WARNING: capture is sparse.*\(continuing: SUPERCUT_ALLOW_SPARSE=1\)/s);
  }, 120_000);
});
