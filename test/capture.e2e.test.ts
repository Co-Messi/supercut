import { readdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { record } from "../src/capture/index.js";
import { parseRecipe, type Recipe } from "../src/schema/index.js";
import { startCaptureApp, type CaptureApp } from "./fixtures/capture-app/server.js";

/**
 * Capture behaviour against the capture fixture (test/fixtures/capture-app):
 * what lands on disk, which page changes are logged and when, how scenes
 * enter, and how text is typed.
 */

let app: CaptureApp;
const dirs: string[] = [];

beforeAll(async () => {
  app = await startCaptureApp();
}, 30_000);

afterAll(async () => {
  await app.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Scene = { name: string; url: string; actions: unknown[]; hold_ms?: number; depends_on?: string[] };

function recipeOf(scenes: Scene[]): Recipe {
  return parseRecipe({
    version: 0,
    app_url: app.url,
    music_track: "institutional-01",
    scenes: scenes.map((s, i) => ({
      name: s.name,
      priority: i + 1,
      entry: { url: s.url, prelude: [] },
      depends_on: s.depends_on ?? [],
      actions: s.actions,
      hold_ms: s.hold_ms ?? 0,
    })),
  });
}

function outDir(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `supercut-cap-${tag}-`));
  dirs.push(d);
  return d;
}

type IndexEntry = { file: string; t_source: number };
const readIndex = (dir: string) => JSON.parse(readFileSync(join(dir, "frames-index.json"), "utf8")) as IndexEntry[];

const click = (selector: string, duration_ms = 1000) => ({ kind: "click", selector, duration_ms });

async function navigationsOf(scenes: Scene[], captureFrames = false) {
  const res = await record({ recipe: recipeOf(scenes), outDir: outDir("nav"), seed: 3, captureFrames, allowPrivateNetwork: true });
  expect(res.failedScenes).toEqual([]);
  return { res, navs: res.eventLog.events.filter((e) => e.type === "navigation") };
}

describe("frames on disk", () => {
  it("writes each distinct frame once: identical consecutive frames share one file", async () => {
    const out = outDir("dedupe");
    const res = await record({
      recipe: recipeOf([{ name: "still", url: `${app.url}/still`, actions: [{ kind: "wait", duration_ms: 1500 }] }]),
      outDir: out, seed: 1, allowPrivateNetwork: true,
    });
    expect(res.failedScenes).toEqual([]);
    const idx = readIndex(out);
    const onDisk = readdirSync(join(out, "frames")).sort();
    const referenced = [...new Set(idx.map((e) => e.file.slice("frames/".length)))].sort();
    // the index keeps one entry per captured frame (source fps is unchanged)...
    expect(idx.length).toBe(res.frameCount);
    expect(res.avgSourceFps).toBeGreaterThanOrEqual(30);
    // ...but a static page is a handful of distinct pictures, each written once
    expect(onDisk).toEqual(referenced);
    expect(onDisk.length).toBeLessThan(idx.length / 10);
    // no two consecutive distinct files hold the same bytes
    for (let i = 1; i < onDisk.length; i++) {
      const a = readFileSync(join(out, "frames", onDisk[i - 1]!));
      const b = readFileSync(join(out, "frames", onDisk[i]!));
      expect(a.equals(b)).toBe(false);
    }
  }, 60_000);
});

describe("page changes", () => {
  it("logs nothing for a 204, a download, a same-path pushState or a hash jump", async () => {
    // a navigation that never commits must not leave a pending state that
    // turns the next same-document URL change into a logged page change
    const { navs } = await navigationsOf([{
      name: "no-change", url: `${app.url}/spa`,
      actions: [click("#no-content"), click("#push-same"), click("#download"), click("#push-same"), click("#hash")],
    }]);
    expect(navs).toEqual([]);
  }, 60_000);

  it("logs an SPA route change as kind spa, once per path change", async () => {
    const { navs } = await navigationsOf([{
      name: "routes", url: `${app.url}/spa`,
      // /spa → /spa/reports, a query-only change, then /spa/a and /spa/b 100ms apart
      actions: [click("#push-new"), click("#push-same"), click("#push-twice")],
    }]);
    expect(navs.map((e) => e.kind)).toEqual(["spa", "spa"]);
  }, 60_000);

  it("logs one document change for a server redirect and one for a page that replaces itself", async () => {
    const { navs, res } = await navigationsOf([
      { name: "server-redirect", url: `${app.url}/spa`, actions: [click("#server-redirect", 1500)] },
      { name: "js-redirect", url: `${app.url}/spa`, actions: [click("#js-redirect", 1500)] },
    ]);
    expect(navs.map((e) => e.kind)).toEqual(["document", "document"]);
    const scene2 = res.eventLog.events.filter((e) => e.type === "scene")[1]!;
    expect(navs[0]!.t).toBeLessThan(scene2.t);
    expect(navs[1]!.t).toBeGreaterThan(scene2.t);
  }, 60_000);

  it("logs a mid-scene goto as a page change; a scene entry is its scene marker", async () => {
    const { navs, res } = await navigationsOf([
      {
        name: "goto", url: `${app.url}/spa`,
        actions: [{ kind: "wait", duration_ms: 400 }, { kind: "goto", url: `${app.url}/form`, duration_ms: 1200 }],
      },
      { name: "entry", url: `${app.url}/spa`, actions: [{ kind: "wait", duration_ms: 400 }] },
    ]);
    expect(navs.map((e) => e.kind)).toEqual(["document"]);
    const scene2 = res.eventLog.events.filter((e) => e.type === "scene")[1]!;
    expect(navs[0]!.t).toBeLessThan(scene2.t);
  }, 60_000);

  it("stamps a page change at the first frame that shows it, not at commit", async () => {
    // /slow-paint commits on its first bytes but paints 700ms later: until
    // then the screencast still shows the old page
    const { navs, res } = await navigationsOf(
      [{ name: "slow", url: `${app.url}/slow-from`, actions: [click("#go", 2500)], hold_ms: 400 }],
      true,
    );
    expect(navs).toHaveLength(1);
    const nav = navs[0]!;
    expect(nav.t - nav.observed_t!).toBeGreaterThanOrEqual(300);
    const idx = readIndex(res.outDir);
    const at = idx.findIndex((e) => e.t_source >= nav.t);
    expect(at).toBeGreaterThan(0);
    expect(idx[at]!.t_source).toBe(nav.t);
    // the frame at the stamp is new; every frame between commit and stamp is
    // the picture the page showed before the commit
    const before = idx.filter((e) => e.t_source < nav.observed_t!).at(-1)!;
    expect(idx[at]!.file).not.toBe(before.file);
    for (const e of idx.filter((x) => x.t_source >= nav.observed_t! && x.t_source < nav.t)) {
      expect(e.file).toBe(before.file);
    }
  }, 60_000);
});
