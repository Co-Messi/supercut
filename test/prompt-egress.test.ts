import { describe, expect, it } from "vitest";
import { analyzeApp, type AppAnalysis } from "../src/director/analyze.js";
import { dropLeakySelectors, type PageDigest } from "../src/director/inventory.js";
import type { ChatOptions, LlmClient } from "../src/director/llm.js";
import { writeRecipe } from "../src/director/script.js";

/**
 * Element text is redacted before it reaches a provider, but a selector built
 * from that text (`a:has-text("jane@customer.com")`) used to travel raw. A
 * selector that would carry a secret or an identifier is not inventoried.
 */

const EMAIL = "jane@customer.com";
const TOKEN = "sk-live-abcdefghijklmnopqrstuvwx";

const digest: PageDigest = {
  url: "http://127.0.0.1:9999/",
  title: "Customers",
  headings: ["Customers"],
  inventory: [
    { selector: "#search", tag: "input", text: "Search customers", bbox: { x: 0, y: 0, w: 200, h: 30 } },
    { selector: `a:has-text("${EMAIL}")`, tag: "a", text: EMAIL, href: `mailto:${EMAIL}`, bbox: { x: 0, y: 40, w: 200, h: 30 } },
    { selector: `[aria-label="Copy ${TOKEN}"]`, tag: "button", text: "Copy", bbox: { x: 0, y: 80, w: 80, h: 30 } },
    { selector: "#open", tag: "button", text: "Open", bbox: { x: 0, y: 120, w: 80, h: 30 } },
  ],
  // an id holding an email, CSS-escaped the way cssIdent writes it: the
  // backslashes hide it from a plain email pattern
  regions: [{ selector: "#user-jane\\@customer\\.com", tag: "section", text: "profile", bbox: { x: 0, y: 0, w: 900, h: 600 } }],
};

class Capture implements LlmClient {
  readonly label = "capture";
  prompts: ChatOptions[] = [];
  constructor(private responses: string[]) {}
  async chat(opts: ChatOptions): Promise<string> {
    this.prompts.push(opts);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("capture exhausted");
    return next;
  }
}

const promptText = (llm: Capture) =>
  llm.prompts.map((p) => p.system + p.user.map((u) => (u.type === "text" ? u.text : "")).join("")).join("\n");

describe("selector egress", () => {
  it("dropLeakySelectors keeps only selectors that redaction leaves unchanged", () => {
    const safe = dropLeakySelectors(digest);
    expect(safe.inventory.map((i) => i.selector)).toEqual(["#search", "#open"]);
    expect(safe.regions).toEqual([]);
  });

  it("the analyze prompt carries no raw email or token, even from a hand-built digest", async () => {
    const llm = new Capture(["{}", "{}", "{}"]);
    await analyzeApp(llm, [digest]).catch(() => {});
    const text = promptText(llm);
    expect(text).toContain("#open");
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("jane\\@customer");
    expect(text).not.toContain(TOKEN);
  });

  it("the script prompt carries no raw email or token either", async () => {
    const analysis: AppAnalysis = {
      product_summary: "A customer directory with search.",
      music_track: "pulse",
      money_moments: [
        { title: "Search", why: "finds people", page_url: digest.url, elements: ["#search"] },
        { title: "Open", why: "opens a profile", page_url: digest.url, elements: ["#open"] },
      ],
    };
    const llm = new Capture(["{}", "{}", "{}", "{}"]);
    await writeRecipe(llm, analysis, [digest], "http://127.0.0.1:9999").catch(() => {});
    const text = promptText(llm);
    expect(text).toContain("#search");
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("jane\\@customer");
    expect(text).not.toContain(TOKEN);
  });
});
