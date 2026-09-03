import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlApp } from "../src/director/inventory.js";
import { generate } from "../src/director/generate.js";
import type { ChatOptions, LlmClient } from "../src/director/llm.js";
import { startDemoApp, type DemoApp } from "./fixtures/demo-app/server.js";

const exec = promisify(execFile);

/** codec_type:codec_name per stream, sorted — the music-mux assertion shape */
async function probeStreams(mp4: string): Promise<string[]> {
  const { stdout } = await exec("ffprobe", [
    "-v", "quiet", "-print_format", "json", "-show_streams", mp4,
  ]);
  const probe = JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string }[] };
  return probe.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort();
}

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
    // theme probe: the landing page is a light SaaS with a blue primary button
    expect(digests[0]!.theme).toBe("light");
    expect(digests[0]!.accentColor).toBe("rgb(37, 99, 235)");
  }, 60_000);

  it("keeps a multi-row dashboard filmable while fail-safe excluding every destructive-labelled element", async () => {
    const digests = await crawlApp(`${app.url}/fleet`, { maxPages: 1, screenshots: false, allowPrivateNetwork: true });
    const fleet = digests[0]!;

    // dark ops dashboard → the look probe must say so
    expect(fleet.theme).toBe("dark");

    // six identical-testid rows (all non-destructive names) → six DISTINCT
    // :nth-match entries with their own text; a story needs "click row 2, then 4"
    const rows = fleet.inventory.filter((i) => i.selector.includes('[data-testid="service-item"]'));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.selector)).size).toBe(6);
    for (const row of rows) expect(row.selector).toMatch(/^:nth-match\(/);

    // the search box resolves via data-testid, immune to ticking metrics text
    expect(fleet.inventory.some((i) => i.selector === '[data-testid="service-search"]')).toBe(true);

    // every genuine destructive control stays out, loudly — including a clickable
    // div[onclick] (not scoped to <button>) and a hyphen-joined action label
    for (const label of ["Delete service", "Delete account", "Delete-all"]) {
      expect(fleet.inventory.some((i) => i.text.includes(label)), `${label} must be excluded`).toBe(false);
      expect(fleet.excludedDestructive).toContain(label);
    }

    // the reviewer's repro: a framework-wired clickable div — handler bound via
    // addEventListener (onclick ATTR null) AND no cursor:pointer/tabindex/role
    // signal — is excluded purely by its destructive label. No interactivity
    // heuristic could have caught it; we no longer rely on one.
    expect(fleet.inventory.some((i) => i.text.includes("delete-worker"))).toBe(false);
    expect(fleet.excludedDestructive).toContain("delete-worker");

    // a genuinely PASSIVE destructive-slug row (a read-only <li>, cursor:default,
    // no handler) is ALSO excluded now — we can't prove it's inert, so fail-safe
    // wins over filming a row that merely looks like a display cell.
    expect(fleet.inventory.some((i) => i.text.includes("delete-log-2024"))).toBe(false);
    expect(fleet.excludedDestructive).toContain("delete-log-2024");
  }, 60_000);

  it("refuses to film a page whose URL is itself a credential (token in the query)", async () => {
    // a URL is a validation key that can't be redacted, so a page whose URL
    // carries a secret is dropped rather than leaked — here it's the start page,
    // so the run fails closed with a clear error instead of egressing the token
    await expect(
      crawlApp(`${app.url}/?token=supersecretvalue123456`, {
        maxPages: 1, screenshots: false, allowPrivateNetwork: true,
      }),
    ).rejects.toThrow(/contains a secret/i);
  }, 30_000);

  it("does not misread a light app with a full-viewport translucent overlay as dark", async () => {
    // a modal backdrop rgba(0,0,0,.55) out-covers the body but is not the page
    // ground — the probe must skip non-opaque layers and stay "light"
    const digests = await crawlApp(`${app.url}/overlay`, { maxPages: 1, screenshots: false, allowPrivateNetwork: true });
    expect(digests[0]!.theme).toBe("light");
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
        product_name: "Lumon",
        headline: "Your team's numbers, live in seconds",
        tagline: "Metrics without the setup",
        music_track: "daybreak",
        money_moments: [
          { title: "Zero-friction signup", caption: "Start in one click", why: "form appears instantly", page_url: `${app.url}/`, elements: ["#cta", "#email"] },
          { title: "Live dashboard", caption: "Watch the numbers move", why: "numbers count up live", page_url: `${app.url}/dash`, elements: ["#task-ship"] },
        ],
      }),
      // ② script response — real selectors from the fixture app
      JSON.stringify({
        version: 0,
        app_url: app.url,
        music_track: "daybreak",
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

    // no --music, director picked "daybreak" → the final cut carries an audio
    // stream (bundled track muxed under the copied H.264)
    expect(await probeStreams(res.outFile)).toEqual(["audio:aac", "video:h264"]);

    const report = JSON.parse(readFileSync(join(outDir, "director-report.json"), "utf8"));
    expect(report.llm).toBe("scripted");
    expect(report.analysis.money_moments).toHaveLength(2);
    expect(report.recipe.music_track).toBe("daybreak");
    expect(llm.calls).toBe(3); // analyze + script + vision QC — no silent extra spend
  }, 300_000);

  it("--music off silences the cut even when the director picked a track", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "supercut-gen-silent-"));
    dirs.push(outDir);

    // short scenes: this test is about the music priority, not the footage
    const llm = new ScriptedLlm(() => [
      JSON.stringify({
        product_summary: "Lumon Metrics: a dashboard product with instant signup and live metrics.",
        product_name: "Lumon",
        headline: "Your team's numbers, live in seconds",
        tagline: "Metrics without the setup",
        music_track: "midnight",
        money_moments: [
          { title: "Zero-friction signup", caption: "Start in one click", why: "form appears instantly", page_url: `${app.url}/`, elements: ["#cta"] },
          { title: "Live dashboard", caption: "Watch the numbers move", why: "numbers count up live", page_url: `${app.url}/dash`, elements: ["#task-ship"] },
        ],
      }),
      JSON.stringify({
        version: 0,
        app_url: app.url,
        music_track: "midnight",
        scenes: [
          { name: "signup", priority: 1, entry: { url: `${app.url}/`, prelude: [] }, depends_on: [],
            actions: [{ kind: "click", selector: "#cta", duration_ms: 900 }], hold_ms: 0 },
          { name: "dashboard", priority: 2, entry: { url: `${app.url}/dash`, prelude: [] }, depends_on: [],
            actions: [{ kind: "hover", selector: "#task-ship", duration_ms: 900 }], hold_ms: 0 },
        ],
      }),
      JSON.stringify({
        verdicts: [
          { scene: "signup", verdict: "ok", reason: "form visible" },
          { scene: "dashboard", verdict: "ok", reason: "metrics visible" },
        ],
      }),
    ]);

    const res = await generate({
      llm,
      url: app.url,
      outDir,
      music: "off",
      seed: 7,
      allowPrivateNetwork: true,
      log: () => {},
    });

    // cli "off" outranks the director's "midnight": video stream only
    expect(await probeStreams(res.outFile)).toEqual(["video:h264"]);
  }, 300_000);

  it("preserves the recorded take + artifacts when QC cuts every scene (M4)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "supercut-allcut-"));
    dirs.push(outDir);
    const llm = new ScriptedLlm(() => [
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
      // ④ vision QC condemns everything
      JSON.stringify({
        verdicts: [
          { scene: "signup", verdict: "cut", reason: "blank frame" },
          { scene: "dashboard", verdict: "cut", reason: "error page" },
        ],
      }),
    ]);

    await expect(
      generate({ llm, url: app.url, outDir, seed: 7, allowPrivateNetwork: true, log: () => {} }),
    ).rejects.toThrow(/QC cut every scene.*preserved at/s);

    // the take survived, and the run left enough on disk to debug + render it
    expect(existsSync(join(outDir, "take-0", "events.json"))).toBe(true);
    expect(existsSync(join(outDir, "take-0", "frames-index.json"))).toBe(true);
    expect(existsSync(join(outDir, "recipe.json"))).toBe(true);
    const report = JSON.parse(readFileSync(join(outDir, "director-report.json"), "utf8"));
    expect(report.verdictLog.flat().filter((v: { verdict: string }) => v.verdict === "cut")).toHaveLength(2);
    expect(existsSync(join(outDir, "final.mp4"))).toBe(false);
  }, 300_000);

  it("--dry-run writes the recipe + preview and never films (H6)", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "supercut-dry-"));
    dirs.push(outDir);
    const llm = new ScriptedLlm(() => [
      JSON.stringify({
        product_summary: "Lumon Metrics: a dashboard product with instant signup and live metrics.",
        product_name: "Lumon",
        headline: "Your team's numbers, live in seconds",
        tagline: "Metrics without the setup",
        music_track: "daybreak",
        money_moments: [
          { title: "Zero-friction signup", caption: "Start in one click", why: "form appears instantly", page_url: `${app.url}/`, elements: ["#cta", "#email"] },
          { title: "Live dashboard", caption: "Watch the numbers move", why: "numbers count up live", page_url: `${app.url}/dash`, elements: ["#task-ship"] },
        ],
      }),
      JSON.stringify({
        version: 0,
        app_url: app.url,
        music_track: "daybreak",
        scenes: [
          { name: "signup", priority: 1, entry: { url: `${app.url}/`, prelude: [] }, depends_on: [],
            actions: [
              { kind: "click", selector: "#cta", duration_ms: 1500 },
              { kind: "type", selector: "#email", text: "ada@lumon.dev", submit: true, duration_ms: 1800 },
            ], hold_ms: 400 },
          { name: "dashboard", priority: 2, entry: { url: `${app.url}/dash`, prelude: [] }, depends_on: [],
            actions: [{ kind: "hover", selector: "#task-ship", duration_ms: 1400 }], hold_ms: 400 },
        ],
      }),
    ]);

    const logs: string[] = [];
    const res = await generate({
      llm, url: app.url, outDir, seed: 7, dryRun: true,
      allowPrivateNetwork: true, log: (m) => logs.push(m),
    });

    // nothing filmed, nothing rendered — but the recipe artifact exists
    expect(res.outFile).toBe("");
    expect(llm.calls).toBe(2); // analyze + script only, no QC
    expect(existsSync(join(outDir, "recipe.json"))).toBe(true);
    expect(existsSync(join(outDir, "take-0"))).toBe(false);
    expect(existsSync(join(outDir, "final.mp4"))).toBe(false);
    const report = JSON.parse(readFileSync(join(outDir, "director-report.json"), "utf8"));
    expect(report.dryRun).toBe(true);
    // the preview surfaces every action, including the full typed text + Enter
    const preview = logs.join("\n");
    expect(preview).toContain('type #email "ada@lumon.dev" then press Enter');
    expect(preview).toContain("click #cta");
  }, 120_000);

  it("fails fast on an unreachable app URL (before any LLM call)", async () => {
    const llm = new ScriptedLlm(() => []);
    await expect(
      generate({ llm, url: "http://127.0.0.1:1", outDir: mkdtempSync(join(tmpdir(), "supercut-dead-")), allowPrivateNetwork: true, log: () => {} }),
    ).rejects.toThrow(/cannot reach/);
    expect(llm.calls).toBe(0);
  }, 30_000);
});

describe("preflight status handling", () => {
  /** serves /s/<code> with that status (and a tiny html body) */
  let statusServer: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    const srv = createServer((req, res) => {
      const code = Number(/^\/s\/(\d{3})/.exec(req.url ?? "")?.[1] ?? 200);
      res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><body><h1>status page</h1></body></html>");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as { port: number };
    statusServer = {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => srv.close(() => r())),
    };
  });

  afterAll(async () => {
    await statusServer.close();
  });

  function tryGenerate(url: string, extra: { skipPreflight?: boolean } = {}) {
    const logs: string[] = [];
    const llm = new ScriptedLlm(() => []);
    const outDir = mkdtempSync(join(tmpdir(), "supercut-preflight-"));
    dirs.push(outDir);
    const run = generate({
      llm, url, outDir, allowPrivateNetwork: true, vision: false,
      log: (m) => logs.push(m), ...extra,
    });
    return { run, logs, llm };
  }

  it("404, 410, and 5xx roots are fatal before any LLM call", async () => {
    for (const code of [404, 410, 500, 503]) {
      const { run, llm } = tryGenerate(`${statusServer.url}/s/${code}`);
      await expect(run).rejects.toThrow(new RegExp(`responded ${code}`));
      expect(llm.calls).toBe(0);
    }
  }, 60_000);

  it("401/403 warn and CONTINUE — an auth wall at the root must not block filming your own app", async () => {
    for (const code of [401, 403]) {
      const { run, logs } = tryGenerate(`${statusServer.url}/s/${code}`);
      // getting PAST preflight means the run dies later, in analyze, when the
      // deliberately-empty scripted LLM runs out — not on a preflight error
      await expect(run).rejects.toThrow(/scripted LLM exhausted/);
      const all = logs.join("\n");
      expect(all).toMatch(new RegExp(`preflight warning: .*responded ${code}`));
    }
  }, 120_000);

  it("--skip-preflight bypasses the reachability probe entirely (escape hatch)", async () => {
    // a 500 root would be fatal — with the override the run proceeds to the
    // crawl and dies in analyze instead, proving the probe never gated it
    const { run, logs } = tryGenerate(`${statusServer.url}/s/500`, { skipPreflight: true });
    await expect(run).rejects.toThrow(/scripted LLM exhausted/);
    expect(logs.join("\n")).toContain("--skip-preflight");
  }, 120_000);
});
