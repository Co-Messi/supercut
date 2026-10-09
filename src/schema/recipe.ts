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
 *  - estimated video length ≤ 60s (MAX_BUDGET_MS): the scene budgets PLUS
 *    the take's fixed overhead (estimatedTakeMs)
 *  - every scene declares an entry navigation (URL or action prelude)
 *  - depends_on references must point at existing, EARLIER scenes
 *    (scene order is immutable — reorder is excluded from v1)
 *  - QC may later patch ONLY: zoom bbox, dwell/hold durations, scene cut
 *    (the frozen patch surface — enforced in src/director, not here)
 */

export const MAX_BUDGET_MS = 60_000;
/*
 * Time a take adds around the recipe's own durations. These mirror the
 * capture executor (PRE_ROLL_MS, SETTLE_MS) and the render plan (dwells,
 * TAIL_MS, SETTLE_TAIL_MS). The estimate is a planning figure: the render
 * stage measures the real output length and warns when it passes 60s.
 */
/** the opening page at rest before the first action (executor PRE_ROLL_MS) */
export const TAKE_HEAD_MS = 1_000;
/** a later scene's entry reload. The executor allows up to 12s; localhost
 *  reloads take 0.1 to 0.4s and a remote app 0.3 to 3s */
export const RELOAD_ALLOWANCE_MS = 1_000;
/** after every navigation the executor lets hydration and paints settle */
export const SCENE_SETTLE_MS = 400;
/** each new page opens at rest this long before its first action */
export const SCENE_PRE_ROLL_MS = 1_000;
/** one later scene's entry: reload, settle, then pre-roll on the new page */
export const SCENE_CHANGE_MS = RELOAD_ALLOWANCE_MS + SCENE_SETTLE_MS + SCENE_PRE_ROLL_MS;
/** minimum picture past the end of the capture (plan TAIL_MS) */
export const TAKE_TAIL_MS = 1_000;
/** the render holds a beat's shot this long past its event (plan
 *  ZOOM_DWELL_MS), and a framed payoff (focus_selector or zoom) longer
 *  (plan FOCUS_DWELL_MS) */
const BEAT_DWELL_MS = 1_200;
const PAYOFF_DWELL_MS = 2_400;
/** after a beat's dwell the zoom-out settles before the video ends (plan
 *  SETTLE_TAIL_MS) */
const ZOOM_OUT_SETTLE_MS = 1_700;
/** below this an action can't even complete its cursor travel */
export const MIN_ACTION_MS = 200;

/** recipes drive a real local browser — never allow file:/javascript:/etc. */
const finite = z.number().finite();
const positiveFinite = finite.positive();

const httpUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
    message: "only http:// and https:// URLs are allowed in recipes",
  });

export const action = z
  .object({
    kind: z.enum(["goto", "click", "type", "scroll", "hover", "wait"]),
    selector: z.string().min(1).optional(),
    url: httpUrl.optional(),
    text: z.string().optional(),
    /** type only: press Enter after typing. Many query/search inputs reveal
     *  their payoff (results, a graph, a detail panel) only on submit — without
     *  this the robot types into a box and the product never actually runs. */
    submit: z.boolean().optional(),
    /** Camera target: a result region (from the page's framable regions) that
     *  this action produces. The renderer holds the camera HERE instead of on
     *  the interaction bbox — cursor on the control, frame on the payoff.
     *  Resolved at capture time; ignored if it doesn't resolve. */
    focus_selector: z.string().min(1).optional(),
    /** Scheduled duration for this action, ms. The scheduler may re-place
     *  actions on the beat grid but never invents durations. */
    duration_ms: z.number().int().min(MIN_ACTION_MS),
    /** Where the camera should look during this action (CSS px bbox).
     *  PATCHABLE by QC. */
    zoom: z.tuple([finite.nonnegative(), finite.nonnegative(), positiveFinite, positiveFinite]).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    // per-kind requirements — fail at parse time, never mid-capture
    if ((a.kind === "click" || a.kind === "hover" || a.kind === "type") && !a.selector) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${a.kind} action requires a selector` });
    }
    if (a.kind === "goto" && !a.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "goto action requires a url" });
    }
    if (a.kind === "type" && a.text === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "type action requires text" });
    }
  });

export const scene = z.object({
  name: z.string().min(1),
  priority: z.number().int().min(1), // 1 = most important, cut last
  /** Entry navigation: every scene must be independently reachable. */
  entry: z.object({
    url: httpUrl,
    prelude: z.array(action).default([]),
  }).strict(),
  depends_on: z.array(z.string()).default([]),
  actions: z.array(action).min(1),
  /** Extra hold on the scene's last frame, ms. PATCHABLE by QC. */
  hold_ms: z.number().int().nonnegative().max(MAX_BUDGET_MS).default(0),
}).strict();

export const recipe = z.object({
  version: z.literal(0),
  app_url: httpUrl,
  /** deliberately a free string, NOT an enum: hand-written recipes (record
   *  path) may name custom audio files or anything else for back-compat. The
   *  bundled-track enum is enforced on the DIRECTOR's output in script.ts. */
  music_track: z.string().min(1),
  scenes: z.array(scene).min(1),
}).strict();

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
 * How far the video runs past the end of the capture. A beat's event can land
 * as late as the end of its slot (a typed string is stamped when the last key
 * lands), and the render then holds the shot for the beat's dwell and lets the
 * zoom-out settle. Whatever the final scene films after that slot (later
 * steps, its hold) already covers part of it; TAKE_TAIL_MS is the floor.
 */
export function takeTailMs(r: Recipe): number {
  const last = r.scenes[r.scenes.length - 1];
  if (!last) return TAKE_TAIL_MS;
  let tail = TAKE_TAIL_MS;
  let after = last.hold_ms; // filmed time after the step being looked at
  const steps = [...last.entry.prelude, ...last.actions];
  for (let i = steps.length - 1; i >= 0; i--) {
    const a = steps[i]!;
    if (a.kind === "click" || a.kind === "hover" || a.kind === "type") {
      const dwell = a.focus_selector || a.zoom ? PAYOFF_DWELL_MS : BEAT_DWELL_MS;
      tail = Math.max(tail, dwell + ZOOM_OUT_SETTLE_MS - after);
    }
    after += a.duration_ms;
  }
  return tail;
}

/** the rendered video's expected length: scene budgets plus the take's
 *  overhead (an action that overruns its slot can still add to it) */
export function estimatedTakeMs(r: Recipe): number {
  return totalBudgetMs(r) + TAKE_HEAD_MS + SCENE_CHANGE_MS * Math.max(0, r.scenes.length - 1) + takeTailMs(r);
}

/**
 * Parse + enforce cross-field rules. This is the loud-failure gate between
 * the LLM script stage and the deterministic capture stage.
 */
export function parseRecipe(raw: unknown): Recipe {
  const r = recipe.parse(raw);

  const budget = totalBudgetMs(r);
  const take = estimatedTakeMs(r);
  if (take > MAX_BUDGET_MS) {
    throw new RecipeValidationError(
      `recipe budgets ${budget}ms (~${take}ms of video with the pre-roll, scene changes and ending) > ` +
        `hard ceiling ${MAX_BUDGET_MS}ms — cut scenes or shorten actions`,
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
