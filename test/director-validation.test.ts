import { describe, expect, it } from "vitest";
import { coerceSelector, validateAnalysis } from "../src/director/analyze.js";
import type { PageDigest } from "../src/director/inventory.js";

const digests: PageDigest[] = [
  {
    url: "http://127.0.0.1:9999/",
    title: "Home",
    headings: ["Home"],
    inventory: [
      { selector: "#cta", tag: "button", text: "Start", bbox: { x: 1, y: 2, w: 3, h: 4 } },
    ],
  },
];

// a fully-valid analysis; tests override single fields to isolate each gate
function validAnalysis(): Record<string, unknown> {
  return {
    product_summary: "A useful product with dashboard analytics.",
    product_name: "Acme",
    headline: "See your dashboard the moment you arrive",
    tagline: "Analytics, instantly",
    music_track: "daybreak",
    money_moments: [
      { title: "Arrive", caption: "Land on insight", why: "first moment", page_url: "http://127.0.0.1:9999/", elements: ["#cta"] },
      { title: "Start", caption: "Get going", why: "real moment", page_url: "http://127.0.0.1:9999/", elements: ["#cta"] },
    ],
  };
}

describe("analysis validation", () => {
  it("rejects money moments for non-crawled pages", () => {
    const bad = validAnalysis();
    (bad.money_moments as { page_url: string }[])[0]!.page_url = "http://127.0.0.1:9999/admin";
    expect(() => validateAnalysis(bad, digests)).toThrow(/not a crawled page/i);
  });

  it("rejects selectors not inventoried on the referenced page", () => {
    const bad = validAnalysis();
    (bad.money_moments as { elements: string[] }[])[0]!.elements = ["#missing"];
    expect(() => validateAnalysis(bad, digests)).toThrow(/not in the inventory/i);
  });

  it("music_track: accepts every bundled track", () => {
    for (const track of ["pulse", "daybreak", "midnight", "momentum"]) {
      const a = validateAnalysis({ ...validAnalysis(), music_track: track }, digests);
      expect(a.music_track).toBe(track);
    }
  });

  it("music_track: rejects tracks outside the bundled library (analysis must pick a vibe)", () => {
    expect(() => validateAnalysis({ ...validAnalysis(), music_track: "institutional-01" }, digests)).toThrow();
    expect(() => validateAnalysis({ ...validAnalysis(), music_track: "off" }, digests)).toThrow();
    const missing = validAnalysis();
    delete missing.music_track; // required — the director always ships a pick
    expect(() => validateAnalysis(missing, digests)).toThrow();
  });

  it("heals a selector copied with the trailing [tag] annotation instead of rejecting it", () => {
    const valid = new Set(['#cta', ':nth-match([data-testid="service-item"], 1)']);
    // the model grabbed past the closing backtick and appended the display tag
    expect(coerceSelector(':nth-match([data-testid="service-item"], 1) [button]', valid))
      .toBe(':nth-match([data-testid="service-item"], 1)');
    expect(coerceSelector("#cta  [button]", valid)).toBe("#cta");
    expect(coerceSelector("#cta [input]", valid)).toBe("#cta");
    // an actual hallucination has no inventory prefix → returned as-is → fails the gate
    expect(coerceSelector("#totally-invented", valid)).toBe("#totally-invented");
  });

  it("does NOT prefix-heal a real-selector remainder — a hallucinated sibling stays rejected", () => {
    const valid = new Set(["#cta"]);
    // #cta-danger / #cta2 start with the valid #cta but the tail is selector
    // continuation, not display annotation → returned as-is → the gate rejects them
    expect(coerceSelector("#cta-danger", valid)).toBe("#cta-danger");
    expect(coerceSelector("#cta2", valid)).toBe("#cta2");
    expect(coerceSelector("#cta_alt", valid)).toBe("#cta_alt");
    // but the annotation tail on the same base still heals
    expect(coerceSelector("#cta [button]", valid)).toBe("#cta");
  });

  it("validateAnalysis accepts elements that carry the appended annotation (self-heals)", () => {
    const a = validAnalysis();
    (a.money_moments as { elements: string[] }[])[0]!.elements = ['#cta [button] "Start"'];
    const parsed = validateAnalysis(a, digests);
    expect(parsed.money_moments[0]!.elements).toEqual(["#cta"]);
  });
});

describe("relative page_url coercion (query-distinct pages)", () => {
  // two crawled URLs sharing a pathname but different search — the crawler keys
  // pages on pathname+search, so these are two distinct digests
  const ambiguous: PageDigest[] = [
    { url: "http://127.0.0.1:9999/results?view=chart", title: "Chart", headings: ["Chart"],
      inventory: [{ selector: "#chart", tag: "div", text: "chart", bbox: { x: 1, y: 2, w: 3, h: 4 } }] },
    { url: "http://127.0.0.1:9999/results?view=table", title: "Table", headings: ["Table"],
      inventory: [{ selector: "#table", tag: "div", text: "table", bbox: { x: 1, y: 2, w: 3, h: 4 } }] },
  ];

  function analysisFor(pageUrl: string): Record<string, unknown> {
    return {
      product_summary: "A results explorer with chart and table views.",
      product_name: "Acme",
      headline: "See your results the way you think",
      tagline: "Results, your way",
      music_track: "daybreak",
      money_moments: [
        { title: "Chart", caption: "See the shape", why: "the hook", page_url: pageUrl, elements: ["#chart"] },
        { title: "Table", caption: "See the rows", why: "the payoff", page_url: pageUrl, elements: ["#table"] },
      ],
    };
  }

  it("throws (never silently rewrites) when a bare relative path is ambiguous across query-distinct pages", () => {
    // "/results" maps to BOTH crawled URLs — coercing would pick one at random
    expect(() => validateAnalysis(analysisFor("/results"), ambiguous)).toThrow(/ambiguous/i);
  });

  it("still coerces a bare relative path when its pathname is unique", () => {
    const unique: PageDigest[] = [
      { url: "http://127.0.0.1:9999/setup", title: "Setup", headings: ["Setup"],
        inventory: [{ selector: "#go", tag: "button", text: "Go", bbox: { x: 1, y: 2, w: 3, h: 4 } }] },
    ];
    const a = {
      product_summary: "A setup flow that gets teams live fast.",
      product_name: "Acme",
      headline: "Be live in two minutes flat",
      tagline: "Setup, done",
      music_track: "daybreak",
      money_moments: [
        { title: "Land", caption: "Ship it now", why: "the hook", page_url: "/setup", elements: ["#go"] },
        { title: "Ship", caption: "Ship it now", why: "the payoff", page_url: "/setup", elements: ["#go"] },
      ],
    };
    const parsed = validateAnalysis(a, unique);
    // the relative "/setup" was rewritten to the full crawled URL
    expect(parsed.money_moments[0]!.page_url).toBe("http://127.0.0.1:9999/setup");
  });
});

describe("coerceSelector never heals into a non-whitelisted selector", () => {
  it("heals a longest-prefix tie to the longest whitelisted selector, never a shorter sibling", () => {
    const valid = new Set(["#cta", "#cta-menu"]);
    // "#cta-menu [button]" prefixes BOTH "#cta" and "#cta-menu"; only the longer,
    // exact match has an annotation-only remainder → heals to the real selector
    expect(coerceSelector("#cta-menu [button]", valid)).toBe("#cta-menu");
    // the shorter sibling with a real-selector remainder is left untouched
    expect(coerceSelector("#cta-menu", new Set(["#cta"]))).toBe("#cta-menu");
  });

  it("never heals a descendant-combinator remainder into its ancestor", () => {
    const valid = new Set(["main"]);
    // these are DIFFERENT elements (a descendant), not "main" + a display
    // annotation — the '='/'>'/class continuation breaks the annotation shape,
    // so they are returned as-is and the whitelist gate rejects them
    expect(coerceSelector("main [role=button]", valid)).toBe("main [role=button]");
    expect(coerceSelector("main > .row", valid)).toBe("main > .row");
    expect(coerceSelector("main .title", valid)).toBe("main .title");
  });

  it("only ever returns a whitelist member or the original raw string", () => {
    const valid = new Set(["#a", ".card", ':nth-match([data-testid="x"], 2)']);
    for (const raw of ["#a-evil", "#a [button]", ".card .child", "#totally-new", ".card  [div]", ':nth-match([data-testid="x"], 2) [li]']) {
      const out = coerceSelector(raw, valid);
      expect(valid.has(out) || out === raw.trim(), `coerce("${raw}") = "${out}"`).toBe(true);
    }
  });
});
