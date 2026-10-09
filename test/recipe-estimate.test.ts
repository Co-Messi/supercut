import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRE_ROLL_MS, SETTLE_MS } from "../src/capture/executor.js";
import { FOCUS_DWELL_MS, SETTLE_TAIL_MS, TAIL_MS, ZOOM_DWELL_MS } from "../src/render/plan.js";
import {
  estimatedTakeMs,
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
 * M2: the recipe's video-length estimate must model what the take really
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
