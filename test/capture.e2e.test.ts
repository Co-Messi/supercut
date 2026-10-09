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
