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

/** mulberry32 — tiny deterministic PRNG, good enough for path jitter. */
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
  const a = 120, b = 110; // tuned for "confident demo presenter" feel
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
