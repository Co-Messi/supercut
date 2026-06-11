import { describe, expect, it } from "vitest";
import {
  MAX_BUDGET_MS,
  parseEventLog,
  parseRecipe,
  RecipeValidationError,
  totalBudgetMs,
} from "../src/schema/index.js";

const validEventLog = {
  version: 0,
  viewport: { width: 1920, height: 1080, dpr: 2 },
  fps: 60,
  events: [
    {
      t: 1234,
      type: "click",
      bbox: [10, 20, 100, 40],
      selector: "#signup",
      point: [60, 40],
      observed_t: 1241,
    },
    { t: 4000, type: "scene", name: "dashboard", priority: 1 },
  ],
};

function makeRecipe(overrides: Record<string, unknown> = {}) {
  return {
    version: 0,
    app_url: "http://localhost:3000",
    music_track: "institutional-01",
    scenes: [
      {
        name: "landing",
        priority: 1,
        entry: { url: "http://localhost:3000/", prelude: [] },
        depends_on: [],
        actions: [
          { kind: "click", selector: "#signup", duration_ms: 2000, zoom: [0, 0, 200, 80] },
        ],
        hold_ms: 500,
      },
    ],
    ...overrides,
  };
}

describe("event log schema", () => {
  it("parses a valid event log", () => {
    const log = parseEventLog(validEventLog);
    expect(log.events).toHaveLength(2);
    expect(log.viewport.dpr).toBe(2);
  });

  it("silently drops unknown event types (forward compatibility)", () => {
    const withUnknown = {
      ...validEventLog,
      events: [
        ...validEventLog.events,
        { t: 5000, type: "pinch_zoom", fingers: 2 },
      ],
    };
    const log = parseEventLog(withUnknown);
    expect(log.events).toHaveLength(2);
  });

  it("fails loudly on a malformed KNOWN event", () => {
    const broken = {
      ...validEventLog,
      events: [{ t: 1, type: "click", selector: "#x" }], // missing bbox + point
    };
    expect(() => parseEventLog(broken)).toThrow();
  });

  it("rejects negative timestamps", () => {
    const broken = {
      ...validEventLog,
      events: [{ t: -5, type: "scene", name: "x", priority: 1 }],
    };
    expect(() => parseEventLog(broken)).toThrow();
  });
});

describe("recipe schema", () => {
  it("parses a valid recipe", () => {
    const r = parseRecipe(makeRecipe());
    expect(r.scenes).toHaveLength(1);
    expect(totalBudgetMs(r)).toBe(2500);
  });

  it("rejects a recipe over the 60s hard ceiling", () => {
    const over = makeRecipe({
      scenes: [
        {
          name: "too-long",
          priority: 1,
          entry: { url: "http://localhost:3000/", prelude: [] },
          depends_on: [],
          actions: [
            { kind: "wait", duration_ms: MAX_BUDGET_MS + 1 },
          ],
          hold_ms: 0,
        },
      ],
    });
    expect(() => parseRecipe(over)).toThrow(RecipeValidationError);
    expect(() => parseRecipe(over)).toThrow(/hard ceiling/);
  });

  it("rejects depends_on pointing at a LATER scene (order is immutable)", () => {
    const bad = makeRecipe({
      scenes: [
        {
          name: "view-item",
          priority: 2,
          entry: { url: "http://localhost:3000/items/1", prelude: [] },
          depends_on: ["create-item"], // defined below — later, so invalid
          actions: [{ kind: "hover", selector: ".item", duration_ms: 1000 }],
          hold_ms: 0,
        },
        {
          name: "create-item",
          priority: 1,
          entry: { url: "http://localhost:3000/new", prelude: [] },
          depends_on: [],
          actions: [{ kind: "click", selector: "#save", duration_ms: 1000 }],
          hold_ms: 0,
        },
      ],
    });
    expect(() => parseRecipe(bad)).toThrow(RecipeValidationError);
  });

  it("accepts depends_on pointing at an earlier scene", () => {
    const good = makeRecipe({
      scenes: [
        {
          name: "create-item",
          priority: 1,
          entry: { url: "http://localhost:3000/new", prelude: [] },
          depends_on: [],
          actions: [{ kind: "click", selector: "#save", duration_ms: 1000 }],
          hold_ms: 0,
        },
        {
          name: "view-item",
          priority: 2,
          entry: { url: "http://localhost:3000/items/1", prelude: [] },
          depends_on: ["create-item"],
          actions: [{ kind: "hover", selector: ".item", duration_ms: 1000 }],
          hold_ms: 0,
        },
      ],
    });
    const r = parseRecipe(good);
    expect(r.scenes[1]?.depends_on).toEqual(["create-item"]);
  });

  it("rejects duplicate scene names", () => {
    const dup = makeRecipe();
    const scenes = (dup as { scenes: unknown[] }).scenes;
    scenes.push(structuredClone(scenes[0]));
    expect(() => parseRecipe(dup)).toThrow(/duplicate scene name/);
  });
});
