import { describe, expect, it, vi } from "vitest";
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

  it("drops unknown event types but warns once (A3 — forward compat, not silent)", () => {
    const withUnknown = {
      ...validEventLog,
      events: [
        ...validEventLog.events,
        { t: 5000, type: "pinch_zoom", fingers: 2 },
      ],
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const log = parseEventLog(withUnknown);
      expect(log.events).toHaveLength(2); // known events only
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0]![0] as string;
      expect(msg).toContain("pinch_zoom");
      expect(msg).toContain("dropped 1 event");
    } finally {
      warn.mockRestore();
    }
  });

  it("dedupes dropped type names and counts the total (A3)", () => {
    const withUnknown = {
      ...validEventLog,
      events: [
        ...validEventLog.events,
        { t: 5000, type: "pinch_zoom", fingers: 2 },
        { t: 6000, type: "pinch_zoom", fingers: 3 }, // same unknown type
        { t: 7000, type: "long_press" },
      ],
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const log = parseEventLog(withUnknown);
      expect(log.events).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = warn.mock.calls[0]![0] as string;
      // distinct type names, deduped, but count reflects all 3 dropped events
      expect(msg).toContain("dropped 3 event");
      expect(msg).toContain("pinch_zoom");
      expect(msg).toContain("long_press");
      // "pinch_zoom" listed once, not twice
      expect(msg.match(/pinch_zoom/g)!).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("fails loudly on a malformed KNOWN event", () => {
    const broken = {
      ...validEventLog,
      events: [{ t: 1, type: "click", selector: "#x" }], // missing bbox + point
    };
    expect(() => parseEventLog(broken)).toThrow();
  });

  it("accepts focus_bbox + focus_source and rejects an unknown source", () => {
    const focusedClick = {
      t: 1234, type: "click", bbox: [10, 20, 100, 40], selector: "#q", point: [60, 40],
      focus_bbox: [200, 300, 800, 500], focus_source: "mutation",
    };
    const log = parseEventLog({ ...validEventLog, events: [focusedClick] });
    expect(log.events[0]).toMatchObject({ focus_source: "mutation" });

    expect(() =>
      parseEventLog({ ...validEventLog, events: [{ ...focusedClick, focus_source: "vibes" }] }),
    ).toThrow();
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

describe("recipe hardening (PR #1 review)", () => {
  it("rejects non-http(s) URL schemes everywhere", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://x.com/a"]) {
      expect(() => parseRecipe(makeRecipe({ app_url: url }))).toThrow(/http/);
    }
  });

  it("rejects a click action without a selector", () => {
    const r = makeRecipe();
    (r as { scenes: { actions: Record<string, unknown>[] }[] }).scenes[0]!.actions = [
      { kind: "click", duration_ms: 1000 },
    ];
    expect(() => parseRecipe(r)).toThrow(/requires a selector/);
  });

  it("rejects a goto action without a url", () => {
    const r = makeRecipe();
    (r as { scenes: { actions: Record<string, unknown>[] }[] }).scenes[0]!.actions = [
      { kind: "goto", duration_ms: 1000 },
    ];
    expect(() => parseRecipe(r)).toThrow(/requires a url/);
  });

  it("rejects a type action without text", () => {
    const r = makeRecipe();
    (r as { scenes: { actions: Record<string, unknown>[] }[] }).scenes[0]!.actions = [
      { kind: "type", selector: "#email", duration_ms: 1000 },
    ];
    expect(() => parseRecipe(r)).toThrow(/requires text/);
  });

  it("rejects sub-200ms action durations (cursor travel floor)", () => {
    const r = makeRecipe();
    (r as { scenes: { actions: Record<string, unknown>[] }[] }).scenes[0]!.actions = [
      { kind: "click", selector: "#cta", duration_ms: 50 },
    ];
    expect(() => parseRecipe(r)).toThrow();
  });
});

describe("schema hardening", () => {
  it("rejects unknown recipe fields instead of silently dropping hallucinated keys", () => {
    const raw = makeRecipe();
    (raw.scenes[0] as unknown as Record<string, unknown>).voiceover = "this field is not supported";
    expect(() => parseRecipe(raw)).toThrow();
  });

  it("rejects invalid zoom boxes", () => {
    const raw = makeRecipe();
    raw.scenes[0]!.actions[0]!.zoom = [-10, 0, -1, 0];
    expect(() => parseRecipe(raw)).toThrow(/zoom/i);
  });

  it("rejects event logs with too many events", () => {
    const events = Array.from({ length: 5001 }, (_, i) => ({ type: "scene", t: i, name: `s${i}`, priority: 1 }));
    expect(() => parseEventLog({ version: 0, viewport: { width: 1920, height: 1080, dpr: 2 }, fps: 60, events })).toThrow(
      /too many events/i,
    );
  });

  it("rejects cursor paths with too many points", () => {
    const points = Array.from({ length: 20001 }, (_, i) => [i, 1, 1]);
    expect(() =>
      parseEventLog({
        version: 0,
        viewport: { width: 1920, height: 1080, dpr: 2 },
        fps: 60,
        events: [{ type: "cursor_path", t: 0, points }],
      }),
    ).toThrow(/too many cursor points/i);
  });

  it("rejects known events that go backwards in time", () => {
    expect(() =>
      parseEventLog({
        version: 0,
        viewport: { width: 1920, height: 1080, dpr: 2 },
        fps: 60,
        events: [
          { type: "scene", t: 100, name: "a", priority: 1 },
          { type: "click", t: 50, bbox: [0, 0, 10, 10], selector: "#x", point: [5, 5] },
        ],
      }),
    ).toThrow(/monotonic/i);
  });
});

describe("submit + frame-the-result schema (4b)", () => {
  it("accepts a type action with submit and focus_selector", () => {
    const r = parseRecipe(
      makeRecipe({
        scenes: [
          {
            name: "search",
            priority: 1,
            entry: { url: "http://localhost:3000/", prelude: [] },
            depends_on: [],
            actions: [
              { kind: "type", selector: "#q", text: "NVDA", submit: true, focus_selector: "#graph", duration_ms: 2000 },
            ],
            hold_ms: 500,
          },
        ],
      }),
    );
    const a = r.scenes[0]!.actions[0]!;
    expect(a.submit).toBe(true);
    expect(a.focus_selector).toBe("#graph");
  });

  it("leaves submit/focus_selector undefined when omitted (backward compatible)", () => {
    const a = parseRecipe(makeRecipe()).scenes[0]!.actions[0]!;
    expect(a.submit).toBeUndefined();
    expect(a.focus_selector).toBeUndefined();
  });

  it("event log round-trips an action event with focus_bbox", () => {
    const log = parseEventLog({
      version: 0,
      viewport: { width: 1920, height: 1080, dpr: 2 },
      fps: 60,
      events: [
        { t: 1000, type: "type", bbox: [10, 20, 100, 40], focus_bbox: [200, 200, 1000, 700], selector: "#q", textLen: 4 },
      ],
    });
    const ev = log.events[0]!;
    expect(ev.type).toBe("type");
    expect((ev as { focus_bbox?: number[] }).focus_bbox).toEqual([200, 200, 1000, 700]);
  });

  it("rejects a focus_bbox with non-positive width/height", () => {
    expect(() =>
      parseEventLog({
        version: 0,
        viewport: { width: 1920, height: 1080, dpr: 2 },
        fps: 60,
        events: [
          { t: 1000, type: "click", bbox: [10, 20, 100, 40], focus_bbox: [0, 0, 0, 100], selector: "#q", point: [60, 40] },
        ],
      }),
    ).toThrow();
  });
});
