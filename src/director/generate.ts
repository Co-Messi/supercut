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
import { assessCaptureHealth, renderTake, resolveMusicTrack } from "../render/index.js";
import type { Recipe } from "../schema/index.js";
import { analyzeApp, type AppAnalysis } from "./analyze.js";
import { crawlApp, type PageDigest } from "./inventory.js";
import { BudgetedLlmClient, type LlmClient } from "./llm.js";
import { applyVerdicts, deterministicChecks, visionQc, type SceneVerdict } from "./qc.js";
import { writeRecipe } from "./script.js";
import { assertSafeNavigationUrl, urlResolvesPrivate } from "../security/url-policy.js";
import { redactForPrompt } from "../security/redaction.js";
import { extractAppRoutes, routesToSeedAndNotes } from "./sourceRoutes.js";

const exec = promisify(execFile);
const MAX_RETAKES = 3;
/** default hard token budget for a whole run — generous for a normal run
 *  (~15 calls at 8k output max), fatal only to runaway retry loops */
const DEFAULT_MAX_TOKENS = 300_000;
// stage retry ceilings, mirrored from analyze.ts / script.ts / qc.ts — used
// only for the advisory pre-flight call-count estimate
const ANALYZE_ATTEMPTS = 3;
const SCRIPT_ATTEMPTS = 4;
const VISION_QC_ATTEMPTS = 2;

export interface GenerateOptions {
  llm: LlmClient;
  url: string;
  outDir: string;
  /** path to the app's source. When given, supercut reads its routes/page
   *  components to understand the product and SEEDS the crawl with real routes
   *  so the director can drive into functional panels, not just the landing. */
  repoPath?: string;
  /** scope source-reading to one app in a monorepo (path-segment match) */
  appName?: string;
  background?: string;
  /** bundled track name, audio file path, or "off"/absent for a silent video */
  music?: string;
  seed?: number;
  /** model can see images: drives screenshot capture, analyze images, and the
   *  vision-QC pass. Off for text-only models (e.g. deepseek-chat) — the
   *  director then reads the DOM/inventory and QC uses deterministic checks. */
  vision?: boolean;
  /** @deprecated use vision:false */
  noVision?: boolean;
  /** allow localhost/RFC1918 navigation. Defaults to TRUE — filming your own
   *  local dev app is the primary use case. Pass false to engage the SSRF
   *  guard (untrusted/public targets). */
  allowPrivateNetwork?: boolean;
  /** opt-in: let the director see (and therefore script) destructive controls
   *  (Delete, Pay, …). OFF by default — fail-safe so a prompt-injected page
   *  can't steer a real harmful action on the live app. */
  allowDestructive?: boolean;
  /** hard cumulative token ceiling for the run's LLM calls (prompt+completion,
   *  provider-reported). 0 disables. Default: 300000. */
  maxTokens?: number;
  /** preview mode: run analyze + script, print the FULL action list (every
   *  selector, every typed string), write recipe.json — and stop before the
   *  capture browser ever touches the app. The recipe can be reviewed and then
   *  filmed with `supercut record --recipe <dir>/recipe.json`. */
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface GenerateResult {
  /** empty string on a --dry-run (nothing was filmed or rendered) */
  outFile: string;
  recipe: Recipe;
  analysis: AppAnalysis;
  retakes: number;
  verdictLog: SceneVerdict[][];
}

async function preflight(url: string, allowPrivateNetwork: boolean): Promise<void> {
  // app reachable — error in seconds, never after 10 minutes of work.
  // Follow redirects MANUALLY and validate EVERY hop BEFORE the request: a
  // default `fetch` follows 3xx automatically, so a public URL that 302s to
  // http://169.254.169.254/ (cloud metadata) or an RFC1918 host would already
  // have made the internal request before any post-hoc check. SSRF-guard errors
  // propagate as-is (a security failure, not "cannot reach"); only network
  // errors get the friendly reachability message.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    let current = url;
    let status = 0;
    for (let hop = 0; hop < 6; hop++) {
      await assertSafeNavigationUrl(current, { allowPrivateNetwork });
      let res: Response;
      try {
        res = await fetch(current, { signal: ctrl.signal, redirect: "manual" });
      } catch (err) {
        throw new Error(
          `preflight: cannot reach ${current} — is the app running? (${err instanceof Error ? err.message : err})`,
        );
      }
      status = res.status;
      const loc = res.headers.get("location");
      if (status >= 300 && status < 400 && loc) {
        current = new URL(loc, current).href;
        continue;
      }
      break;
    }
    if (status >= 500) throw new Error(`app at ${url} responded ${status}`);
    if (status >= 300 && status < 400) throw new Error(`preflight: ${url} kept redirecting (loop?)`);
  } finally {
    clearTimeout(timer);
  }
  try {
    await exec("ffmpeg", ["-version"]);
  } catch {
    throw new Error("preflight: ffmpeg not found on PATH — run `supercut doctor`");
  }
}

export interface MusicChoice {
  /** value handed to the renderer (undefined → silent cut) */
  spec: string | undefined;
  source: "cli" | "director" | "none";
  /** summary label, e.g. `midnight (director)` or `none` */
  label: string;
  warning?: string;
}

/**
 * Music priority: explicit --music (validated at preflight) > the director's
 * recipe pick > silent. An unresolvable director track degrades to a warning
 * and a silent cut — a music nit must NEVER fail a run after LLM/capture spend.
 */
export function pickMusic(
  cliMusic: string | undefined,
  recipeTrack: string,
  resolve: (spec: string | undefined) => string | null = resolveMusicTrack,
): MusicChoice {
  if (cliMusic !== undefined) {
    // a bad --music is normally caught at preflight, but this exported function
    // must never throw post-spend — mirror the director branch and degrade to a
    // warned silent cut if the resolver throws.
    try {
      return resolve(cliMusic)
        ? { spec: cliMusic, source: "cli", label: `${cliMusic} (cli)` }
        : { spec: undefined, source: "none", label: "none" }; // --music off
    } catch {
      return {
        spec: undefined,
        source: "none",
        label: "none",
        warning: `--music "${cliMusic}" is not a bundled track or audio file — rendering silent`,
      };
    }
  }
  try {
    return resolve(recipeTrack)
      ? { spec: recipeTrack, source: "director", label: `${recipeTrack} (director)` }
      : { spec: undefined, source: "none", label: "none" }; // director chose "off"
  } catch {
    return {
      spec: undefined,
      source: "none",
      label: "none",
      warning: `recipe music_track "${recipeTrack}" is not a bundled track or audio file — rendering silent`,
    };
  }
}

/**
 * Human-readable action list for a recipe — one line per action, including
 * every `type` string and submit flag. Printed before capture on every run
 * (and as the payload of --dry-run) so the operator can see exactly what the
 * director is about to do to the live app; a prompt-injected `type` payload
 * has to survive being shown to a human first.
 */
export function formatRecipePreview(recipe: Recipe): string[] {
  const lines: string[] = [];
  for (const [i, scene] of recipe.scenes.entries()) {
    lines.push(
      `scene ${i + 1} "${scene.name}" @ ${scene.entry.url}` +
        (scene.depends_on.length ? ` (after ${scene.depends_on.join(", ")})` : ""),
    );
    for (const a of [...scene.entry.prelude, ...scene.actions]) {
      let desc = a.kind as string;
      if (a.kind === "goto" && a.url) desc += ` ${a.url}`;
      if (a.selector) desc += ` ${a.selector}`;
      if (a.kind === "type") desc += ` "${a.text ?? ""}"${a.submit ? " then press Enter" : ""}`;
      desc += ` (${a.duration_ms}ms${a.focus_selector ? `, focus ${a.focus_selector}` : ""})`;
      lines.push(`  · ${desc}`);
    }
    if (scene.hold_ms > 0) lines.push(`  · hold ${scene.hold_ms}ms`);
  }
  return lines;
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
  const vision = opts.vision !== undefined ? opts.vision : !(opts.noVision ?? false);
  const budget = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  // every LLM call in the run goes through the budget guard (analyze, script,
  // and vision QC all receive this wrapper) — no stage can spend past the cap
  const llm = new BudgetedLlmClient(opts.llm, budget);
  mkdirSync(opts.outDir, { recursive: true });

  log("preflight…");
  // a bad --music must die here, not after the LLM crawl and capture spend
  resolveMusicTrack(opts.music);
  await preflight(opts.url, opts.allowPrivateNetwork ?? true);
  if ((opts.allowPrivateNetwork ?? true) && !(await urlResolvesPrivate(opts.url))) {
    log("hint: target resolves to a public address — pass --block-private-network when filming untrusted targets");
  }

  // read the app's source FIRST: derive real routes (seed the crawl so
  // functional panels enter the inventory) + a product summary for the director
  let seedUrls: string[] = [];
  let sourceNotes: string | undefined;
  if (opts.repoPath) {
    const routes = extractAppRoutes(opts.repoPath, opts.appName ? { appName: opts.appName } : {});
    if (routes.length > 0) {
      const sn = routesToSeedAndNotes(routes, opts.url);
      seedUrls = sn.seedUrls;
      sourceNotes = sn.notes;
      log(`   source: ${routes.length} route(s) found, seeding ${seedUrls.length} into the crawl`);
    } else {
      log(`   source: no routes detected at ${opts.repoPath} (crawling links only)`);
    }
  }

  log(`① analyze: crawling app…${vision ? "" : " (DOM-only, text model)"}`);
  // crawl the start page + every seeded route + a few link-discovered pages
  const maxPages = Math.min(3 + seedUrls.length, 12);
  // pre-flight spend estimate — printed before any paid call so a runaway
  // config is visible up front
  const callCeiling =
    ANALYZE_ATTEMPTS + SCRIPT_ATTEMPTS + (vision ? VISION_QC_ATTEMPTS * (MAX_RETAKES + 1) : 0);
  log(
    `   LLM plan: ≤${maxPages} page(s) to crawl, vision ${vision ? "on" : "off"}, ` +
      `≤${callCeiling} LLM call(s), token budget ${budget > 0 ? budget : "off"} (--max-tokens / SUPERCUT_MAX_TOKENS)`,
  );
  const digests: PageDigest[] = await crawlApp(opts.url, {
    maxPages,
    screenshots: vision,
    allowPrivateNetwork: opts.allowPrivateNetwork ?? true,
    seedUrls,
    allowDestructive: opts.allowDestructive ?? false,
  });
  log(`   crawled ${digests.length} page(s), ${digests.reduce((n, d) => n + d.inventory.length, 0)} interactable elements`);
  // LOUD, never silent: if we excluded destructive controls, say which — so a
  // user whose hero action got filtered knows why and can opt back in.
  const excluded = [...new Set(digests.flatMap((d) => d.excludedDestructive ?? []))];
  if (excluded.length) {
    log(`   note: excluded ${excluded.length} destructive control(s) from filming — ${excluded.slice(0, 5).map((s) => `"${s}"`).join(", ")}${excluded.length > 5 ? "…" : ""}. Pass --allow-destructive to include them.`);
  }

  // analyze notes = source routes/summary + README/package.json. Both come
  // from the app's source (string literals, README, package.json) — exactly
  // where hardcoded tokens / internal URLs live — so redact them before egress,
  // matching the redaction DOM text already gets (parity, no asymmetry).
  const readme = opts.repoPath ? repoNotes(opts.repoPath) : undefined;
  const notes =
    [sourceNotes, readme]
      .filter((s): s is string => Boolean(s))
      .map(redactForPrompt)
      .join("\n\n") || undefined;
  const analysis = await analyzeApp(llm, digests, notes);
  log(`   product: ${analysis.product_summary.slice(0, 100)}`);
  for (const m of analysis.money_moments) log(`   moment: ${m.title}`);

  log("② script: writing recipe…");
  llm.stage = "script";
  const { recipe: firstRecipe, attempts } = await writeRecipe(llm, analysis, digests, opts.url);
  log(`   recipe valid after ${attempts} attempt(s): ${firstRecipe.scenes.length} scenes`);
  // full action preview BEFORE the capture browser touches the app — every
  // selector and every typed string is on the record for the operator
  for (const line of formatRecipePreview(firstRecipe)) log(`   ${line}`);

  if (opts.dryRun) {
    writeFileSync(join(opts.outDir, "recipe.json"), JSON.stringify(firstRecipe, null, 2));
    writeFileSync(
      join(opts.outDir, "director-report.json"),
      JSON.stringify(
        { analysis, recipe: firstRecipe, retakes: 0, verdictLog: [], llm: opts.llm.label, dryRun: true },
        null,
        2,
      ),
    );
    const tokensDry = llm.tokensUsed;
    log(`LLM usage: ${tokensDry !== undefined ? `~${tokensDry} tokens (${llm.breakdown()})` : "unavailable"}`);
    log(`dry run: recipe written to ${join(opts.outDir, "recipe.json")} — nothing was filmed`);
    return { outFile: "", recipe: firstRecipe, analysis, retakes: 0, verdictLog: [] };
  }

  let recipe = firstRecipe;
  let retakes = 0;
  const verdictLog: SceneVerdict[][] = [];
  let result: RecordResult;
  let takeDir: string;

  for (;;) {
    takeDir = join(opts.outDir, `take-${retakes}`);
    rmSync(takeDir, { recursive: true, force: true });
    log(`③ record: take ${retakes} (${recipe.scenes.length} scenes)…`);
    result = await record({ recipe, outDir: takeDir, seed: opts.seed ?? 1, allowPrivateNetwork: opts.allowPrivateNetwork ?? true });
    log(`   captured ${result.frameCount} frames (avg ${result.avgSourceFps.toFixed(1)} fps source)`);
    if (result.aborted) {
      throw new Error(
        `capture aborted: scenes failed [${result.failedScenes.join(", ")}] — app state may not match the recipe`,
      );
    }
    // capture-health gate, BEFORE any QC spend: a starved capture (repaint
    // beacon dead, page never committing frames) renders as a slideshow no
    // amount of QC patching can save — fail here, not after vision tokens.
    {
      const frameIndex = JSON.parse(readFileSync(join(takeDir, "frames-index.json"), "utf8"));
      const health = assessCaptureHealth(result.eventLog, frameIndex);
      if (health.action === "fail" && process.env.SUPERCUT_ALLOW_SPARSE !== "1") {
        throw new Error(
          `generate: ${health.reason}. The app may suspend rendering when headless, or the repaint ` +
            `beacon failed to attach — try re-running; SUPERCUT_ALLOW_SPARSE=1 forces a render anyway.`,
        );
      }
    }

    log("④ qc: deterministic checks…");
    const verdicts = deterministicChecks(result);
    if (vision) {
      log("④ qc: vision pass…");
      llm.stage = "qc";
      verdicts.push(...await visionQc(llm, takeDir, result.eventLog));
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
      // Do NOT adopt the patched recipe here. `takeDir` was
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
  const music = pickMusic(opts.music, recipe.music_track);
  if (music.warning) log(`   warning: ${music.warning}`);
  // NO on-screen text. supercut is a pure product demo — the product is the
  // whole story. The cinematic camera (zoom-to-action, frame-the-result) carries
  // it; nothing is ever drawn over the app. (The director still writes copy in
  // the report for reference, but it is deliberately NOT rendered.)
  const renderRes = await renderTake({
    takeDir,
    outFile,
    ...(opts.background ? { background: opts.background } : {}),
    ...(music.spec ? { music: music.spec } : {}),
  });
  log(`done: ${outFile} (${renderRes.frames} frames, ${(renderRes.encodedBytes / 1048576).toFixed(1)}MB, music ${music.label})`);

  writeFileSync(
    join(opts.outDir, "director-report.json"),
    JSON.stringify({ analysis, recipe, retakes, verdictLog, llm: opts.llm.label }, null, 2),
  );

  // best-effort cost telemetry (the hard cap lives in BudgetedLlmClient)
  const tokens = llm.tokensUsed;
  log(`LLM usage: ${tokens !== undefined ? `~${tokens} tokens (${llm.breakdown()})` : "unavailable"}`);

  return { outFile, recipe, analysis, retakes, verdictLog };
}
