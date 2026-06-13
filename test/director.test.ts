import { describe, expect, it } from "vitest";
import { extractJson, type ChatOptions, type LlmClient } from "../src/director/llm.js";
import { writeRecipe } from "../src/director/script.js";
import { applyVerdicts, deterministicChecks } from "../src/director/qc.js";
import type { AppAnalysis } from "../src/director/analyze.js";
import type { PageDigest } from "../src/director/inventory.js";
import type { RecordResult } from "../src/capture/executor.js";
import type { Recipe } from "../src/schema/index.js";

/** Stub LLM: returns scripted responses in order; records every prompt. */
class StubLlm implements LlmClient {
  readonly label = "stub";
  prompts: ChatOptions[] = [];
  constructor(private responses: string[]) {}
  async chat(opts: ChatOptions): Promise<string> {
    this.prompts.push(opts);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("stub exhausted");
    return next;
  }
}

const digests: PageDigest[] = [
  {
    url: "http://127.0.0.1:9999/",
    title: "Lumon",
    headings: ["Numbers your team actually reads."],
    inventory: [
      { selector: "#cta", tag: "button", text: "Get started free", bbox: { x: 600, y: 340, w: 220, h: 56 } },
      { selector: "#email", tag: "input", text: "you@company.com", bbox: { x: 600, y: 500, w: 360, h: 48 } },
    ],
  },
  {
    url: "http://127.0.0.1:9999/dash",
    title: "Dashboard",
    headings: ["Live Dashboard"],
    inventory: [
      { selector: "#task-ship", tag: "li", text: "Ship weekly digest", bbox: { x: 100, y: 200, w: 800, h: 60 } },
    ],
  },
];

const analysis: AppAnalysis = {
  product_summary: "A metrics dashboard for teams that want simple numbers.",
  money_moments: [
    { title: "Instant signup", why: "shows zero friction", page_url: "http://127.0.0.1:9999/", elements: ["#cta"] },
    { title: "Typed email", why: "form payoff", page_url: "http://127.0.0.1:9999/", elements: ["#email"] },
  ],
};

function validRecipeJson(selector: string): string {
  return JSON.stringify({
    version: 0,
    app_url: "http://127.0.0.1:9999",
    music_track: "institutional-01",
    scenes: [
      {
        name: "signup",
        priority: 1,
        entry: { url: "http://127.0.0.1:9999/", prelude: [] },
        depends_on: [],
        actions: [{ kind: "click", selector, duration_ms: 1500 }],
        hold_ms: 400,
      },
      {
        name: "email-payoff",
        priority: 2,
        entry: { url: "http://127.0.0.1:9999/", prelude: [] },
        depends_on: [],
        actions: [{ kind: "type", selector: "#email", text: "founder@example.com", duration_ms: 1500 }],
        hold_ms: 600,
      },
    ],
  });
}

describe("extractJson", () => {
  it("handles fenced and prose-wrapped JSON", () => {
    expect(extractJson('Sure! ```json\n{"a":1}\n``` hope that helps')).toEqual({ a: 1 });
    expect(extractJson('{"nested":{"b":"with } brace in string"}}')).toEqual({
      nested: { b: "with } brace in string" },
    });
  });
});

describe("script stage — the anti-hallucination gates", () => {
  it("accepts a recipe built from inventory selectors", async () => {
    const llm = new StubLlm([validRecipeJson("#cta")]);
    const { recipe, attempts } = await writeRecipe(llm, analysis, digests, "http://127.0.0.1:9999");
    expect(attempts).toBe(1);
    expect(recipe.scenes[0]!.actions[0]!.selector).toBe("#cta");
  });

  it("bounces a hallucinated selector back and accepts the correction", async () => {
    const llm = new StubLlm([
      validRecipeJson("#signup-button-fake"), // hallucinated — not in inventory
      validRecipeJson("#cta"),                // corrected on retry
    ]);
    const { recipe, attempts } = await writeRecipe(llm, analysis, digests, "http://127.0.0.1:9999");
    expect(attempts).toBe(2);
    expect(recipe.scenes[0]!.actions[0]!.selector).toBe("#cta");
    // retry prompt carried the exact rejection reason
    const retryText = llm.prompts[1]!.user.map((p) => (p.type === "text" ? p.text : "")).join(" ");
    expect(retryText).toContain("#signup-button-fake");
    expect(retryText).toContain("not on its entry page");
  });

  it("rejects entry URLs that were never crawled", async () => {
    const evil = JSON.parse(validRecipeJson("#cta")) as { scenes: { entry: { url: string } }[] };
    evil.scenes[0]!.entry.url = "http://evil.example.com/";
    const llm = new StubLlm([JSON.stringify(evil), validRecipeJson("#cta")]);
    const { attempts } = await writeRecipe(llm, analysis, digests, "http://127.0.0.1:9999");
    expect(attempts).toBe(2);
  });

  it("rejects recipes that skip storyboard beats", async () => {
    const oneScene = JSON.parse(validRecipeJson("#cta")) as { scenes: unknown[] };
    oneScene.scenes = oneScene.scenes.slice(0, 1);
    const llm = new StubLlm([JSON.stringify(oneScene), validRecipeJson("#cta")]);
    const { attempts } = await writeRecipe(llm, analysis, digests, "http://127.0.0.1:9999");
    expect(attempts).toBe(2);
    const retryText = llm.prompts[1]!.user.map((p) => (p.type === "text" ? p.text : "")).join(" ");
    expect(retryText).toContain("one per money moment");
  });

  it("rejects scenes that ignore the ordered money moment selector", async () => {
    const wrongBeat = JSON.parse(validRecipeJson("#cta")) as {
      scenes: { actions: { selector: string; kind: string; text?: string }[] }[];
    };
    wrongBeat.scenes[1]!.actions[0] = { kind: "click", selector: "#cta", duration_ms: 1500 };
    const llm = new StubLlm([JSON.stringify(wrongBeat), validRecipeJson("#cta")]);
    const { attempts } = await writeRecipe(llm, analysis, digests, "http://127.0.0.1:9999");
    expect(attempts).toBe(2);
    const retryText = llm.prompts[1]!.user.map((p) => (p.type === "text" ? p.text : "")).join(" ");
    expect(retryText).toContain("does not film storyboard beat");
  });

  it("rejects mid-scene goto actions that make the footage a random tour", async () => {
    const withGoto = JSON.parse(validRecipeJson("#cta")) as {
      scenes: { actions: { kind: string; url?: string; duration_ms: number; selector?: string; text?: string }[] }[];
    };
    withGoto.scenes[0]!.actions.unshift({ kind: "goto", url: "http://127.0.0.1:9999/dash", duration_ms: 1200 });
    const llm = new StubLlm([JSON.stringify(withGoto), validRecipeJson("#cta")]);
    const { attempts } = await writeRecipe(llm, analysis, digests, "http://127.0.0.1:9999");
    expect(attempts).toBe(2);
    const retryText = llm.prompts[1]!.user.map((p) => (p.type === "text" ? p.text : "")).join(" ");
    expect(retryText).toContain("mid-scene goto");
  });

  it("gives up loudly after 4 failed attempts", async () => {
    const bad = validRecipeJson("#nope");
    const llm = new StubLlm([bad, bad, bad, bad]);
    await expect(writeRecipe(llm, analysis, digests, "http://127.0.0.1:9999")).rejects.toThrow(
      /failed recipe validation 4 times/,
    );
  });

  it("rejects a selector that exists on another page but not the scene's entry page", async () => {
    // #task-ship is real — but only on /dash. Using it in a scene whose
    // entry.url is "/" must fail per-page validation (PR #2 review).
    const crossPage = JSON.parse(validRecipeJson("#cta")) as {
      scenes: { entry: { url: string }; actions: { selector: string }[] }[];
    };
    crossPage.scenes[0]!.actions[0]!.selector = "#task-ship"; // wrong page for entry "/"
    const llm = new StubLlm([JSON.stringify(crossPage), validRecipeJson("#cta")]);
    const { attempts } = await writeRecipe(llm, analysis, digests, "http://127.0.0.1:9999");
    expect(attempts).toBe(2);
    const retryText = llm.prompts[1]!.user.map((p) => (p.type === "text" ? p.text : "")).join(" ");
    expect(retryText).toContain("not on its entry page");
  });
});

describe("QC verdicts — frozen patch surface", () => {
  const recipe = JSON.parse(validRecipeJson("#cta")) as Recipe;
  const twoSceneRecipe: Recipe = {
    ...recipe,
    scenes: [
      recipe.scenes[0]!,
      { ...recipe.scenes[0]!, name: "child", priority: 2, depends_on: ["signup"] },
    ],
  };

  it("deterministic checks cut failed scenes", () => {
    const result = {
      eventLog: { version: 0, viewport: { width: 1920, height: 1080, dpr: 2 }, fps: 60, events: [] },
      frameCount: 10,
      failedScenes: ["signup"],
      aborted: false,
      outDir: "x",
    } as unknown as RecordResult;
    const verdicts = deterministicChecks(result);
    expect(verdicts).toEqual([
      expect.objectContaining({ scene: "signup", verdict: "cut" }),
    ]);
  });

  it("cutting a parent cascades to dependents", () => {
    expect(() =>
      applyVerdicts(twoSceneRecipe, [{ scene: "signup", verdict: "cut", reason: "broken" }]),
    ).toThrow(/cut every scene/); // both die → empty video refused
  });

  it("applies hold_ms patches without touching actions or order", () => {
    const { recipe: patched, changed } = applyVerdicts(recipe, [
      { scene: "signup", verdict: "patch", reason: "needs air", patch: { hold_ms: 900 } },
    ]);
    expect(changed).toBe(true);
    expect(patched.scenes[0]!.hold_ms).toBe(900);
    expect(patched.scenes[0]!.actions).toEqual(recipe.scenes[0]!.actions);
  });

  it("ok verdicts change nothing", () => {
    const { changed } = applyVerdicts(recipe, [
      { scene: "signup", verdict: "ok", reason: "fine" },
    ]);
    expect(changed).toBe(false);
  });
});
