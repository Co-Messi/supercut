/**
 * Stage 2: SCRIPT — the LLM writes the filming recipe.
 *
 * Two hard gates make hallucination structurally impossible:
 *   1. parseRecipe (schema + budget + depends_on rules)
 *   2. the selector whitelist: every selector in the recipe MUST come from
 *      the crawled inventory, every entry URL from a crawled page.
 * Validation failures bounce back to the model with the exact error
 * (max 4 attempts), so bad output never reaches the capture stage.
 */
import { parseRecipe, type Recipe } from "../schema/index.js";
import { extractJson, type ChatPart, type LlmClient } from "./llm.js";
import type { AppAnalysis } from "./analyze.js";
import type { PageDigest } from "./inventory.js";
import { redactForPrompt } from "../security/redaction.js";

const SYSTEM = `You write filming scripts ("recipes") for supercut, which records a REAL web app with a browser robot and renders a cinematic 60-second launch video. Respond ONLY with a JSON recipe:

{
  "version": 0,
  "app_url": string,
  "music_track": "institutional-01",
  "scenes": [{
    "name": kebab-case string,
    "priority": 1..N (1 = most important, cut last),
    "entry": { "url": one of the crawled page URLs, "prelude": [] },
    "depends_on": [],
    "actions": [{ "kind": "click"|"type"|"hover"|"scroll"|"wait", "selector": string, "text": string (type only), "duration_ms": int }],
    "hold_ms": int
  }]
}

HARD RULES:
- selectors: COPY EXACTLY from the provided element inventory. Never invent or modify one.
- entry.url: only crawled page URLs.
- Create EXACTLY one scene per STORYBOARD beat, in the same order. Do not add a generic site-tour scene.
- Each scene's entry.url must equal that beat's page_url and must include at least one of that beat's money selectors.
- Do not use mid-scene "goto" actions; each scene starts from its entry.url so selector validation and capture stay coherent.
- 2-4 scenes, 2-4 actions each, action duration_ms 1200-4000, hold_ms 600-1400.
- total of all durations + holds ≤ 50000 (one minute video with headroom).
- "type" actions need realistic short text (an email, a search term — match the field).
- Order scenes as a Screen-Studio story: hook → proof/depth → payoff. End on the most visual screen.
- depends_on only when a later scene NEEDS an earlier scene's state.
- (HIDDEN until revealed) elements: only use them AFTER an earlier action in the SAME scene reveals them (e.g. click the button that opens the form, then type into its field).`;

export interface ScriptResult {
  recipe: Recipe;
  attempts: number;
}

export async function writeRecipe(
  llm: LlmClient,
  analysis: AppAnalysis,
  digests: PageDigest[],
  appUrl: string,
): Promise<ScriptResult> {
  // Per-page whitelist: a global set would let a /dash selector
  // pass validation in a / scene, then capture waits forever for an element
  // that page can never show. Validate each scene's selectors against the
  // inventory of ITS entry.url page. (v1 caveat: a mid-scene `goto` to another
  // page is not modeled — selectors validate against entry.url only.)
  const pageUrls = new Set<string>(digests.map((d) => d.url));
  const byPage = new Map<string, Set<string>>();
  for (const d of digests) byPage.set(d.url, new Set(d.inventory.map((i) => i.selector)));
  const storyboard = analysis.money_moments.map((m, index) => ({
    index: index + 1,
    title: m.title,
    pageUrl: m.page_url,
    selectors: new Set(m.elements),
  }));

  const inventoryText = digests
    .map(
      (d) =>
        `PAGE ${d.url}\n` +
        d.inventory.map((i) => `  ${i.selector}  [${i.tag}] "${redactForPrompt(i.text)}"${i.hidden ? "  (HIDDEN until revealed)" : ""}`).join("\n"),
    )
    .join("\n\n");

  const base: ChatPart[] = [
    {
      type: "text",
      text:
        `APP: ${appUrl}\nPRODUCT: ${analysis.product_summary}\n\nMONEY MOMENTS:\n` +
        analysis.money_moments
          .map((m) => `- ${m.title} (${m.page_url}): ${m.why} — elements: ${m.elements.join(", ")}`)
          .join("\n") +
        `\n\nSTORYBOARD (mandatory; output exactly these beats in this order, one scene per beat):\n` +
        analysis.money_moments
          .map((m, i) => `${i + 1}. ${i === 0 ? "HOOK" : i === analysis.money_moments.length - 1 ? "PAYOFF" : "PROOF"} — ${m.title} @ ${m.page_url}; scene must use one of: ${m.elements.join(", ")}`)
          .join("\n") +
        `\n\nELEMENT INVENTORY (the ONLY selectors you may use):\n${inventoryText}`,
    },
  ];

  let feedback = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const user: ChatPart[] = feedback
      ? [...base, { type: "text", text: `Your previous recipe was rejected: ${feedback}\nReturn a corrected JSON recipe only.` }]
      : base;
    const raw = await llm.chat({ system: SYSTEM, user, json: true, maxTokens: 6000 });

    try {
      const recipe = parseRecipe(extractJson(raw));
      if (recipe.scenes.length !== storyboard.length) {
        throw new Error(
          `recipe has ${recipe.scenes.length} scene(s), but storyboard requires exactly ${storyboard.length} scene(s) ` +
            `(one per money moment, in order)`,
        );
      }

      // whitelist gates — the anti-hallucination contract
      for (const [i, scene] of recipe.scenes.entries()) {
        const beat = storyboard[i]!;
        if (scene.entry.url !== beat.pageUrl) {
          throw new Error(
            `scene ${i + 1} "${scene.name}" entry.url "${scene.entry.url}" does not match storyboard beat ` +
              `"${beat.title}" page_url "${beat.pageUrl}"`,
          );
        }
        if (!pageUrls.has(scene.entry.url)) {
          throw new Error(`scene "${scene.name}" entry.url "${scene.entry.url}" is not a crawled page (allowed: ${[...pageUrls].join(", ")})`);
        }
        const pageSelectors = byPage.get(scene.entry.url)!;
        let usesMoneySelector = false;
        for (const a of [...scene.entry.prelude, ...scene.actions]) {
          if (a.kind === "goto") {
            throw new Error(`scene "${scene.name}" uses a mid-scene goto; use a new scene entry.url instead`);
          }
          if (a.selector && !pageSelectors.has(a.selector)) {
            throw new Error(
              `selector "${a.selector}" in scene "${scene.name}" is not on its entry page ${scene.entry.url} — ` +
                `use only selectors listed under that page in the inventory`,
            );
          }
          if (a.selector && beat.selectors.has(a.selector)) usesMoneySelector = true;
        }
        if (!usesMoneySelector) {
          throw new Error(
            `scene ${i + 1} "${scene.name}" does not film storyboard beat "${beat.title}" — ` +
              `include at least one of: ${[...beat.selectors].join(", ")}`,
          );
        }
      }
      return { recipe, attempts: attempt };
    } catch (err) {
      feedback = (err instanceof Error ? err.message : String(err)).slice(0, 600);
    }
  }
  throw new Error(`script stage: model failed recipe validation 4 times (last error: ${feedback})`);
}
