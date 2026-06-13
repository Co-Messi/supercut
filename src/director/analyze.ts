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
  /** the brand/product name for the title + close cards (e.g. "Meridian") */
  product_name: z.string().min(2).max(40),
  /** the launch HOOK — the problem/promise the video opens on, in the
   *  customer's words, not a feature ("Three of your sites bleed cash. Which?").
   *  This is what removes ambiguity about what the video is selling. */
  headline: z.string().min(8).max(80),
  /** the closing line under the product name (e.g. "The operating record") */
  tagline: z.string().min(4).max(60),
  money_moments: z
    .array(
      z.object({
        title: z.string().min(3).max(80),
        why: z.string().min(5).max(300),
        /** ONE benefit line shown over this beat — what the viewer GAINS here,
         *  imperative/outcome voice, NOT a feature label. "Record a location" is
         *  a label; "Drop in every site in seconds" is a caption. */
        caption: z.string().min(4).max(52),
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
  // Models often answer with a relative path ("/setup") instead of the full
  // crawled URL. Coerce by pathname match so a correct beat isn't rejected on a
  // formatting nit — downstream (script.ts) needs the full crawled URL.
  const byPathname = new Map<string, string>();
  for (const d of digests) {
    try { byPathname.set(new URL(d.url).pathname.replace(/\/$/, "") || "/", d.url); } catch { /* skip */ }
  }
  for (const moment of parsed.money_moments) {
    if (!byPage.has(moment.page_url)) {
      let key = moment.page_url;
      try { key = new URL(moment.page_url, digests[0]?.url ?? "http://localhost").pathname; } catch { /* keep */ }
      const full = byPathname.get((key.replace(/\/$/, "") || "/"));
      if (full) moment.page_url = full;
    }
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

const SYSTEM = `You are the director AND copywriter of a 60-second product launch video (Screen-Studio / ChatGPT-launch style), not a website tour. You study a web product and turn it into a PERSUASIVE STORY with a crystal-clear message: a viewer must understand within seconds what problem it solves and why it's good. Ambiguity is failure.

Write the story as a problem → solution → payoff arc:
- headline: the HOOK. Open on the customer's PAIN or the promise, in their words — not a feature. ("You run 12 sites. Three bleed cash — which?") This single line must make the whole video unambiguous.
- money_moments (2-4), ordered as the storyboard:
  1. hook beat: the first move that starts solving the problem
  2. proof beat: the core workflow / differentiator
  3. payoff beat: the most visual result — the moment the value lands
- For EACH beat write a "caption": ONE short benefit line (≤52 chars) in outcome voice — what the viewer GAINS, never a feature label. "Record a location" is a label (BAD). "Drop in every site in seconds" is a caption (GOOD). "See ranked revenue" is a label (BAD). "Your weakest sites, surfaced instantly" is a caption (GOOD).
- product_name: the brand name for the title/close cards. tagline: the closing line under it.

Prefer beats with visible payoff (something appears, changes, completes). The "title" field stays a short internal label; the "caption" is the on-screen copy and must be benefit-framed. Respond ONLY with a JSON object matching:
{ "product_summary": string, "product_name": string, "headline": string, "tagline": string, "money_moments": [{ "title": string, "caption": string, "why": string, "page_url": string (one crawled URL), "elements": [selector strings COPIED EXACTLY from the inventory] }] }`;

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
