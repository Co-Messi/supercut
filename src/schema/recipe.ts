import { z } from "zod";

/**
 * Recipe Schema v0 — the filming script.
 *
 * Produced by the script stage (LLM, validated here — invalid output fails
 * loudly and never reaches capture) or written by hand (tape-file users).
 *
 *   recipe ──schedule(recipe, beatGrid)──▶ timed recipe ──▶ capture executor
 *
 * Rules enforced at parse time (design doc "Premises" + stage 2):
 *  - total budget ≤ 60s (MAX_BUDGET_MS)
 *  - every scene declares an entry navigation (URL or action prelude)
 *  - depends_on references must point at existing, EARLIER scenes
 *    (scene order is immutable — reorder is excluded from v1)
 *  - QC may later patch ONLY: zoom bbox, dwell/hold durations, scene cut
 *    (the frozen patch surface — enforced in src/director, not here)
 */

export const MAX_BUDGET_MS = 60_000;

export const action = z.object({
  kind: z.enum(["goto", "click", "type", "scroll", "hover", "wait"]),
  selector: z.string().optional(),
  url: z.string().url().optional(),
  text: z.string().optional(),
  /** Scheduled duration for this action, ms. The scheduler may re-place
   *  actions on the beat grid but never invents durations. */
  duration_ms: z.number().int().positive(),
  /** Where the camera should look during this action (CSS px bbox).
   *  PATCHABLE by QC. */
  zoom: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

export const scene = z.object({
  name: z.string().min(1),
  priority: z.number().int().min(1), // 1 = most important, cut last
  /** Entry navigation: every scene must be independently reachable. */
  entry: z.object({
    url: z.string().url(),
    prelude: z.array(action).default([]),
  }),
  depends_on: z.array(z.string()).default([]),
  actions: z.array(action).min(1),
  /** Extra hold on the scene's last frame, ms. PATCHABLE by QC. */
  hold_ms: z.number().int().nonnegative().default(0),
});

export const recipe = z.object({
  version: z.literal(0),
  app_url: z.string().url(),
  music_track: z.string().min(1),
  scenes: z.array(scene).min(1),
});

export type Recipe = z.infer<typeof recipe>;
export type Scene = z.infer<typeof scene>;
export type Action = z.infer<typeof action>;

export class RecipeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeValidationError";
  }
}

function sceneDuration(s: Scene): number {
  const prelude = s.entry.prelude.reduce((sum, a) => sum + a.duration_ms, 0);
  const actions = s.actions.reduce((sum, a) => sum + a.duration_ms, 0);
  return prelude + actions + s.hold_ms;
}

export function totalBudgetMs(r: Recipe): number {
  return r.scenes.reduce((sum, s) => sum + sceneDuration(s), 0);
}

/**
 * Parse + enforce cross-field rules. This is the loud-failure gate between
 * the LLM script stage and the deterministic capture stage.
 */
export function parseRecipe(raw: unknown): Recipe {
  const r = recipe.parse(raw);

  const budget = totalBudgetMs(r);
  if (budget > MAX_BUDGET_MS) {
    throw new RecipeValidationError(
      `recipe budgets ${budget}ms > hard ceiling ${MAX_BUDGET_MS}ms — cut scenes or shorten actions`,
    );
  }

  const names = new Set<string>();
  for (const s of r.scenes) {
    if (names.has(s.name)) {
      throw new RecipeValidationError(`duplicate scene name "${s.name}"`);
    }
    for (const dep of s.depends_on) {
      if (!names.has(dep)) {
        throw new RecipeValidationError(
          `scene "${s.name}" depends_on "${dep}" which is not an earlier scene ` +
            `(missing, later, or self — scene order is immutable in v1)`,
        );
      }
    }
    names.add(s.name);
  }

  return r;
}
