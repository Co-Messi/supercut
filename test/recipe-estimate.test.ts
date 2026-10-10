import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRE_ROLL_MS, SETTLE_MS } from "../src/capture/executor.js";
import { FOCUS_DWELL_MS, SETTLE_TAIL_MS, TAIL_MS, ZOOM_DWELL_MS } from "../src/render/plan.js";
import {
  ENTER_BEAT_MS,
  estimatedTakeMs,
  MIN_KEY_GAP_MS,
  MIN_TYPE_ACTION_MS,
  minTypeActionMs,
  parseRecipe,
  RELOAD_ALLOWANCE_MS,
  SCENE_CHANGE_MS,
  SCENE_PRE_ROLL_MS,
  SCENE_SETTLE_MS,
  TAKE_TAIL_MS,
  takeTailMs,
  totalBudgetMs,
  type Recipe,
} from "../src/schema/index.js";

/**
 * the recipe's video-length estimate must model what the take really
 * adds around the scripted durations. Per later scene the executor reloads
 * the entry URL, settles, and pre-rolls the new page; at the end the render
 * runs past the last beat until its dwell and zoom-out have settled.
 */
type Step = Recipe["scenes"][number]["actions"][number];
const wait = (ms: number): Step => ({ kind: "wait", duration_ms: ms });
const click = (ms: number, focus = false): Step => ({
  kind: "click", selector: "#x", duration_ms: ms, ...(focus ? { focus_selector: "#result" } : {}),
});

function recipe(lastActions: Step[], lastHold: number, scenes = 1): Recipe {
  const scene = (i: number, actions: Step[], hold: number) => ({
    name: `s${i}`, priority: 1, entry: { url: `http://localhost:3000/${i}`, prelude: [] }, depends_on: [], actions, hold_ms: hold,
  });
  return parseRecipe({
    version: 0,
    app_url: "http://localhost:3000",
    music_track: "daybreak",
    scenes: [
      ...Array.from({ length: scenes - 1 }, (_, i) => scene(i, [wait(1000)], 0)),
      scene(scenes - 1, lastActions, lastHold),
    ],
  });
}

describe("take overhead model", () => {
  it("a scene change costs the reload allowance, the settle and the new page's pre-roll", () => {
    expect(SCENE_SETTLE_MS).toBe(SETTLE_MS);
    expect(SCENE_PRE_ROLL_MS).toBe(PRE_ROLL_MS);
    expect(SCENE_CHANGE_MS).toBe(RELOAD_ALLOWANCE_MS + SCENE_SETTLE_MS + SCENE_PRE_ROLL_MS);
    // a remote app reloads in 0.3 to 3s; 1s is the planning allowance
    expect(RELOAD_ALLOWANCE_MS).toBeGreaterThanOrEqual(1000);
  });

  it("mirrors the render planner's tail constants", () => {
    expect(TAKE_TAIL_MS).toBe(TAIL_MS);
  });

  it("the tail runs past the final beat's dwell and zoom-out settle", () => {
    // a click or type can always become a framed payoff: with no
    // focus_selector the recorder frames the region its DOM change touched
    expect(takeTailMs(recipe([click(1000)], 0))).toBe(FOCUS_DWELL_MS + SETTLE_TAIL_MS);
    expect(takeTailMs(recipe([click(1000, true)], 0))).toBe(FOCUS_DWELL_MS + SETTLE_TAIL_MS);
    // a hover frames a payoff only when the script names one
    const hover = (focus: boolean): Step => ({
      kind: "hover", selector: "#h", duration_ms: 1000, ...(focus ? { focus_selector: "#result" } : {}),
    });
    expect(takeTailMs(recipe([hover(false)], 0))).toBe(ZOOM_DWELL_MS + SETTLE_TAIL_MS);
    expect(takeTailMs(recipe([hover(true)], 0))).toBe(FOCUS_DWELL_MS + SETTLE_TAIL_MS);
    // the scene's final hold and any later non-beat step already cover part of it
    expect(takeTailMs(recipe([click(1000, true)], 2000))).toBe(FOCUS_DWELL_MS + SETTLE_TAIL_MS - 2000);
    expect(takeTailMs(recipe([click(1000, true), wait(3000)], 2000))).toBe(TAIL_MS);
    // no beat at all: only the minimum tail
    expect(takeTailMs(recipe([wait(1000)], 0))).toBe(TAIL_MS);
  });

  it("the latest-ending beat sets the tail, not just the last one", () => {
    // a click, then a short plain hover: the click's payoff (dwell 2400)
    // outlasts the hover's (dwell 1200) by more than the hover's slot
    const r = recipe([click(1000), { kind: "hover", selector: "#y", duration_ms: 300 }], 0);
    expect(takeTailMs(r)).toBe(FOCUS_DWELL_MS + SETTLE_TAIL_MS - 300);
  });

  it("estimatedTakeMs = budget + head + scene changes + tail", () => {
    const r = recipe([click(1500, true)], 1000, 3);
    expect(estimatedTakeMs(r)).toBe(totalBudgetMs(r) + 1000 + 2 * SCENE_CHANGE_MS + takeTailMs(r));
  });

  it("the bundled demo recipe estimates at or above its measured localhost take", () => {
    const demo = parseRecipe(JSON.parse(readFileSync(join(import.meta.dirname, "..", "examples", "demo.recipe.json"), "utf8")));
    // measured: 11.83s rendered on localhost (reload about 400ms)
    expect(estimatedTakeMs(demo)).toBeGreaterThanOrEqual(11_833);
  });
});

describe("typed text in the estimate", () => {
  const type = (text: string, ms: number, submit = false): Step => ({
    kind: "type", selector: "#q", text, duration_ms: ms, ...(submit ? { submit } : {}),
  });

  it("a type action counts at least as long as typing its text takes", () => {
    const text = "x".repeat(101); // 100 gaps between keys
    const floor = minTypeActionMs(text, false);
    expect(floor).toBe(MIN_TYPE_ACTION_MS + 100 * MIN_KEY_GAP_MS);
    expect(minTypeActionMs(text, true)).toBe(floor + ENTER_BEAT_MS);
    // a 1s slot for 101 keys is not 1s of video
    expect(totalBudgetMs(recipe([type(text, 1000)], 0))).toBe(floor);
    // a slot longer than the typing keeps its own length
    expect(totalBudgetMs(recipe([type("hi", 3000)], 0))).toBe(3000);
  });

  it("mirrors the recorder's fastest typing pace", async () => {
    const { KEY_MEAN_MIN_MS } = await import("../src/capture/cursor.js");
    expect(MIN_KEY_GAP_MS).toBe(KEY_MEAN_MIN_MS);
  });

  it("counts graphemes, not UTF-16 units: an emoji sequence is one key", () => {
    const emoji = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
    expect(minTypeActionMs(`${emoji}!`, false)).toBe(MIN_TYPE_ACTION_MS + MIN_KEY_GAP_MS);
  });

  it("refuses a recipe whose typing alone would run past 60 seconds", () => {
    expect(() => recipe([type("y".repeat(480), 1000)], 0)).not.toThrow(); // under the cap
    expect(() => recipe([type("y".repeat(480), 1000), type("z".repeat(480), 1000)], 0)).toThrow(/ceiling/);
  });

  it("caps typed text at 500 characters", () => {
    expect(() => recipe([type("a".repeat(501), 30_000)], 0)).toThrow();
  });
});
