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
          money_moments: [
            { title: "Fake", why: "not crawled", page_url: "http://127.0.0.1:9999/admin", elements: ["#cta"] },
            { title: "Start", why: "real moment", page_url: "http://127.0.0.1:9999/", elements: ["#cta"] },
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
          money_moments: [
            { title: "Fake", why: "fake selector", page_url: "http://127.0.0.1:9999/", elements: ["#missing"] },
            { title: "Start", why: "real moment", page_url: "http://127.0.0.1:9999/", elements: ["#cta"] },
          ],
        },
        digests,
      ),
    ).toThrow(/not in the inventory/i);
  });
});
