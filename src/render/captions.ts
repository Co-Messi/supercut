/**
 * Narrative caption track — the layer that makes a supercut a STORY, not mute
 * UI footage. Three card kinds, timed against the recorded scene events:
 *   - title: the opening HOOK (the problem/promise) over the first beats
 *   - lower: one benefit line per money-moment, in the padded margin
 *   - close: the product name + tagline at the end
 *
 * The renderer (host-page) draws these on the top layer with fades. Copy comes
 * from the director's analysis (headline / per-beat caption / tagline); timing
 * comes from the actual capture, so words land with the action they describe.
 */

export interface CaptionCard {
  /** ms from take start */
  start: number;
  end: number;
  kind: "title" | "lower" | "close";
  /** title/close: the big line. lower: unused. */
  title?: string;
  /** title/close: the small line (eyebrow on title, tagline on close). */
  subtitle?: string;
  /** lower: the benefit caption. */
  text?: string;
}

const TITLE_MS = 2600; // hook hold at the open
const CLOSE_MS = 2600; // brand hold at the end
const FADE_MS = 420;

export interface BuildCaptionsInput {
  productName: string;
  headline: string;
  tagline: string;
  /** money-moment captions paired with the recorded scene START times (ms) */
  beats: { caption: string; t: number }[];
  /** total take length (ms) */
  totalMs: number;
}

/**
 * Lay the cards out on the timeline with no overlap between the title/close
 * cards and the per-beat lower-thirds. Defensive against short takes.
 */
export function buildCaptions(input: BuildCaptionsInput): CaptionCard[] {
  const { productName, headline, tagline, totalMs } = input;
  const cards: CaptionCard[] = [];

  // MINIMAL by design: supercut is a product-launch tool — the product is the
  // star, text only bookends it. A hook card opens (states the problem so the
  // video is never ambiguous), the product performs in the middle (carried by
  // motion, no captions over it), and a close card brands the end. Per-beat
  // lower-thirds are intentionally omitted to keep the app on screen.
  const titleEnd = Math.min(TITLE_MS, Math.max(0, totalMs - CLOSE_MS - 200));
  if (headline && titleEnd > FADE_MS) {
    cards.push({ start: 0, end: titleEnd, kind: "title", title: headline, subtitle: productName });
  }

  const closeStart = Math.max(titleEnd, totalMs - CLOSE_MS);
  if (productName && totalMs - closeStart > FADE_MS) {
    cards.push({ start: closeStart, end: totalMs, kind: "close", title: productName, subtitle: tagline });
  }

  return cards;
}

/** Per-card opacity at time t (ms): linear fade in/out at the edges. */
export function captionAlpha(card: CaptionCard, t: number): number {
  if (t <= card.start || t >= card.end) return 0;
  const inA = Math.min(1, (t - card.start) / FADE_MS);
  const outA = Math.min(1, (card.end - t) / FADE_MS);
  return Math.max(0, Math.min(inA, outA));
}
