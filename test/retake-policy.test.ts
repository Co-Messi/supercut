import { describe, expect, it } from "vitest";
import type { RecordResult } from "../src/capture/executor.js";
import { applyVerdicts, decideQc, type SceneVerdict } from "../src/director/qc.js";
import { captureConsentPrompt, filmWithRetakes, MAX_RETAKES } from "../src/director/retakes.js";
import { applyTakeAdjustments } from "../src/render/adjust.js";
import { validateFrameIndex } from "../src/render/plan.js";
import { parseEventLog, parseRecipe, type EventLog, type Recipe } from "../src/schema/index.js";

/**
 * QC re-takes repeat every side effect of the recipe on the live app, so the
 * number of performances per human consent must be bounded and stated, and a
 * verdict that only asks for a longer hold or a different camera box must be
 * applied at render time instead of filming everything again.
 */

const recipe: Recipe = parseRecipe({
  version: 0,
  app_url: "http://127.0.0.1:9999",
  music_track: "off",
  scenes: [
    {
      name: "signup", priority: 1, entry: { url: "http://127.0.0.1:9999/", prelude: [] }, depends_on: [],
      actions: [
        { kind: "click", selector: "#cta", duration_ms: 1200 },
        { kind: "type", selector: "#email", text: "ada@example.com", duration_ms: 1800 },
      ],
      hold_ms: 600,
    },
    {
      name: "dash", priority: 2, entry: { url: "http://127.0.0.1:9999/dash", prelude: [] }, depends_on: [],
      actions: [{ kind: "hover", selector: "#row", duration_ms: 1200 }],
      hold_ms: 800,
    },
  ],
});

const v = (scene: string, verdict: SceneVerdict["verdict"], patch?: SceneVerdict["patch"]): SceneVerdict => ({
  scene, verdict, reason: "qc", ...(patch ? { patch } : {}),
});

describe("decideQc: what a verdict changes", () => {
  it("an empty patch changes nothing and films nothing again", () => {
    const d = decideQc(recipe, [v("signup", "patch", {})]);
    expect(d.cut).toEqual([]);
    expect(d.retakeRecipe).toBeUndefined();
    expect(d.adjustments).toEqual({ holds: [], zooms: [] });
    expect(applyVerdicts(recipe, [v("signup", "patch", {})]).changed).toBe(false);
  });

  it("a hold that equals the recorded hold is not a change", () => {
    const d = decideQc(recipe, [v("signup", "patch", { hold_ms: 600 })]);
    expect(d.adjustments.holds).toEqual([]);
    expect(applyVerdicts(recipe, [v("signup", "patch", { hold_ms: 600 })]).changed).toBe(false);
  });

  it("a longer hold becomes a render-time adjustment, not a re-take", () => {
    const d = decideQc(recipe, [v("signup", "patch", { hold_ms: 1400 })]);
    expect(d.retakeRecipe).toBeUndefined();
    expect(d.adjustments.holds).toEqual([{ scene: "signup", extraMs: 800 }]);
  });

  it("a zoom patch targets the event its action produced (a type frames its type event)", () => {
    const d = decideQc(recipe, [v("signup", "patch", { action_index: 1, zoom: [10, 20, 300, 200] })]);
    // click #cta → click event 0; type #email → click event 1, type event 2
    expect(d.adjustments.zooms).toEqual([{ scene: "signup", focusEvent: 2, bbox: [10, 20, 300, 200] }]);
    expect(d.retakeRecipe).toBeUndefined();
  });

  it("only a cut re-records, and the re-take films the other patches for real", () => {
    const d = decideQc(recipe, [v("dash", "cut"), v("signup", "patch", { hold_ms: 1000 })]);
    expect(d.cut).toEqual(["dash"]);
    expect(d.retakeRecipe?.scenes.map((s) => s.name)).toEqual(["signup"]);
    expect(d.retakeRecipe?.scenes[0]!.hold_ms).toBe(1000);
  });

  it("holds that would push the video past 60 seconds are dropped (the patched recipe must parse)", () => {
    const long = parseRecipe({
      ...recipe,
      scenes: recipe.scenes.map((s) => ({ ...s, actions: s.actions.map((a) => ({ ...a, duration_ms: 17000 })) })),
    });
    const verdicts = [v("signup", "patch", { hold_ms: 3000 }), v("dash", "patch", { hold_ms: 3000 })];
    const d = decideQc(long, verdicts);
    expect(d.adjustments.holds).toEqual([]);
    expect(d.notes.join(" ")).toMatch(/60/);
    // the public applyVerdicts never returns a recipe the parser rejects
    expect(() => parseRecipe(applyVerdicts(long, verdicts).recipe)).not.toThrow();
  });
});

function fakeResult(failed: string[] = []): RecordResult {
  return {
    eventLog: { version: 0, viewport: { width: 1920, height: 1080, dpr: 2 }, fps: 60, events: [] },
    frameCount: 600, avgSourceFps: 60, failedScenes: failed, sceneErrors: {}, aborted: false, outDir: "/tmp/x",
  };
}

describe("filmWithRetakes: performances per consent", () => {
  async function run(qc: (n: number) => SceneVerdict[], film: Recipe = recipe) {
    let performances = 0;
    const out = await filmWithRetakes({
      recipe: film,
      maxRetakes: MAX_RETAKES,
      recordTake: async (_r, i) => {
        performances++;
        return { result: fakeResult(), takeDir: `/tmp/take-${i}` };
      },
      qc: async () => qc(performances),
      log: () => {},
    });
    return { performances, out };
  }

  it("a clean QC films once", async () => {
    expect((await run(() => [v("signup", "ok")])).performances).toBe(1);
  });

  it("an empty patch or a hold-only verdict films once and adjusts the render", async () => {
    expect((await run(() => [v("signup", "patch", {})])).performances).toBe(1);
    const { performances, out } = await run(() => [v("signup", "patch", { hold_ms: 1500 })]);
    expect(performances).toBe(1);
    expect(out.adjustments.holds).toEqual([{ scene: "signup", extraMs: 900 }]);
  });

  it("never performs the recipe more than 1 + MAX_RETAKES times, however QC answers", async () => {
    // an adversarial QC: every take, it cuts one more real scene, never the last
    const many = parseRecipe({
      ...recipe,
      scenes: ["s1", "s2", "s3", "s4", "s5"].map((name, i) => ({
        name, priority: i + 1, entry: { url: "http://127.0.0.1:9999/", prelude: [] }, depends_on: [],
        actions: [{ kind: "click", selector: "#cta", duration_ms: 900 }], hold_ms: 0,
      })),
    });
    const { performances, out } = await run((n) => [v(`s${n}`, "cut")], many);
    expect(performances).toBe(1 + MAX_RETAKES);
    expect(out.retakes).toBe(MAX_RETAKES);
  });

  it("a cut of a scene the recipe does not have films nothing again", async () => {
    expect((await run(() => [v("ghost", "cut")])).performances).toBe(1);
  });

  it("the consent prompt states the bound", () => {
    const text = captureConsentPrompt(1 + MAX_RETAKES);
    expect(text).toContain(`up to ${1 + MAX_RETAKES} times`);
    expect(text).toMatch(/\[y\/N\]/);
  });
});

describe("applyTakeAdjustments: QC holds and zooms at render time", () => {
  // two scenes: signup 0-3000 (click at 1500), dash from 3000; frames every 50ms to 5000
  function take(): { log: EventLog; index: { file: string; t_source: number }[] } {
    const log = parseEventLog({
      version: 0, t_source_unified: true, navigation_logged: true,
      viewport: { width: 1920, height: 1080, dpr: 2 }, fps: 60,
      events: [
        { t: 0, type: "scene", name: "signup", priority: 1 },
        { t: 1500, type: "click", bbox: [10, 10, 100, 40], selector: "#cta", point: [60, 30] },
        { t: 3000, type: "scene", name: "dash", priority: 2 },
        { t: 4000, type: "hover", bbox: [10, 10, 100, 40], selector: "#row" },
        { t: 0, type: "cursor_path", points: [[1000, 5, 5], [1500, 60, 30], [3500, 70, 40]] },
      ],
    });
    const index = Array.from({ length: 101 }, (_, i) => ({ file: `frames/${String(i).padStart(6, "0")}.jpg`, t_source: i * 50 }));
    return { log, index };
  }

  it("freezes the end of a scene's hold and shifts everything after it, frames and events together", () => {
    const { log, index } = take();
    const out = applyTakeAdjustments(log, index, { holds: [{ scene: "signup", extraMs: 1000 }], zooms: [] });
    validateFrameIndex(out.frameIndex);
    expect(() => parseEventLog(out.log)).not.toThrow();
    const dashScene = out.log.events.find((e) => e.type === "scene" && e.name === "dash");
    expect(dashScene?.t).toBe(4000);
    expect(out.log.events.find((e) => e.type === "hover")?.t).toBe(5000);
    // the frozen stretch repeats the last frame before the boundary, at frame cadence
    const frozen = out.frameIndex.filter((e) => e.t_source >= 3000 && e.t_source < 4000);
    expect(new Set(frozen.map((e) => e.file))).toEqual(new Set(["frames/000059.jpg"]));
    expect(frozen.length).toBeGreaterThanOrEqual(59);
    expect(out.frameIndex[out.frameIndex.length - 1]!.t_source).toBe(6000);
    // the cursor track is shifted the same way
    const path = out.log.events.find((e) => e.type === "cursor_path");
    expect(path?.type === "cursor_path" && path.points.map((p) => p[0])).toEqual([1000, 1500, 4500]);
  });

  it("extends the final scene past the last frame", () => {
    const { log, index } = take();
    const out = applyTakeAdjustments(log, index, { holds: [{ scene: "dash", extraMs: 500 }], zooms: [] });
    validateFrameIndex(out.frameIndex);
    expect(out.frameIndex[out.frameIndex.length - 1]!.t_source).toBeGreaterThanOrEqual(5450);
    expect(out.frameIndex.slice(-5).every((e) => e.file === "frames/000100.jpg")).toBe(true);
  });

  it("puts a QC zoom on the scene's Nth interaction event", () => {
    const { log, index } = take();
    const out = applyTakeAdjustments(log, index, { holds: [], zooms: [{ scene: "signup", focusEvent: 0, bbox: [5, 6, 300, 200] }] });
    const click = out.log.events.find((e) => e.type === "click");
    expect(click?.type === "click" && click.focus_bbox).toEqual([5, 6, 300, 200]);
    expect(click?.type === "click" && click.focus_source).toBe("qc");
  });

  it("leaves the inputs untouched and skips an adjustment it cannot place", () => {
    const { log, index } = take();
    const before = JSON.stringify({ log, index });
    const out = applyTakeAdjustments(log, index, { holds: [{ scene: "nope", extraMs: 500 }], zooms: [{ scene: "dash", focusEvent: 7, bbox: [1, 1, 10, 10] }] });
    expect(JSON.stringify({ log, index })).toBe(before);
    expect(out.skipped.length).toBe(2);
  });
});
