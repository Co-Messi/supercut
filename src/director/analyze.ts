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

function digestText(d: PageDigest): string {
  const inv = d.inventory
    .map((i) => `  ${i.selector}  [${i.tag}] "${i.text}"${i.href ? ` → ${i.href}` : ""}${i.hidden ? "  (HIDDEN until revealed)" : ""}`)
    .join("\n");
  return `PAGE ${d.url}\ntitle: ${d.title}\nheadings: ${d.headings.join(" | ")}\nelements:\n${inv}`;
}

const SYSTEM = `You are the director of a 60-second product launch video. You study a web product and pick the 2-4 "money moments" — the interactions that make a viewer instantly understand why this product is good. Prefer moments with visible payoff (something appears, changes, or completes). Respond ONLY with a JSON object matching:
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
    const raw = await llm.chat({ system: SYSTEM, user, json: true });
    try {
      return appAnalysis.parse(extractJson(raw));
    } catch (err) {
      feedback = err instanceof Error ? err.message.slice(0, 500) : String(err);
    }
  }
  throw new Error(`analyze stage: model failed schema validation 3 times (${feedback})`);
}
