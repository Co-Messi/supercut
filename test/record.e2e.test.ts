import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { record } from "../src/capture/index.js";
import { deterministicChecks } from "../src/director/qc.js";
import { buildRenderPlan, renderTake, SUBFRAMES } from "../src/render/index.js";
import { parseEventLog, parseRecipe, type EventLog, type Recipe } from "../src/schema/index.js";
import { startDemoApp, type DemoApp } from "./fixtures/demo-app/server.js";

const exec = promisify(execFile);

/**
 * Backbone E2E: record the fixture app for real (headless chromium,
 * screencast on) and prove the contract:
 *   - events.json validates against Event-Log Schema v0
 *   - frames exist, the index is monotonic, and capture holds ~60fps
 *     (the repaint beacon defeats change-driven screencast starvation)
 *   - the timeline canon is reproducible across two runs: identical structure
 *     and geometry; `t` rides the observed clock (shared with frame t_source)
 *     so it may carry a few ms of wall jitter, nothing more
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

function loadEvents(eventsJsonPath: string): EventLog["events"] {
  return parseEventLog(JSON.parse(readFileSync(eventsJsonPath, "utf8"))).events;
}

/** canonical structure = everything except time stamps: event `t`/`observed_t`
 *  ride the observed clock (shared with frame t_source) and carry wall jitter;
 *  types, order, selectors, geometry, and cursor x/y must be byte-identical */
function structuralTimeline(events: EventLog["events"]): string {
  return JSON.stringify(
    events.map((e) => {
      const { t: _t, observed_t: _o, ...rest } = e as { t: number; observed_t?: number } & Record<string, unknown>;
      if (e.type === "cursor_path") {
        return { ...rest, points: e.points.map(([, x, y]) => [x, y]) };
      }
      return rest;
    }),
  );
}

/** 1s 440Hz mono 16-bit PCM WAV, written by hand — no codec availability
 *  guesswork (ffmpeg builds may lack lavfi/libmp3lame; all accept WAV input) */
function writeToneWav(path: string): void {
  const sr = 44100;
  const n = sr; // 1 second
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000), i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write("WAVE", 8);
  hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16); // PCM chunk size
  hdr.writeUInt16LE(1, 20); // PCM format
  hdr.writeUInt16LE(1, 22); // mono
  hdr.writeUInt32LE(sr, 24);
  hdr.writeUInt32LE(sr * 2, 28); // byte rate
  hdr.writeUInt16LE(2, 32); // block align
  hdr.writeUInt16LE(16, 34); // bits per sample
  hdr.write("data", 36);
  hdr.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([hdr, data]));
}

/** all `t` stamps in event order (cursor_path point times appended last) */
function timeStamps(events: EventLog["events"]): number[] {
  const ts: number[] = [];
  for (const e of events) {
    if (e.type === "cursor_path") ts.push(...e.points.map(([t]) => t));
    else ts.push(e.t);
  }
  return ts;
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

    const r1 = await record({ recipe, outDir: out1, seed: 42, allowPrivateNetwork: true });
    const r2 = await record({ recipe, outDir: out2, seed: 42, allowPrivateNetwork: true });

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

    // timing canon (PR #1 review): scene 2 may not start before scene 1's
    // full budget (actions 4600 + hold 400), and its first action must sit
    // at least the nav allowance after the scene marker
    const sceneEvents = log.events.filter((e) => e.type === "scene");
    const scene2T = sceneEvents[1]!.t;
    expect(scene2T).toBeGreaterThanOrEqual(5000);
    const hoverEvent = log.events.find((e) => e.type === "hover")!;
    expect(hoverEvent.t).toBeGreaterThanOrEqual(scene2T + 1000);

    // capture fluency: the repaint beacon must defeat change-driven screencast
    // starvation — ~60fps average, and no stall outside the one deliberate
    // frame-suppression window around the scene-2 navigation. Bounds leave
    // headroom for machine-load jitter (starvation was p95 430ms / max 4.1s;
    // an occasional ~100ms PNG-write hiccup under parallel test load is not it)
    const spanMs = idx[idx.length - 1]!.t_source - idx[0]!.t_source;
    const avgFps = ((idx.length - 1) / spanMs) * 1000;
    expect(avgFps).toBeGreaterThanOrEqual(50);
    const dwellGaps: number[] = [];
    for (let i = 1; i < idx.length; i++) {
      const inNavWindow = idx[i]!.t_source > scene2T - 200 && idx[i - 1]!.t_source < scene2T + 2500;
      if (!inNavWindow) dwellGaps.push(idx[i]!.t_source - idx[i - 1]!.t_source);
    }
    dwellGaps.sort((a, b) => a - b);
    expect(dwellGaps[Math.floor(dwellGaps.length * 0.95)]!).toBeLessThanOrEqual(50);
    expect(dwellGaps[dwellGaps.length - 1]!).toBeLessThanOrEqual(200);

    // clock unification: events are stamped on the frame timeline, so the
    // event timeline may never lead the footage by more than the render gate
    let maxEventT = 0;
    for (const t of timeStamps(log.events)) maxEventT = Math.max(maxEventT, t);
    expect(maxEventT - idx[idx.length - 1]!.t_source).toBeLessThanOrEqual(250);

    // reproducibility: same recipe + seed → identical structure and geometry;
    // `t` rides the observed clock so it may differ by wall jitter only
    const e1 = loadEvents(join(out1, "events.json"));
    const e2 = loadEvents(join(out2, "events.json"));
    expect(structuralTimeline(e1)).toBe(structuralTimeline(e2));
    const t1 = timeStamps(e1);
    const t2 = timeStamps(e2);
    expect(t1.length).toBe(t2.length);
    for (let i = 0; i < t1.length; i++) {
      expect(Math.abs(t1[i]! - t2[i]!)).toBeLessThanOrEqual(150);
    }

    // ---- render the take: full record→render pipeline proof ----
    const mp4 = join(out1, "final.mp4");
    const res = await renderTake({ takeDir: out1, outFile: mp4 });
    expect(res.frames).toBeGreaterThan(120);
    expect(statSync(mp4).size).toBeGreaterThan(100_000);
    // delivered-bitrate accounting rides the result (bytes over plan duration)
    expect(res.deliveredBitrate).toBeGreaterThan(0);
    expect(res.deliveredBitrate).toBeCloseTo((res.encodedBytes * 8) / (res.frames / 60), -3);

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

    // ---- music mux: same take + a generated tone → exactly one video and
    // one aac audio stream; the looped-and-clamped audio never stretches the
    // container beyond the silent render ----
    const tonePath = join(out1, "tone.wav");
    writeToneWav(tonePath);
    const mp4Music = join(out1, "final-music.mp4");
    const resMusic = await renderTake({ takeDir: out1, outFile: mp4Music, music: tonePath });
    expect(resMusic.music).toBe(tonePath);
    const musicProbe = JSON.parse(
      (await exec("ffprobe", [
        "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", mp4Music,
      ])).stdout,
    ) as {
      streams: { codec_type: string; codec_name: string }[];
      format: { duration: string };
    };
    expect(musicProbe.streams).toHaveLength(2);
    expect(musicProbe.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort()).toEqual([
      "audio:aac",
      "video:h264",
    ]);
    expect(Math.abs(Number(musicProbe.format.duration) - Number(probe.format.duration))).toBeLessThan(0.2);
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
    const res = await record({ recipe, outDir: out, seed: 1, captureFrames: false, allowPrivateNetwork: true });

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
    const res = await record({ recipe, outDir: out, seed: 1, captureFrames: false, allowPrivateNetwork: true });

    expect(res.aborted).toBe(false); // 1 of 3 ≤ 50% → take survives
    expect(res.failedScenes).toEqual(["bad-mid"]);

    const verdicts = deterministicChecks(res);
    expect(verdicts).toContainEqual(
      expect.objectContaining({ scene: "bad-mid", verdict: "cut" }),
    );
  }, 120_000);

  it("wires a QC zoom patch end to end: action.zoom becomes the framed focus_bbox", async () => {
    const zoom: [number, number, number, number] = [200, 150, 900, 600];
    const recipe = parseRecipe({
      version: 0,
      app_url: app.url,
      music_track: "institutional-01",
      scenes: [
        {
          name: "landing", priority: 1,
          entry: { url: `${app.url}/`, prelude: [] }, depends_on: [],
          actions: [{ kind: "click", selector: "#cta", duration_ms: 1600, zoom }],
          hold_ms: 0,
        },
      ],
    });

    const out = mkdtempSync(join(tmpdir(), "supercut-zoom-"));
    dirs.push(out);
    const res = await record({ recipe, outDir: out, seed: 7, captureFrames: false, allowPrivateNetwork: true });
    expect(res.failedScenes).toEqual([]);

    const click = res.eventLog.events.find((e) => e.type === "click");
    expect(click).toBeDefined();
    expect(click!.focus_bbox).toEqual(zoom);
    expect(click!.focus_source).toBe("qc");

    // and the render plan frames THAT bbox: camera focus settles on its center
    const syntheticIndex = Array.from({ length: 600 }, (_, i) => ({
      file: `frames/${String(i).padStart(6, "0")}.png`,
      t_source: Math.round(i * 16.7),
    }));
    const plan = buildRenderPlan(res.eventLog, syntheticIndex);
    const layout = plan.layout;
    const s = layout.content.w / layout.viewport.width;
    const expected = {
      x: layout.content.x + (zoom[0] + zoom[2] / 2) * s,
      y: layout.content.y + (zoom[1] + zoom[3] / 2) * s,
    };
    // sample ~1.2s after the click so the spring has settled on the target
    const f = Math.min(plan.frames - 1, Math.round((click!.t + 1200) / (1000 / 60)));
    const i = f * SUBFRAMES * 3;
    expect(plan.camera[i]!).toBeGreaterThan(1.05); // a real punch-in
    expect(Math.abs(plan.camera[i + 1]! - expected.x)).toBeLessThan(40);
    expect(Math.abs(plan.camera[i + 2]! - expected.y)).toBeLessThan(40);
  }, 120_000);

  it("scroll actions keep the distance/slot contract while easing across the whole slot", async () => {
    const recipe = parseRecipe({
      version: 0,
      app_url: app.url,
      music_track: "institutional-01",
      scenes: [
        {
          name: "dash-scroll", priority: 1,
          entry: { url: `${app.url}/dash`, prelude: [] }, depends_on: [],
          actions: [{ kind: "scroll", duration_ms: 1600 }],
          hold_ms: 0,
        },
      ],
    });

    const out = mkdtempSync(join(tmpdir(), "supercut-scroll-"));
    dirs.push(out);
    const res = await record({ recipe, outDir: out, seed: 7, captureFrames: false, allowPrivateNetwork: true });
    expect(res.failedScenes).toEqual([]);

    const scroll = res.eventLog.events.find((e) => e.type === "scroll");
    expect(scroll).toBeDefined();
    // total distance semantics unchanged: 600px of content travel
    expect(scroll!.to[1] - scroll!.from[1]).toBe(600);
    // the eased wheel stream spans the WHOLE slot (old code finished in half)
    expect(scroll!.observed_t! - scroll!.t).toBeGreaterThanOrEqual(1600 * 0.9);
  }, 120_000);

  it("frames the result by default: mutation fallback fills focus_bbox when the LLM named none", async () => {
    const recipe = parseRecipe({
      version: 0,
      app_url: app.url,
      music_track: "institutional-01",
      scenes: [
        {
          name: "query-panel", priority: 1,
          entry: { url: `${app.url}/panel`, prelude: [] }, depends_on: [],
          // long slot: the collect window (1.2s) must outlive the 400ms toast
          actions: [{ kind: "click", selector: "#reveal", duration_ms: 3000 }],
          hold_ms: 0,
        },
      ],
    });

    const out = mkdtempSync(join(tmpdir(), "supercut-mutation-"));
    dirs.push(out);
    const res = await record({ recipe, outDir: out, seed: 7, captureFrames: false, allowPrivateNetwork: true });
    expect(res.failedScenes).toEqual([]);

    const click = res.eventLog.events.find((e) => e.type === "click");
    expect(click).toBeDefined();
    expect(click!.focus_source).toBe("mutation");
    const [fx, fy, fw, fh] = click!.focus_bbox!;
    // the revealed #results panel, not the button: a large region
    expect(fw).toBeGreaterThan(600);
    expect(fh).toBeGreaterThan(300);
    // the transient toast (fixed bottom-right, removed after 400ms) must NOT
    // stretch the framed result to the viewport corner
    expect(fx + fw).toBeLessThan(1560);
    expect(fy + fh).toBeLessThan(900);
  }, 120_000);
});
