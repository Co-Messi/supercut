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
