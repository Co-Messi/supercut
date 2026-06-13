/**
 * Stage 1: ANALYZE — what is this product, and what are its money moments?
 *
 * LLM-assisted but schema-bounded: the model sees page digests (headings,
 * element inventory, screenshots) and must return a validated AppAnalysis.
 * Invalid output bounces back with the validation error (max 3 attempts).
 */
import { z } from "zod";
import { extractJson, type ChatPart, type LlmClient } from "./llm.js";
import type { PageDigest } from "./inventory.js";
import { redactForPrompt } from "../security/redaction.js";

export const appAnalysis = z.object({
  product_summary: z.string().min(10).max(600),
  money_moments: z
    .array(
      z.object({
        title: z.string().min(3).max(80),
        why: z.string().min(5).max(300),
        page_url: z.string(),
        /** selectors (from the inventory) involved in showing this moment */
        elements: z.array(z.string()).min(1).max(6),
      }),
    )
    .min(2)
    .max(4),
});

export type AppAnalysis = z.infer<typeof appAnalysis>;

export function validateAnalysis(raw: unknown, digests: PageDigest[]): AppAnalysis {
  const parsed = appAnalysis.parse(raw);
  const byPage = new Map(digests.map((d) => [d.url, new Set(d.inventory.map((i) => i.selector))]));
  for (const moment of parsed.money_moments) {
    const selectors = byPage.get(moment.page_url);
    if (!selectors) {
      throw new Error(`money moment "${moment.title}" page_url "${moment.page_url}" is not a crawled page`);
    }
    for (const selector of moment.elements) {
      if (!selectors.has(selector)) {
        throw new Error(`money moment "${moment.title}" selector "${selector}" is not in the inventory for ${moment.page_url}`);
      }
    }
  }
  return parsed;
}

function digestText(d: PageDigest): string {
  const inv = d.inventory
    .map((i) => `  ${i.selector}  [${i.tag}] "${redactForPrompt(i.text)}"${i.href ? ` → ${redactForPrompt(i.href)}` : ""}${i.hidden ? "  (HIDDEN until revealed)" : ""}`)
    .join("\n");
  return `PAGE ${d.url}\ntitle: ${d.title}\nheadings: ${d.headings.join(" | ")}\nelements:\n${inv}`;
}

const SYSTEM = `You are the director of a 60-second Screen-Studio-style product launch video, not a random website tour. You study a web product and pick the 2-4 "money moments" — the interactions that make a viewer instantly understand why this product is good.

Order money_moments as the exact video storyboard:
1. hook: the clearest landing/first-impression value moment
2. proof/depth: the core workflow or differentiator
3. payoff: the most visual result, completion, dashboard, or CTA

Prefer moments with visible payoff (something appears, changes, or completes). Do not order by crawl order unless that is also the best viewer story. Respond ONLY with a JSON object matching:
{ "product_summary": string, "money_moments": [{ "title": string, "why": string, "page_url": string (one of the crawled page URLs), "elements": [selector strings COPIED EXACTLY from the element inventory] }] }`;

export async function analyzeApp(
  llm: LlmClient,
  digests: PageDigest[],
  repoNotes?: string,
): Promise<AppAnalysis> {
  const parts: ChatPart[] = [];
  parts.push({
    type: "text",
    text:
      (repoNotes ? `REPO NOTES:\n${repoNotes.slice(0, 4000)}\n\n` : "") +
      digests.map(digestText).join("\n\n"),
  });
  for (const d of digests) {
    if (d.screenshotB64) {
      parts.push({ type: "text", text: `screenshot of ${d.url}:` });
      parts.push({ type: "image", dataUrl: `data:image/jpeg;base64,${d.screenshotB64}` });
    }
  }

  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const user: ChatPart[] = feedback
      ? [...parts, { type: "text", text: `Your previous response was invalid: ${feedback}. Return corrected JSON only.` }]
      : parts;
    // generous budget: a richer source-seeded crawl (many pages) means a bigger
    // prompt AND a bigger response; 4k truncated mid-JSON on real apps
    const raw = await llm.chat({ system: SYSTEM, user, json: true, maxTokens: 8000 });
    try {
      return validateAnalysis(extractJson(raw), digests);
    } catch (err) {
      feedback = err instanceof Error ? err.message.slice(0, 500) : String(err);
    }
  }
  throw new Error(`analyze stage: model failed schema validation 3 times (${feedback})`);
}
