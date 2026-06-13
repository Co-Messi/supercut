import { describe, expect, it } from "vitest";
import { validateAnalysis } from "../src/director/analyze.js";
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

describe("analysis validation", () => {
  it("rejects money moments for non-crawled pages", () => {
    expect(() =>
      validateAnalysis(
        {
          product_summary: "A useful product with dashboard analytics.",
          product_name: "Acme",
          headline: "See your dashboard the moment you arrive",
          tagline: "Analytics, instantly",
          money_moments: [
            { title: "Fake", caption: "Off-page", why: "not crawled", page_url: "http://127.0.0.1:9999/admin", elements: ["#cta"] },
            { title: "Start", caption: "Get going", why: "real moment", page_url: "http://127.0.0.1:9999/", elements: ["#cta"] },
          ],
        },
        digests,
      ),
    ).toThrow(/not a crawled page/i);
  });

  it("rejects selectors not inventoried on the referenced page", () => {
    expect(() =>
      validateAnalysis(
        {
          product_summary: "A useful product with dashboard analytics.",
          product_name: "Acme",
          headline: "See your dashboard the moment you arrive",
          tagline: "Analytics, instantly",
          money_moments: [
            { title: "Fake", caption: "Bad selector", why: "fake selector", page_url: "http://127.0.0.1:9999/", elements: ["#missing"] },
            { title: "Start", caption: "Get going", why: "real moment", page_url: "http://127.0.0.1:9999/", elements: ["#cta"] },
          ],
        },
        digests,
      ),
    ).toThrow(/not in the inventory/i);
  });
});
