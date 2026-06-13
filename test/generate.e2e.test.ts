import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlApp } from "../src/director/inventory.js";
import { generate } from "../src/director/generate.js";
import type { ChatOptions, LlmClient } from "../src/director/llm.js";
import { startDemoApp, type DemoApp } from "./fixtures/demo-app/server.js";

/**
 * The full-pipeline eval with a stubbed director brain: analyze → script →
 * record → QC → render against the fixture app, no API key anywhere.
 * Proves the orchestration, the whitelist gates, and the handoffs.
 */

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

describe("inventory crawler on the fixture app", () => {
  it("extracts real, resolvable selectors and follows same-origin links", async () => {
    const digests = await crawlApp(app.url, { maxPages: 3, screenshots: false, allowPrivateNetwork: true });
    expect(digests.length).toBeGreaterThanOrEqual(1);
    const selectors = digests[0]!.inventory.map((i) => i.selector);
    expect(selectors).toContain("#cta");
    // #email is display:none until the CTA reveals it — must still be
    // inventoried, flagged hidden (multi-step forms are everywhere)
    const email = digests[0]!.inventory.find((i) => i.selector === "#email")!;
    expect(email).toBeDefined();
    expect(email.hidden).toBe(true);
    for (const item of digests[0]!.inventory) {
      if (!item.hidden) expect(item.bbox.w).toBeGreaterThan(0);
      expect(item.text.length).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe("generate E2E (stubbed brain, real pipeline)", () => {
  it("produces a final.mp4 + director report from one call", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "supercut-gen-"));
    dirs.push(outDir);

    const llm = new ScriptedLlm(() => [
      // ① analyze response
      JSON.stringify({
        product_summary: "Lumon Metrics: a dashboard product with instant signup and live metrics.",
        money_moments: [
          { title: "Zero-friction signup", why: "form appears instantly", page_url: `${app.url}/`, elements: ["#cta", "#email"] },
          { title: "Live dashboard", why: "numbers count up live", page_url: `${app.url}/dash`, elements: ["#task-ship"] },
        ],
      }),
      // ② script response — real selectors from the fixture app
      JSON.stringify({
        version: 0,
        app_url: app.url,
        music_track: "institutional-01",
        scenes: [
          {
            name: "signup",
            priority: 1,
            entry: { url: `${app.url}/`, prelude: [] },
            depends_on: [],
            actions: [
              { kind: "click", selector: "#cta", duration_ms: 1500 },
              { kind: "type", selector: "#email", text: "ada@lumon.dev", duration_ms: 1800 },
            ],
            hold_ms: 400,
          },
          {
            name: "dashboard",
            priority: 2,
            entry: { url: `${app.url}/dash`, prelude: [] },
            depends_on: [],
            actions: [{ kind: "hover", selector: "#task-ship", duration_ms: 1400 }],
            hold_ms: 400,
          },
        ],
      }),
      // ④ vision QC response — all clean
      JSON.stringify({
        verdicts: [
          { scene: "signup", verdict: "ok", reason: "form visible and filled" },
          { scene: "dashboard", verdict: "ok", reason: "metrics visible" },
        ],
      }),
    ]);

    const res = await generate({
      llm,
      url: app.url,
      outDir,
      seed: 7,
      allowPrivateNetwork: true,
      log: () => {},
    });

    expect(res.retakes).toBe(0);
    expect(statSync(res.outFile).size).toBeGreaterThan(100_000);
    expect(res.recipe.scenes.map((s) => s.name)).toEqual(["signup", "dashboard"]);

    const report = JSON.parse(readFileSync(join(outDir, "director-report.json"), "utf8"));
    expect(report.llm).toBe("scripted");
    expect(report.analysis.money_moments).toHaveLength(2);
    expect(llm.calls).toBe(3); // analyze + script + vision QC — no silent extra spend
  }, 300_000);

  it("fails fast on an unreachable app URL (before any LLM call)", async () => {
    const llm = new ScriptedLlm(() => []);
    await expect(
      generate({ llm, url: "http://127.0.0.1:1", outDir: mkdtempSync(join(tmpdir(), "supercut-dead-")), allowPrivateNetwork: true, log: () => {} }),
    ).rejects.toThrow(/cannot reach/);
    expect(llm.calls).toBe(0);
  }, 30_000);
});
