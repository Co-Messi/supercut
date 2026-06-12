/**
 * Stage 0-5 orchestrator — `supercut generate`.
 *
 *   preflight ─▶ ① analyze ─▶ ② script ─▶ ③ record ─▶ ④ QC ─▶ ⑤ render
 *                  (LLM)        (LLM)      (pure)      │ patch/cut?
 *                                  ▲                   │ (≤3 re-takes,
 *                                  └──── scheduler ◀───┘  whole-run)
 *
 * Fail-fast preflight order is deliberate: cheap checks (URL, ffmpeg) run
 * before any LLM spend; LLM stages run before any capture; nothing expensive
 * starts on a config that was doomed from the beginning.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { record, type RecordResult } from "../capture/index.js";
import { renderTake } from "../render/index.js";
import type { Recipe } from "../schema/index.js";
import { analyzeApp, type AppAnalysis } from "./analyze.js";
import { crawlApp, type PageDigest } from "./inventory.js";
import type { LlmClient } from "./llm.js";
import { applyVerdicts, deterministicChecks, visionQc, type SceneVerdict } from "./qc.js";
import { writeRecipe } from "./script.js";

const exec = promisify(execFile);
const MAX_RETAKES = 3;

export interface GenerateOptions {
  llm: LlmClient;
  url: string;
  outDir: string;
  repoPath?: string;
  background?: string;
  seed?: number;
  /** skip vision QC (deterministic checks still run) */
  noVision?: boolean;
  log?: (msg: string) => void;
}

export interface GenerateResult {
  outFile: string;
  recipe: Recipe;
  analysis: AppAnalysis;
  retakes: number;
  verdictLog: SceneVerdict[][];
}

async function preflight(url: string): Promise<void> {
  // app reachable — error in seconds, never after 10 minutes of work
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status >= 500) throw new Error(`app at ${url} responded ${res.status}`);
  } catch (err) {
    throw new Error(
      `preflight: cannot reach ${url} — is the app running? (${err instanceof Error ? err.message : err})`,
    );
  } finally {
    clearTimeout(timer);
  }
  try {
    await exec("ffmpeg", ["-version"]);
  } catch {
    throw new Error("preflight: ffmpeg not found on PATH — run `supercut doctor`");
  }
}

function repoNotes(repoPath: string): string | undefined {
  for (const f of ["README.md", "readme.md", "package.json"]) {
    const p = join(repoPath, f);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf8").slice(0, 4000);
      } catch {
        /* unreadable — next */
      }
    }
  }
  return undefined;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const log = opts.log ?? ((m: string) => console.log(`[generate] ${m}`));
  mkdirSync(opts.outDir, { recursive: true });

  log("preflight…");
  await preflight(opts.url);

  log("① analyze: crawling app…");
  const digests: PageDigest[] = await crawlApp(opts.url, { maxPages: 3 });
  log(`   crawled ${digests.length} page(s), ${digests.reduce((n, d) => n + d.inventory.length, 0)} interactable elements`);

  const notes = opts.repoPath ? repoNotes(opts.repoPath) : undefined;
  const analysis = await analyzeApp(opts.llm, digests, notes);
  log(`   product: ${analysis.product_summary.slice(0, 100)}`);
  for (const m of analysis.money_moments) log(`   moment: ${m.title}`);

  log("② script: writing recipe…");
  const { recipe: firstRecipe, attempts } = await writeRecipe(opts.llm, analysis, digests, opts.url);
  log(`   recipe valid after ${attempts} attempt(s): ${firstRecipe.scenes.length} scenes`);

  let recipe = firstRecipe;
  let retakes = 0;
  const verdictLog: SceneVerdict[][] = [];
  let result: RecordResult;
  let takeDir: string;

  for (;;) {
    takeDir = join(opts.outDir, `take-${retakes}`);
    rmSync(takeDir, { recursive: true, force: true });
    log(`③ record: take ${retakes} (${recipe.scenes.length} scenes)…`);
    result = await record({ recipe, outDir: takeDir, seed: opts.seed ?? 1 });
    if (result.aborted) {
      throw new Error(
        `capture aborted: scenes failed [${result.failedScenes.join(", ")}] — app state may not match the recipe`,
      );
    }

    log("④ qc: deterministic checks…");
    const verdicts = deterministicChecks(result);
    if (!opts.noVision) {
      log("④ qc: vision pass…");
      verdicts.push(...await visionQc(opts.llm, takeDir, result.eventLog));
    }
    verdictLog.push(verdicts);
    const notOk = verdicts.filter((v) => v.verdict !== "ok");
    if (notOk.length === 0) {
      log("   QC clean");
      break;
    }
    for (const v of notOk) log(`   ${v.verdict.toUpperCase()} "${v.scene}": ${v.reason}`);

    const applied = applyVerdicts(recipe, verdicts);
    if (!applied.changed || retakes >= MAX_RETAKES) {
      if (retakes >= MAX_RETAKES) {
        log(`   re-take budget exhausted (${MAX_RETAKES}) — proceeding with the take as recorded`);
      }
      // PR #2 review: do NOT adopt the patched recipe here. `takeDir` was
      // recorded from the CURRENT `recipe`; writing applied.recipe would make
      // recipe.json/report describe scenes/holds that were never filmed (and
      // for cuts, omit a scene that is still in the rendered video). The
      // artifact must match the take. Render keys off events.json + frame
      // index, so the video is whatever was recorded regardless.
      break;
    }
    recipe = applied.recipe;
    retakes++;
    log(`   re-take ${retakes}/${MAX_RETAKES} with patched recipe${applied.cut.length ? ` (cut: ${applied.cut.join(", ")})` : ""}`);
  }

  writeFileSync(join(opts.outDir, "recipe.json"), JSON.stringify(recipe, null, 2));

  log("⑤ render…");
  const outFile = join(opts.outDir, "final.mp4");
  const renderRes = await renderTake({
    takeDir,
    outFile,
    ...(opts.background ? { background: opts.background } : {}),
  });
  log(`done: ${outFile} (${renderRes.frames} frames, ${(renderRes.encodedBytes / 1048576).toFixed(1)}MB)`);

  writeFileSync(
    join(opts.outDir, "director-report.json"),
    JSON.stringify({ analysis, recipe, retakes, verdictLog, llm: opts.llm.label }, null, 2),
  );

  return { outFile, recipe, analysis, retakes, verdictLog };
}
