/**
 * Seeded human-like cursor paths (design premise 3).
 *
 * Same seed + same endpoints → byte-identical path, every run. That is what
 * makes takes reproducible and the scheduled timeline CI-provable.
 *
 *   start ●──╮            control points offset perpendicular to the
 *             ╰──╮        travel line (seeded jitter) → cubic Bezier
 *                 ╰───● target
 *
 * Timing: ease-in-out over a duration derived from Fitts's law
 * (T = a + b·log2(D/W + 1)), clamped to the slot the recipe gives us.
 */

export interface CursorPoint {
  t: number; // ms offset from path start (scheduled)
  x: number;
  y: number;
}

/** mulberry32, tiny deterministic PRNG, good enough for path jitter. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fitts's law movement time in ms, before clamping. */
export function fittsMs(distancePx: number, targetWidthPx: number): number {
  // Slower, deliberate presenter pace rather than twitchy cursor motion.
  const a = 220, b = 170;
  return a + b * Math.log2(distancePx / Math.max(targetWidthPx, 8) + 1);
}

function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
}

export interface PathOptions {
  from: { x: number; y: number };
  to: { x: number; y: number };
  targetWidth: number;
  maxDurationMs: number;
  rng: () => number;
  sampleHz?: number;
}

/**
 * Generate a cubic-Bezier cursor path sampled on a fixed grid.
 * Duration = min(fitts, maxDurationMs), never below 80ms for visible travel.
 */
export function cursorPath(opts: PathOptions): CursorPoint[] {
  const { from, to, targetWidth, maxDurationMs, rng } = opts;
  const sampleHz = opts.sampleHz ?? 60;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return [{ t: 0, x: to.x, y: to.y }];

  const duration = Math.max(80, Math.min(fittsMs(dist, targetWidth), maxDurationMs));

  // perpendicular unit vector for control-point offsets
  const px = -dy / dist;
  const py = dx / dist;
  // arc magnitude: subtle for short hops, more sweep for long travel
  const arc = Math.min(dist * 0.18, 90);
  const o1 = (rng() * 2 - 1) * arc;
  const o2 = (rng() * 2 - 1) * arc * 0.5;

  const c1 = { x: from.x + dx * 0.3 + px * o1, y: from.y + dy * 0.3 + py * o1 };
  const c2 = { x: from.x + dx * 0.7 + px * o2, y: from.y + dy * 0.7 + py * o2 };

  const steps = Math.max(2, Math.round((duration / 1000) * sampleHz));
  const points: CursorPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = easeInOut(i / steps);
    const q = 1 - p;
    points.push({
      t: Math.round((i / steps) * duration),
      x: q * q * q * from.x + 3 * q * q * p * c1.x + 3 * q * p * p * c2.x + p * p * p * to.x,
      y: q * q * q * from.y + 3 * q * q * p * c1.y + 3 * q * p * p * c2.y + p * p * p * to.y,
    });
  }
  return points;
}

const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** user-perceived characters: an accented letter written with a combining
 *  mark, a ZWJ emoji or a flag is one unit, typed as one */
export function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
}

export interface TypingPlan {
  /** pause after the focusing click, before the first key */
  beforeFirstKey: number;
  /** the gaps BETWEEN consecutive keys: keyDelays[i] is waited after
   *  grapheme i, before grapheme i + 1 (length = graphemes − 1) */
  keyDelays: number[];
  /** pause after the last key before pressing Enter (submit) */
  beforeEnter: number;
}

/** keys after these land later: a person finishes a word/token, then moves on */
const WORD_BREAK = /[\s.,@!?;:/\-_]/;
const KEY_FLOOR_MS = 45;
const KEY_MEAN_MAX_MS = 100;
export const KEY_MEAN_MIN_MS = 60;
const WORD_BREAK_FACTOR = 1.8;
/** log-normal spread of inter-key intervals (σ of the underlying normal) */
const KEY_SIGMA = 0.35;

/**
 * Seeded human keystroke timing: log-normal inter-key intervals around a mean
 * of ~100ms (compressed toward 60ms, never below, when the slot is short,
 * a short slot must not collapse into a paste), longer after spaces and
 * punctuation, a 45ms floor, a 250-400ms beat before the first key and
 * ~300ms before Enter. Uniform per-char delays read as a metronome.
 */
export function typingPlan(text: string, availableMs: number, rng: () => number): TypingPlan {
  const chars = graphemes(text);
  const beforeFirstKey = Math.round(250 + rng() * 150);
  const beforeEnter = Math.round(250 + rng() * 100);
  const breaks = chars.filter((c, i) => i > 0 && WORD_BREAK.test(chars[i - 1]!)).length;
  // weight units: a post-break key costs WORD_BREAK_FACTOR ordinary keys
  const units = Math.max(1, chars.length - 1 - breaks + breaks * WORD_BREAK_FACTOR);
  const budget = availableMs - beforeFirstKey - beforeEnter;
  const mean = Math.min(KEY_MEAN_MAX_MS, Math.max(KEY_MEAN_MIN_MS, budget / units));
  const gauss = () => {
    // Box-Muller from the seeded uniform source
    const u = Math.max(rng(), 1e-9);
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const keyDelays = chars.slice(0, -1).map((c) => {
    const base = WORD_BREAK.test(c) ? mean * WORD_BREAK_FACTOR : mean;
    const d = base * Math.exp(KEY_SIGMA * gauss() - (KEY_SIGMA * KEY_SIGMA) / 2);
    return Math.round(Math.min(base * 3, Math.max(KEY_FLOOR_MS, d)));
  });
  return { beforeFirstKey, keyDelays, beforeEnter };
}
