import { readdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { record } from "../src/capture/index.js";
import { parseEventLog, parseRecipe, type Recipe } from "../src/schema/index.js";
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

describe("repaint beacon", () => {
  it("adds no DOM node and makes no DOM mutations in the filmed page", async () => {
    const from = app.logs.length;
    const res = await record({
      recipe: recipeOf([{ name: "still", url: `${app.url}/still`, actions: [{ kind: "wait", duration_ms: 1500 }] }]),
      outDir: outDir("beacon-dom"), seed: 1, allowPrivateNetwork: true,
    });
    expect(res.failedScenes).toEqual([]);
    expect(res.avgSourceFps).toBeGreaterThanOrEqual(30);
    const reports = app.logs.slice(from).filter((l) => l.ev === "still");
    expect(reports.length).toBeGreaterThanOrEqual(2);
    const last = reports.at(-1)!;
    // an app's MutationObserver, session replay or idle detector sees nothing
    expect(last.mutations).toBe(0);
    // and structural selectors see only the page's own nodes (head + body;
    // h1, p, script)
    expect(last.rootChildren).toBe(2);
    expect(last.bodyChildren).toBe(3);
  }, 60_000);

  it("keeps frames flowing while the page's main thread is blocked", async () => {
    // /stall's click runs an 800ms long task; a beacon driven from the main
    // thread stops with it, one animated on the compositor does not
    const res = await record({
      recipe: recipeOf([{ name: "stall", url: `${app.url}/stall`, actions: [click("#run", 2000)], hold_ms: 300 }]),
      outDir: outDir("beacon-stall"), seed: 1, allowPrivateNetwork: true,
    });
    expect(res.failedScenes).toEqual([]);
    const c = res.eventLog.events.find((e) => e.type === "click")!;
    const idx = readIndex(res.outDir).filter((e) => e.t_source >= c.observed_t! && e.t_source <= c.observed_t! + 1200);
    let maxGap = 0;
    for (let i = 1; i < idx.length; i++) maxGap = Math.max(maxGap, idx[i]!.t_source - idx[i - 1]!.t_source);
    // a main-thread beacon leaves a hole the length of the task (~800ms);
    // the bound leaves room for a slow software compositor
    expect(idx.length).toBeGreaterThan(2);
    expect(maxGap).toBeLessThan(400);
  }, 60_000);
});

/** /log bodies posted during `run`, after in-flight posts have landed */
async function logsDuring<T>(run: () => Promise<T>): Promise<{ result: T; logs: Record<string, unknown>[] }> {
  const from = app.logs.length;
  const result = await run();
  await new Promise((r) => setTimeout(r, 300));
  return { result, logs: app.logs.slice(from) };
}

describe("scene entry", () => {
  it("reloads a shared entry URL after a scene that typed: the next scene starts from a clean field", async () => {
    const { result: res, logs } = await logsDuring(() =>
      record({
        recipe: recipeOf([
          { name: "type-pay", url: `${app.url}/form`, actions: [{ kind: "type", selector: "#q", text: "pay", duration_ms: 1400 }] },
          {
            name: "type-auth", url: `${app.url}/form`,
            actions: [{ kind: "type", selector: "#q", text: "auth", submit: true, duration_ms: 1600 }], hold_ms: 400,
          },
        ]),
        outDir: outDir("reload"), seed: 4, captureFrames: false, allowPrivateNetwork: true,
      }),
    );
    expect(res.failedScenes).toEqual([]);
    // each scene opened on a freshly loaded page and focused an empty field
    expect(logs.filter((l) => l.ev === "load")).toHaveLength(2);
    expect(logs.filter((l) => l.ev === "focus").map((l) => l.value)).toEqual(["", ""]);
    expect(logs.find((l) => l.ev === "submit")?.value).toBe("auth");
  }, 60_000);

  it("fails a scene whose entry page answers an HTTP error, says why, and records it in events.json", async () => {
    const out = outDir("entry404");
    const res = await record({
      recipe: recipeOf([
        { name: "ok", url: `${app.url}/form`, actions: [{ kind: "wait", duration_ms: 300 }] },
        { name: "missing", url: `${app.url}/missing`, actions: [{ kind: "wait", duration_ms: 300 }] },
        { name: "ok-again", url: `${app.url}/form`, actions: [{ kind: "wait", duration_ms: 300 }] },
      ]),
      outDir: out, seed: 1, captureFrames: false, allowPrivateNetwork: true,
    });
    expect(res.aborted).toBe(false);
    expect(res.failedScenes).toEqual(["missing"]);
    expect(res.sceneErrors["missing"]).toBe(
      `entry page ${app.url}/missing returned 404; is your app running there, and is something else using that port?`,
    );
    const log = parseEventLog(JSON.parse(readFileSync(join(out, "events.json"), "utf8")));
    expect(log.failed_scenes).toEqual(["missing"]);
    expect(log.navigation_logged).toBe(true);
  }, 60_000);

  it("keeps events.json readable when a failed scene's name exceeds the log's limit", async () => {
    // recipe scene names are unbounded; the event log caps failed_scenes
    // entries at 200 characters
    const long = "a-very-long-scene-name-".repeat(12);
    const out = outDir("longname");
    const res = await record({
      recipe: recipeOf([
        { name: "ok", url: `${app.url}/form`, actions: [{ kind: "wait", duration_ms: 300 }] },
        { name: long, url: `${app.url}/missing`, actions: [{ kind: "wait", duration_ms: 300 }] },
        { name: "ok-again", url: `${app.url}/form`, actions: [{ kind: "wait", duration_ms: 300 }] },
      ]),
      outDir: out, seed: 1, captureFrames: false, allowPrivateNetwork: true,
    });
    expect(res.failedScenes).toEqual([long]);
    const log = parseEventLog(JSON.parse(readFileSync(join(out, "events.json"), "utf8")));
    expect(log.failed_scenes).toEqual([long.slice(0, 200)]);
  }, 60_000);

  it("aborts without filming when the first scene's entry page answers an HTTP error", async () => {
    const out = outDir("first404");
    const res = await record({
      recipe: recipeOf([
        { name: "first", url: `${app.url}/missing`, actions: [{ kind: "wait", duration_ms: 300 }] },
        { name: "second", url: `${app.url}/form`, actions: [{ kind: "wait", duration_ms: 300 }] },
      ]),
      outDir: out, seed: 1, allowPrivateNetwork: true,
    });
    expect(res.aborted).toBe(true);
    expect(res.failedScenes).toEqual(["first"]);
    expect(res.sceneErrors["first"]).toMatch(/^entry page .*\/missing returned 404; is your app running there/);
    expect(res.frameCount).toBe(0);
    const log = parseEventLog(JSON.parse(readFileSync(join(out, "events.json"), "utf8")));
    expect(log.failed_scenes).toEqual(["first"]);
  }, 60_000);
});

type Keys = { down: string[]; press: string[]; up: string[]; input: [string, string | null][] };

async function typeInto(url: string, text: string) {
  const { result: res, logs } = await logsDuring(() =>
    record({
      recipe: recipeOf([{
        name: "type", url,
        actions: [{ kind: "type", selector: "#q", text, submit: true, duration_ms: 2400 }], hold_ms: 400,
      }]),
      outDir: outDir("type"), seed: 6, captureFrames: false, allowPrivateNetwork: true,
    }),
  );
  expect(res.failedScenes).toEqual([]);
  const submit = logs.find((l) => l.ev === "submit") as { value: string; suggestions: number; keys: Keys } | undefined;
  expect(submit).toBeDefined();
  return { res, submit: submit! };
}

describe("typing", () => {
  it("types with real key events, so keyup-driven autocomplete reacts", async () => {
    const { submit } = await typeInto(`${app.url}/form`, "pay");
    expect(submit.value).toBe("pay");
    for (const k of ["p", "a", "y"]) {
      expect(submit.keys.down).toContain(k);
      expect(submit.keys.press).toContain(k);
      expect(submit.keys.up).toContain(k);
    }
    // the suggestions list is built only on keyup: "payments", "payouts"
    expect(submit.suggestions).toBe(2);
    // an empty field is not cleared first
    expect(submit.keys.down).not.toContain("Backspace");
  }, 60_000);

  it("clears a prefilled field with select-all and delete before typing", async () => {
    const { submit } = await typeInto(`${app.url}/form?prefill=stale`, "pay");
    expect(submit.value).toBe("pay");
    const down = submit.keys.down;
    expect(down.indexOf("Backspace")).toBeGreaterThan(-1);
    expect(down.indexOf("Backspace")).toBeLessThan(down.indexOf("p"));
    expect(submit.keys.input[0]).toEqual(["deleteContentBackward", null]);
  }, 60_000);

  it("types grapheme by grapheme: keys for what a keyboard has, one insert per other grapheme", async () => {
    const text = "née 👩‍💻!";
    const { submit, res } = await typeInto(`${app.url}/form`, text);
    expect(submit.value).toBe(text);
    const inserted = submit.keys.input.filter(([type]) => type === "insertText").map(([, data]) => data);
    expect(inserted).toEqual(["n", "é", "e", " ", "👩‍💻", "!"]);
    // keyboard-producible characters arrive as real keys; é and the emoji do not
    expect(submit.keys.up).toEqual(expect.arrayContaining(["n", "e", " ", "!"]));
    expect(submit.keys.up).not.toContain("é");
    const typed = res.eventLog.events.find((e) => e.type === "type");
    expect(typed?.textLen).toBe(6);
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
    // the take declares that every page change is in its log
    const log = parseEventLog(JSON.parse(readFileSync(join(res.outDir, "events.json"), "utf8")));
    expect(log.navigation_logged).toBe(true);
    expect(log.failed_scenes).toEqual([]);
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
    // the picture the page showed before the commit. Pictures are compared by
    // their bytes: a file name only says the frame differed from the one
    // written just before it, so the same picture can sit in two files
    const picture = (file: string) => readFileSync(join(res.outDir, file)).toString("base64");
    const before = idx.filter((e) => e.t_source < nav.observed_t!).at(-1)!;
    const around = idx
      .filter((e) => e.t_source >= nav.observed_t! - 300 && e.t_source <= nav.t + 100)
      .map((e) => `${e.t_source.toFixed(1)} ${e.file}`)
      .join(", ");
    const why = `commit ${nav.observed_t!.toFixed(1)}, stamp ${nav.t.toFixed(1)}; frames ${around}`;
    expect(picture(idx[at]!.file), why).not.toBe(picture(before.file));
    for (const e of idx.filter((x) => x.t_source >= nav.observed_t! && x.t_source < nav.t)) {
      expect(picture(e.file) === picture(before.file), `${e.t_source.toFixed(1)} ${e.file}: ${why}`).toBe(true);
    }
  }, 60_000);
});
