import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { record } from "../src/capture/index.js";
import { crawlApp } from "../src/director/inventory.js";
import { generate } from "../src/director/generate.js";
import type { ChatOptions, LlmClient } from "../src/director/llm.js";
import { parseRecipe } from "../src/schema/index.js";

/**
 * Filming an app behind a login: a saved Playwright storage state signs the
 * crawl and the capture in; without one the app redirects to a sign-in page
 * on another site, which supercut refuses to film. The session's cookie is a
 * live credential, so it must never reach a prompt, a log line, or any file
 * the run writes.
 */

const SECRET = "sid-7f3c9a1e-very-secret-session-value";

const APP = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title>
<style>body{font:16px sans-serif;padding:40px} main{min-height:600px} button,input{font-size:18px;padding:10px;margin:8px}</style></head>
<body><main id="main"><h1>Your workspace</h1>
<input id="search" placeholder="Search reports">
<button id="open" onclick="document.getElementById('out').textContent='Report opened'">Open report</button>
<p id="out"></p></main></body></html>`;

const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body>
<form><input id="email" type="email" placeholder="Email"><input id="password" type="password" placeholder="Password">
<button type="submit">Sign in</button></form><a href="/forgot">Forgot password?</a></body></html>`;

let app: { url: string; close: () => Promise<void> };
let idp: { url: string; close: () => Promise<void> };
const dirs: string[] = [];

async function serve(handler: Parameters<typeof createServer>[0] & object): Promise<{ url: string; close: () => Promise<void> }> {
  const srv: Server = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) };
}

beforeAll(async () => {
  idp = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LOGIN);
  });
  app = await serve((req, res) => {
    const signedIn = (req.headers.cookie ?? "").includes(`sid=${SECRET}`);
    if (req.url?.startsWith("/signin")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(LOGIN);
    }
    if (!signedIn) {
      res.writeHead(302, { location: `${idp.url}/login` });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(APP);
  });
}, 30_000);

afterAll(async () => {
  await app.close();
  await idp.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `supercut-session-${tag}-`));
  dirs.push(d);
  return d;
}

function storageFile(): string {
  const p = join(tmp("state"), "auth.json");
  const host = new URL(app.url).hostname;
  writeFileSync(p, JSON.stringify({
    cookies: [{ name: "sid", value: SECRET, domain: host, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }],
    origins: [],
  }));
  return p;
}

/** every byte of every file under `dir`, as one latin1 string */
function allBytes(dir: string): string {
  let out = "";
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? allBytes(p) : readFileSync(p).toString("latin1");
  }
  return out;
}

class RecordingLlm implements LlmClient {
  readonly label = "recording";
  prompts: ChatOptions[] = [];
  calls = 0;
  constructor(private responses: string[]) {}
  async chat(opts: ChatOptions): Promise<string> {
    this.calls++;
    this.prompts.push(opts);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("recording LLM exhausted");
    return next;
  }
}

describe("filming behind a login", () => {
  it("without a session, refuses a start page that settles on another site, and says how to sign in", async () => {
    await expect(crawlApp(app.url, { maxPages: 1, screenshots: false, allowPrivateNetwork: true })).rejects.toThrow(
      /another site.*--storage-state/s,
    );
  }, 60_000);

  it("without a session, record fails a scene whose entry settles on another site", async () => {
    const recipe = parseRecipe({
      version: 0, app_url: app.url, music_track: "off",
      scenes: [{ name: "open", priority: 1, entry: { url: `${app.url}/`, prelude: [] }, depends_on: [],
        actions: [{ kind: "click", selector: "#open", duration_ms: 900 }], hold_ms: 0 }],
    });
    const res = await record({ recipe, outDir: tmp("rec"), captureFrames: false, allowPrivateNetwork: true });
    expect(res.failedScenes).toEqual(["open"]);
    expect(res.sceneErrors["open"]).toMatch(/another site/);
  }, 60_000);

  it("with --storage-state, films the signed-in app and the cookie leaks nowhere", async () => {
    const out = tmp("gen");
    const llm = new RecordingLlm([
      JSON.stringify({
        product_summary: "A reporting workspace for teams that search and open reports.",
        music_track: "pulse",
        money_moments: [
          { title: "Find a report", why: "search is instant", page_url: `${app.url}/`, elements: ["#search"] },
          { title: "Open it", why: "one click", page_url: `${app.url}/`, elements: ["#open"] },
        ],
      }),
      JSON.stringify({
        version: 0, app_url: app.url, music_track: "off",
        scenes: [
          { name: "search", priority: 1, entry: { url: `${app.url}/`, prelude: [] }, depends_on: [],
            actions: [{ kind: "type", selector: "#search", text: "q3", duration_ms: 1200 }], hold_ms: 0 },
          { name: "open", priority: 2, entry: { url: `${app.url}/`, prelude: [] }, depends_on: [],
            actions: [{ kind: "click", selector: "#open", duration_ms: 900 }], hold_ms: 0 },
        ],
      }),
      JSON.stringify({ verdicts: [{ scene: "search", verdict: "ok", reason: "fine" }, { scene: "open", verdict: "ok", reason: "fine" }] }),
    ]);
    const logs: string[] = [];
    const res = await generate({
      llm, url: app.url, outDir: out, seed: 3, allowPrivateNetwork: true, storageState: storageFile(),
      log: (m) => logs.push(m),
    });
    expect(res.recipe.scenes.map((s) => s.name)).toEqual(["search", "open"]);
    const prompts = JSON.stringify(llm.prompts);
    expect(prompts).toContain("#open"); // the crawl saw the signed-in app
    expect(prompts).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(allBytes(out)).not.toContain(SECRET);
  }, 300_000);

  it("a dry run with a session leaks nothing either", async () => {
    const out = tmp("dry");
    const llm = new RecordingLlm([
      JSON.stringify({
        product_summary: "A reporting workspace for teams that search and open reports.",
        music_track: "pulse",
        money_moments: [
          { title: "Find a report", why: "search is instant", page_url: `${app.url}/`, elements: ["#search"] },
          { title: "Open it", why: "one click", page_url: `${app.url}/`, elements: ["#open"] },
        ],
      }),
      JSON.stringify({
        version: 0, app_url: app.url, music_track: "off",
        scenes: [
          { name: "search", priority: 1, entry: { url: `${app.url}/`, prelude: [] }, depends_on: [],
            actions: [{ kind: "type", selector: "#search", text: "q3", duration_ms: 1200 }], hold_ms: 0 },
          { name: "open", priority: 2, entry: { url: `${app.url}/`, prelude: [] }, depends_on: [],
            actions: [{ kind: "click", selector: "#open", duration_ms: 900 }], hold_ms: 0 },
        ],
      }),
    ]);
    const logs: string[] = [];
    await generate({
      llm, url: app.url, outDir: out, dryRun: true, vision: false, allowPrivateNetwork: true,
      storageState: storageFile(), log: (m) => logs.push(m),
    });
    expect(JSON.stringify(llm.prompts)).not.toContain(SECRET);
    expect(logs.join("\n")).not.toContain(SECRET);
    expect(allBytes(out)).not.toContain(SECRET);
  }, 120_000);

  it("fails before any LLM call when the crawl finds only a sign-in form", async () => {
    const llm = new RecordingLlm([]);
    await expect(
      generate({ llm, url: `${app.url}/signin`, outDir: tmp("login"), vision: false, allowPrivateNetwork: true, log: () => {} }),
    ).rejects.toThrow(/only a sign-in form.*--storage-state/s);
    expect(llm.calls).toBe(0);
  }, 120_000);
});
