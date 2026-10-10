/**
 * The record ⇄ QC loop of `generate`. Every take performs every action of the
 * recipe against the live app again (clicks, typing, submits), so the loop is
 * bounded, and the bound is what the human agrees to before the first take:
 * at most 1 + MAX_RETAKES performances per consent.
 *
 * Only a cut re-records: the cut scene is in the footage, so the recipe is
 * filmed again without it. Hold and zoom patches change how the footage is
 * cut, not what the app is asked to do, so they become render-time
 * adjustments of the take as recorded.
 */
import type { RecordResult } from "../capture/executor.js";
import type { Recipe } from "../schema/index.js";
import { NO_ADJUSTMENTS, type TakeAdjustments } from "../render/adjust.js";
import { AllScenesCutError, decideQc, type SceneVerdict } from "./qc.js";

/** re-takes after the first take: one, to drop scenes that failed or that QC
 *  cut, so each action runs at most twice per consent */
export const MAX_RETAKES = 1;

/** the confirmation question, stating how many times each action may run */
export function captureConsentPrompt(maxPerformances: number): string {
  const repeats =
    maxPerformances > 1
      ? ` Each action runs once per take; if QC has to drop a scene it films the recipe again, so each action can run up to ${maxPerformances} times.`
      : " Each action runs once.";
  return `Film this recipe against the live app now?${repeats} [y/N] `;
}

export interface FilmOptions {
  recipe: Recipe;
  maxRetakes: number;
  /** perform the recipe once (take `index`), and return the take */
  recordTake: (recipe: Recipe, index: number) => Promise<{ result: RecordResult; takeDir: string }>;
  /** judge a take */
  qc: (result: RecordResult, takeDir: string) => Promise<SceneVerdict[]>;
  log: (msg: string) => void;
  /** receives each round's verdicts as they arrive, so a failure later in
   *  the run still leaves them for the report */
  verdictLog?: SceneVerdict[][];
}

export interface FilmResult {
  result: RecordResult;
  takeDir: string;
  /** the recipe of the take that will be rendered */
  recipe: Recipe;
  retakes: number;
  verdictLog: SceneVerdict[][];
  /** QC holds and zooms to apply to that take at render time */
  adjustments: TakeAdjustments;
}

/** QC cut every scene of a recorded take; the take is still on disk */
export class AllScenesCutAfterTakeError extends AllScenesCutError {
  constructor(cut: string[], readonly takeDir: string) {
    super(cut);
    this.name = "AllScenesCutAfterTakeError";
  }
}

export async function filmWithRetakes(opts: FilmOptions): Promise<FilmResult> {
  const verdictLog = opts.verdictLog ?? [];
  let recipe = opts.recipe;
  let retakes = 0;
  for (;;) {
    const { result, takeDir } = await opts.recordTake(recipe, retakes);
    const verdicts = await opts.qc(result, takeDir);
    verdictLog.push(verdicts);
    const done = (adjustments: TakeAdjustments): FilmResult => ({ result, takeDir, recipe, retakes, verdictLog, adjustments });
    const notOk = verdicts.filter((v) => v.verdict !== "ok");
    if (notOk.length === 0) {
      opts.log("   QC clean");
      return done(NO_ADJUSTMENTS);
    }
    for (const v of notOk) opts.log(`   ${v.verdict.toUpperCase()} ${JSON.stringify(v.scene)}: ${JSON.stringify(v.reason)}`);
    let decision: ReturnType<typeof decideQc>;
    try {
      decision = decideQc(recipe, verdicts);
    } catch (err) {
      if (err instanceof AllScenesCutError) throw new AllScenesCutAfterTakeError(err.cut, takeDir);
      throw err;
    }
    for (const note of decision.notes) opts.log(`   note: ${note}`);
    if (!decision.retakeRecipe) return done(decision.adjustments);
    if (retakes >= opts.maxRetakes) {
      // the recorded take keeps the scenes QC wanted cut; the recipe and
      // report keep describing what was filmed
      opts.log(`   re-take budget exhausted (${opts.maxRetakes}): rendering the take as recorded`);
      return done(decision.adjustments);
    }
    recipe = decision.retakeRecipe;
    retakes++;
    opts.log(`   re-take ${retakes}/${opts.maxRetakes} without ${decision.cut.map((c) => JSON.stringify(c)).join(", ")}`);
  }
}
