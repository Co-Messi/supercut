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

/** the bundled soundtrack library (assets/music/) — the director picks one as
 *  part of understanding the product, so every generate run ships with music */
export const MUSIC_TRACKS = ["pulse", "daybreak", "midnight", "momentum"] as const;

export const appAnalysis = z.object({
  product_summary: z.string().min(10).max(600),
  /** the brand/product name for the title + close cards (e.g. "Acme") */
  product_name: z.string().min(2).max(40),
  /** bundled track matching the app's look/energy — enum here so a made-up
   *  track name bounces back at validation, never reaching the render */
  music_track: z.enum(MUSIC_TRACKS),
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

/**
 * Heal a selector the model copied with trailing junk. Inventory lines read
 * `` `<selector>` [tag] "text" ``; a model that grabs past the closing backtick
 * appends the ` [tag]…` annotation (e.g. `:nth-match(…, 1) [button]`). Selectors
 * themselves contain `]`/`)`/quotes, so we can't regex-strip safely — instead we
 * accept the LONGEST real inventory selector that `raw` starts with AND whose
 * remainder is only the display annotation. A bare `startsWith` heals too much:
 * `#cta-danger` starts with `#cta`, so prefix-healing would silently rewrite a
 * hallucinated sibling into a real selector and bypass the whitelist gate. We
 * only heal when what follows the matched selector is whitespace-then-`[tag]`
 * (the annotation shape) or nothing — never a selector-continuation character.
 */
const ANNOTATION_TAIL_RE = /^\s+\[[a-z0-9-]+\]/i;

export function coerceSelector(raw: string, valid: Set<string>): string {
  const s = raw.trim();
  if (valid.has(s)) return s;
  let best = "";
  for (const v of valid) {
    if (!s.startsWith(v) || v.length <= best.length) continue;
    const rest = s.slice(v.length);
    // `#cta-danger` / `#cta2` have a real-selector remainder → leave untouched so
    // the gate rejects them; only annotation junk or pure whitespace heals
    if (rest.trim() === "" || ANNOTATION_TAIL_RE.test(rest)) best = v;
  }
  return best || s;
}

export function validateAnalysis(raw: unknown, digests: PageDigest[]): AppAnalysis {
  const parsed = appAnalysis.parse(raw);
  const byPage = new Map(digests.map((d) => [d.url, new Set(d.inventory.map((i) => i.selector))]));
  // Models often answer with a relative path ("/setup") instead of the full
  // crawled URL. Coerce by pathname match so a correct beat isn't rejected on a
  // formatting nit — downstream (script.ts) needs the full crawled URL. The
  // crawler keys pages on pathname+search, so ONE pathname can map to several
  // distinct crawled URLs (/results?view=chart vs ?view=table). Track all
  // candidates per pathname: a lone candidate coerces; MULTIPLE means a bare
  // path is ambiguous and must NOT be silently rewritten onto the wrong page.
  const byPathname = new Map<string, string[]>();
  for (const d of digests) {
    try {
      const key = new URL(d.url).pathname.replace(/\/$/, "") || "/";
      const list = byPathname.get(key) ?? [];
      if (!list.includes(d.url)) list.push(d.url);
      byPathname.set(key, list);
    } catch { /* skip */ }
  }
  for (const moment of parsed.money_moments) {
    if (!byPage.has(moment.page_url)) {
      let key = moment.page_url;
      try { key = new URL(moment.page_url, digests[0]?.url ?? "http://localhost").pathname; } catch { /* keep */ }
      const candidates = byPathname.get((key.replace(/\/$/, "") || "/"));
      if (candidates && candidates.length > 1) {
        throw new Error(
          `money moment "${moment.title}" page_url "${moment.page_url}" is ambiguous — ` +
            `${candidates.length} crawled pages share that pathname (${candidates.join(", ")}); ` +
            `use the full URL INCLUDING its query string to pick one`,
        );
      }
      if (candidates && candidates.length === 1) moment.page_url = candidates[0]!;
    }
    const selectors = byPage.get(moment.page_url);
    if (!selectors) {
      throw new Error(`money moment "${moment.title}" page_url "${moment.page_url}" is not a crawled page`);
    }
    // heal an appended ` [tag]` annotation in-place before the whitelist check
    moment.elements = moment.elements.map((sel) => coerceSelector(sel, selectors));
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
    .map((i) => `  \`${i.selector}\`  [${i.tag}] "${redactForPrompt(i.text)}"${i.href ? ` → ${redactForPrompt(i.href)}` : ""}${i.hidden ? "  (HIDDEN until revealed)" : ""}`)
    .join("\n");
  // look signal: lets a text-only model ground vibe/music choices in the
  // page's actual appearance, not just its copy
  const look = d.theme ? `\ntheme: ${d.theme}${d.accentColor ? ` (accent ${d.accentColor})` : ""}` : "";
  // URL/title/headings are egress too — a query-string token (?session=<jwt>,
  // ?token=<key>) or a secret in the title reaches the provider otherwise. Route
  // them through the same redaction the inventory text/href already gets.
  const url = redactForPrompt(d.url);
  const title = redactForPrompt(d.title);
  const headings = d.headings.map(redactForPrompt).join(" | ");
  return `PAGE ${url}\ntitle: ${title}${look}\nheadings: ${headings}\nelements:\n${inv}`;
}

const SYSTEM = `You are the director AND copywriter of a 60-second product launch video — a polished launch film, not a website tour. You study a web product and turn it into a PERSUASIVE STORY with a crystal-clear message: a viewer must understand within seconds what problem it solves and why it's good. Ambiguity is failure.

Write the story as a problem → solution → payoff arc:
- headline: the HOOK. Open on the customer's PAIN or the promise, in their words — not a feature. ("You run 12 sites. Three bleed cash — which?") This single line must make the whole video unambiguous.
- money_moments (2-4), ordered as the storyboard:
  1. hook beat: the first move that starts solving the problem
  2. proof beat: the core workflow / differentiator
  3. payoff beat: the most visual result — the moment the value lands
- Prefer beats where the UI VISIBLY RESPONDS — a panel switches, results appear, a form confirms. A beat that only points at static content films as dead air.
- For EACH beat write a "caption": ONE short benefit line (≤52 chars) in outcome voice — what the viewer GAINS, never a feature label. "Record a location" is a label (BAD). "Drop in every site in seconds" is a caption (GOOD). "See ranked revenue" is a label (BAD). "Your weakest sites, surfaced instantly" is a caption (GOOD).
- product_name: the brand name for the title/close cards. tagline: the closing line under it.
- music_track: the bundled soundtrack matching the app's LOOK and energy. "pulse" = sleek, minimal tools and dev products; "daybreak" = bright, friendly consumer/marketing SaaS; "midnight" = dark-themed, premium data/infra products; "momentum" = fast, energetic, action-heavy products. Ground the choice in each page's "theme:" line (dark/light + accent), the copy, and the screenshots when provided — a dark dashboard with a bright cheerful track (or the reverse) feels wrong.

Prefer beats with visible payoff (something appears, changes, completes). The "title" field stays a short internal label; the "caption" is the on-screen copy and must be benefit-framed.

Each inventory line is: \`<selector>\` [tag] "text". In "elements", copy ONLY the exact text INSIDE the backticks — never the [tag] or the "text" that follows it. Respond ONLY with a JSON object matching:
{ "product_summary": string, "product_name": string, "headline": string, "tagline": string, "music_track": "pulse"|"daybreak"|"midnight"|"momentum", "money_moments": [{ "title": string, "caption": string, "why": string, "page_url": string (one crawled URL), "elements": [selectors copied from between the backticks] }] }`;

export async function analyzeApp(
  llm: LlmClient,
  digests: PageDigest[],
  repoNotes?: string,
): Promise<AppAnalysis> {
  const textPart: ChatPart = {
    type: "text",
    text:
      (repoNotes ? `REPO NOTES:\n${repoNotes.slice(0, 4000)}\n\n` : "") +
      digests.map(digestText).join("\n\n"),
  };
  const imageParts: ChatPart[] = [];
  for (const d of digests) {
    if (d.screenshotB64) {
      imageParts.push({ type: "text", text: `screenshot of ${redactForPrompt(d.url)}:` });
      imageParts.push({ type: "image", dataUrl: `data:image/jpeg;base64,${d.screenshotB64}` });
    }
  }

  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    // Screenshots are sent ONCE, on attempt 0. A schema-retry resends the text
    // digest + the corrective feedback but NOT the images — each stateless call
    // that re-uploads every JPEG would multiply the vision-token bill for a
    // formatting fix the text feedback already pinpoints. Tradeoff: the retry
    // reasons from the DOM digest, not the pixels; acceptable because the digest
    // carries the selectors/labels a correction needs.
    const user: ChatPart[] = feedback
      ? [textPart, { type: "text", text: `Your previous response was invalid: ${feedback}. Return corrected JSON only.` }]
      : [textPart, ...imageParts];
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
