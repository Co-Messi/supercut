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
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { record, type RecordResult } from "../capture/index.js";
import { assertBackground, assessCaptureHealth, renderTake, resolveMusicTrack } from "../render/index.js";
import type { Recipe } from "../schema/index.js";
import { analyzeApp, type AppAnalysis } from "./analyze.js";
import { assessCrawl, crawlApp, type PageDigest } from "./inventory.js";
import { assertStorageStateFile } from "../capture/session.js";
import { BudgetedLlmClient, type LlmClient } from "./llm.js";
import { deterministicChecks, visionQc, visionVerdictsOrNone, type SceneVerdict } from "./qc.js";
import { AllScenesCutAfterTakeError, filmWithRetakes, MAX_RETAKES, type FilmResult } from "./retakes.js";
import { hasAdjustments, NO_ADJUSTMENTS, type TakeAdjustments } from "../render/adjust.js";
import { writeRecipe } from "./script.js";
import { assertSafeNavigationUrl } from "../security/url-policy.js";
import { publicTargetNote, resolvePrivateNetworkPolicy } from "../security/network-policy.js";
import { redactForPrompt } from "../security/redaction.js";
import { quoteForTerminal, terminalSafe } from "../security/terminal.js";
import { extractAppRoutes, routesToSeedAndNotes } from "./sourceRoutes.js";

const exec = promisify(execFile);
/** default token budget for a whole run — generous for a normal run
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
  /** Private-network posture. Unset (the default, shared with record() and
   *  crawlApp()): a private or localhost target is your own app, so it and
   *  its private requests are allowed; a target that resolves public gets
   *  the SSRF guard, so its pages cannot reach private addresses. true allows
   *  everything; false engages the guard for any target. */
  allowPrivateNetwork?: boolean;
  /** opt-in: let the director see (and therefore script) destructive controls
   *  (Delete, Pay, …). OFF by default — fail-safe so a prompt-injected page
   *  can't steer a real harmful action on the live app. */
  allowDestructive?: boolean;
  /** cumulative token ceiling for the run's LLM calls (prompt+completion,
   *  provider-reported). 0 disables. Default: 300000. */
  maxTokens?: number;
  /** preview mode: run analyze + script, print the FULL action list (every
   *  selector, every typed string), write recipe.json — and stop before the
   *  capture browser ever touches the app. The recipe can be reviewed and then
   *  filmed with `supercut record --recipe <dir>/recipe.json`. */
  dryRun?: boolean;
  /** skip the preflight HTTP reachability probe. Escape hatch for apps the
   *  bare-fetch probe misjudges (aggressive UA gating, unusual status codes at
   *  `/`); the ffmpeg check and all URL policy checks still run. */
  skipPreflight?: boolean;
  /** path to a Playwright storage state file (cookies and localStorage of a
   *  signed-in session), applied to the crawl and to every take. Only the
   *  path is handed to the browser: the contents never reach a prompt, the
   *  take directory, director-report.json or a log line. */
  storageState?: string;
  /** asked once, after the action preview is printed and before the capture
   *  browser first touches the app; resolving false cancels the run (the
   *  recipe is still written). The CLI supplies it when a human can answer
   *  (stdin is a TTY and --yes is absent). `maxPerformances` is how many
   *  times each action may run against the app under this one answer (the
   *  first take plus the QC re-takes); the question must state it. */
  confirmCapture?: (info: { maxPerformances: number }) => Promise<boolean>;
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

export async function preflight(
  url: string,
  allowPrivateNetwork: boolean,
  opts: { skipReachability?: boolean; skipRenderDeps?: boolean; log?: (msg: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? ((m: string) => console.error(`[generate] ${m}`));
  // app reachable — error in seconds, never after 10 minutes of work.
  // Follow redirects MANUALLY and validate EVERY hop BEFORE the request: a
  // default `fetch` follows 3xx automatically, so a public URL that 302s to
  // http://169.254.169.254/ (cloud metadata) or an RFC1918 host would already
  // have made the internal request before any post-hoc check. SSRF-guard errors
  // propagate as-is (a security failure, not "cannot reach"); only network
  // errors get the friendly reachability message.
  if (!opts.skipReachability) {
    // even when the probe is skipped, the URL itself is still policy-checked
    // by the caller and the crawl; here it gates the probe's own fetch
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
      // 401/403 at the root is NORMAL for the "film your own dev app" case —
      // basic auth, a dev proxy, an SSO shim, an API-first backend. And this
      // probe is a bare Node fetch (no browser UA, no cookies) while the crawl
      // is Chromium, so a UA-gating edge can 403 a URL Chromium loads fine.
      // Warn and continue; if the wall is real the crawl shows it in seconds.
      // Everything else >= 400 is as doomed as it looks (a 404/410/5xx start
      // page films as an error screen) and would otherwise surface only deep
      // in the crawl, so fail here. --skip-preflight overrides the whole probe.
      if (status === 401 || status === 403) {
        log(
          `preflight warning: ${url} responded ${status} — continuing (auth walls at the root are ` +
            `normal for private dev apps, and this probe carries no browser UA or cookies). ` +
            `If the whole app is behind that wall, the crawl will come back empty.`,
        );
      } else if (status >= 400) {
        throw new Error(
          `app at ${url} responded ${status} — point --url at a page that loads, ` +
            `or pass --skip-preflight if you know better`,
        );
      }
      if (status >= 300 && status < 400) throw new Error(`preflight: ${url} kept redirecting (loop?)`);
    } finally {
      clearTimeout(timer);
    }
  }
  // A recipe preview must not need the render toolchain: --dry-run
  // stops after analyze + script, so nothing is filmed or rendered and a
  // machine without ffmpeg can still produce and review a recipe. The URL
  // policy and reachability checks above still ran.
  if (opts.skipRenderDeps) return;
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
export function formatRecipePreview(
  recipe: Recipe,
  /** the crawled tag of a selector on a page, when known: says whether a type
   *  clears the field first (its own input or textarea) or appends */
  fieldTag?: (pageUrl: string, selector: string) => string | undefined,
): string[] {
  const typeEffect = (url: string, selector: string | undefined): string => {
    const tag = selector ? fieldTag?.(url, selector) : undefined;
    if (tag === undefined) return " (replaces existing text in an input or textarea, appends elsewhere)";
    return tag === "input" || tag === "textarea" ? " (replaces existing text)" : " (appends to existing text)";
  };
  // every field is model output derived from page text: control characters
  // show as escapes, and quoted fields are JSON string literals
  const q = quoteForTerminal;
  const t = terminalSafe;
  const lines: string[] = [];
  for (const [i, scene] of recipe.scenes.entries()) {
    lines.push(
      `scene ${i + 1} ${q(scene.name)} @ ${t(scene.entry.url)}` +
        (scene.depends_on.length ? ` (after ${scene.depends_on.map(q).join(", ")})` : ""),
    );
    for (const a of [...scene.entry.prelude, ...scene.actions]) {
      let desc = a.kind as string;
      if (a.kind === "goto" && a.url) desc += ` ${t(a.url)}`;
      if (a.selector) desc += ` ${t(a.selector)}`;
      if (a.kind === "type") {
        desc += ` ${q(a.text ?? "")}${a.submit ? " then press Enter" : ""}${typeEffect(scene.entry.url, a.selector)}`;
      }
      desc += ` (${a.duration_ms}ms${a.focus_selector ? `, focus ${t(a.focus_selector)}` : ""})`;
      lines.push(`  · ${desc}`);
    }
    if (scene.hold_ms > 0) lines.push(`  · hold ${scene.hold_ms}ms`);
  }
  return lines;
}

/** POSIX-shell quote one argument for a command we print for the user to
 *  paste: safe words pass through untouched, anything else is single-quoted
 *  (an embedded ' becomes '\''). */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The follow-up command a --dry-run tells the user to copy. Flags that set
 * record's SECURITY posture must survive the copy-paste: `record` allows
 * private networks by default, so a recipe generated under
 * --block-private-network must carry the flag into the suggested line — the
 * user who asked for the guard and then runs exactly what the tool printed
 * must not silently lose it.
 */
export function dryRunFollowUpCommand(
  outDir: string,
  opts: { blockPrivateNetwork?: boolean; allowPrivateNetwork?: boolean; storageState?: string } = {},
): string {
  return (
    `supercut record --recipe ${shellQuote(join(outDir, "recipe.json"))}` +
    (opts.blockPrivateNetwork ? " --block-private-network" : "") +
    (opts.allowPrivateNetwork && !opts.blockPrivateNetwork ? " --allow-private-network" : "") +
    // a signed-in recipe filmed without its session films the login wall
    (opts.storageState ? ` --storage-state ${shellQuote(opts.storageState)}` : "")
  );
}

/** The repo's README.md or package.json, for the analyze prompt. Only a
 *  regular file is read: a symlink (README.md pointing at ~/.aws/credentials
 *  in a hostile repo) is skipped, as the source walk skips them. */
export function repoNotes(repoPath: string): string | undefined {
  for (const f of ["README.md", "readme.md", "package.json"]) {
    const p = join(repoPath, f);
    try {
      if (!lstatSync(p).isFile()) continue;
      return readFileSync(p, "utf8").slice(0, 4000);
    } catch {
      /* missing or unreadable: next */
    }
  }
  return undefined;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  // log lines carry model and page strings (product summary, moment titles,
  // verdict reasons, excluded labels): none may reach the terminal raw
  const sink = opts.log ?? ((m: string) => console.log(`[generate] ${m}`));
  const log = (m: string): void => sink(terminalSafe(m));
  const vision = opts.vision !== undefined ? opts.vision : !(opts.noVision ?? false);
  const budget = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  // every LLM call in the run goes through the budget guard (analyze, script,
  // and vision QC all receive this wrapper) — no stage can spend past the cap
  const llm = new BudgetedLlmClient(opts.llm, budget);
  // spend summary. The budget is ENFORCED against meteredTokens (provider-
  // reported where available, locally estimated where not), so that is the
  // headline number; on a mixed-reporting provider a diverging provider total
  // is shown alongside instead of silently replacing the enforced one —
  // "unavailable" only when nothing was called at all.
  const usageLine = (): string => {
    const metered = llm.meteredTokens;
    const reported = llm.tokensUsed;
    if (metered <= 0) return reported !== undefined ? `~${reported} tokens (${llm.breakdown()})` : "unavailable";
    if (reported === undefined) {
      return `~${metered} tokens (locally estimated — provider reported no usage; ${llm.breakdown()})`;
    }
    if (reported === metered) return `~${reported} tokens (${llm.breakdown()})`;
    return `~${metered} tokens metered against the budget (provider reported ${reported}; ${llm.breakdown()})`;
  };
  mkdirSync(opts.outDir, { recursive: true });

  log("preflight…");
  // a bad --music must die here, not after the LLM crawl and capture spend
  resolveMusicTrack(opts.music);
  // and so must a bad --bg: it would otherwise fail at render, after it all
  assertBackground(opts.background);
  // a bad session file must die here too, before the crawl and any LLM call
  const storageState = opts.storageState ? assertStorageStateFile(opts.storageState) : undefined;
  if (storageState) log("   session: --storage-state is applied to the crawl and the capture");
  if (opts.skipPreflight) log("   note: --skip-preflight — not probing the app URL before the crawl");
  // one posture for the whole run (preflight, crawl, every take), decided
  // from the target when the caller did not choose
  const { allowPrivateNetwork, reason: networkReason } = await resolvePrivateNetworkPolicy(opts.url, opts.allowPrivateNetwork);
  if (networkReason === "public-target") log(`   ${publicTargetNote(opts.url)}`);
  await preflight(opts.url, allowPrivateNetwork, {
    ...(opts.skipPreflight ? { skipReachability: true } : {}),
    // dry runs never render — don't fail the preview on a missing ffmpeg
    ...(opts.dryRun ? { skipRenderDeps: true } : {}),
    log: (m) => log(`   ${m}`),
  });

  // Everything the run learns is kept here so the finalizer can write it on
  // ANY exit: the runs that fail (aborted capture, sparse capture, stage
  // exhaustion, budget exceeded, render failure) are exactly the ones whose
  // spend and model output the user most needs to see.
  let analysis: AppAnalysis | undefined;
  /** always the recipe of the take being (or last) filmed */
  let recipe: Recipe | undefined;
  let retakes = 0;
  const verdictLog: SceneVerdict[][] = [];
  /** QC holds and zooms applied to the rendered take (never re-filmed) */
  let renderAdjustments: TakeAdjustments = NO_ADJUSTMENTS;
  let usageLogged = false;
  const logUsage = (): void => {
    if (usageLogged) return;
    usageLogged = true;
    log(`LLM usage: ${usageLine()}`);
  };
  const writeArtifacts = (extra: { dryRun?: boolean; error?: string } = {}): void => {
    if (recipe) writeFileSync(join(opts.outDir, "recipe.json"), JSON.stringify(recipe, null, 2));
    writeFileSync(
      join(opts.outDir, "director-report.json"),
      JSON.stringify(
        { analysis, recipe, retakes, takes: retakes + 1, verdictLog, renderAdjustments, llm: opts.llm.label, ...extra },
        null,
        2,
      ),
    );
  };

  try {
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
      allowPrivateNetwork,
      seedUrls,
      allowDestructive: opts.allowDestructive ?? false,
      ...(storageState ? { storageState } : {}),
    });
    log(`   crawled ${digests.length} page(s), ${digests.reduce((n, d) => n + d.inventory.length, 0)} interactable elements`);
    // LOUD, never silent: if we excluded destructive controls, say which — so a
    // user whose hero action got filtered knows why and can opt back in.
    const excluded = [...new Set(digests.flatMap((d) => d.excludedDestructive ?? []))];
    if (excluded.length) {
      log(`   note: excluded ${excluded.length} destructive control(s) from filming — ${excluded.slice(0, 5).map((s) => `"${s}"`).join(", ")}${excluded.length > 5 ? "…" : ""}. Pass --allow-destructive to include them.`);
    }
    const noSubmit = digests.reduce((n, d) => n + d.inventory.filter((i) => i.submitsDestructive).length, 0);
    if (noSubmit > 0) {
      log(`   note: ${noSubmit} field(s) may be typed into but never submitted: their form submits through a destructive control.`);
    }
    // nothing to film (an empty page, a login wall) is known now, before any
    // LLM call: stop here rather than pay the analyze stage to find out
    const unfilmable = assessCrawl(digests, { hadSession: !!storageState });
    if (unfilmable) throw new Error(`generate: ${unfilmable}`);

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
    analysis = await analyzeApp(llm, digests, notes);
    log(`   product: ${analysis.product_summary.slice(0, 100)}`);
    for (const m of analysis.money_moments) log(`   moment: ${m.title}`);

    log("② script: writing recipe…");
    llm.stage = "script";
    const written = await writeRecipe(llm, analysis, digests, opts.url);
    recipe = written.recipe;
    log(`   recipe valid after ${written.attempts} attempt(s): ${recipe.scenes.length} scenes`);
    if (written.warning) log(`   warning: ${written.warning}`);
    // full action preview BEFORE the capture browser touches the app — every
    // selector and every typed string is on the record for the operator
    const tags = new Map(digests.flatMap((d) => d.inventory.map((i) => [`${d.url} ${i.selector}`, i.tag] as const)));
    for (const line of formatRecipePreview(recipe, (url, sel) => tags.get(`${url} ${sel}`))) log(`   ${line}`);

    if (opts.dryRun) {
      writeArtifacts({ dryRun: true });
      logUsage();
      log(`dry run: recipe written to ${join(opts.outDir, "recipe.json")} — nothing was filmed`);
      return { outFile: "", recipe, analysis, retakes: 0, verdictLog: [] };
    }

    const maxPerformances = 1 + MAX_RETAKES;
    log(
      `   capture: each action runs once per take; a QC re-take (only to drop a scene) films the recipe again, ` +
        `at most ${maxPerformances} take(s) in total`,
    );
    if (opts.confirmCapture && !(await opts.confirmCapture({ maxPerformances }))) {
      throw new Error(
        `capture cancelled — nothing was filmed. The recipe is at ${join(opts.outDir, "recipe.json")}; ` +
          `review or edit it, then film it with: ${dryRunFollowUpCommand(opts.outDir, {
            blockPrivateNetwork: opts.allowPrivateNetwork === false,
            allowPrivateNetwork: opts.allowPrivateNetwork === true,
            ...(opts.storageState ? { storageState: opts.storageState } : {}),
          })}`,
      );
    }

    const recordTake = async (filming: Recipe, index: number): Promise<{ result: RecordResult; takeDir: string }> => {
      // the report always describes the take being (or last) filmed
      recipe = filming;
      retakes = index;
      const takeDir = join(opts.outDir, `take-${index}`);
      rmSync(takeDir, { recursive: true, force: true });
      log(`③ record: take ${index} (${filming.scenes.length} scenes)…`);
      const result = await record({
        recipe: filming, outDir: takeDir, seed: opts.seed ?? 1, allowPrivateNetwork,
        ...(storageState ? { storageState } : {}),
      });
      log(`   captured ${result.frameCount} frames (avg ${result.avgSourceFps.toFixed(1)} fps source)`);
      if (result.aborted) {
        throw new Error(
          `capture aborted: scenes failed [${result.failedScenes.join(", ")}] — app state may not match the recipe` +
            formatSceneErrors(result.sceneErrors),
        );
      }
      // capture-health gate, BEFORE any QC spend: a starved capture (repaint
      // beacon dead, page never committing frames) renders as a slideshow no
      // amount of QC patching can save — fail here, not after vision tokens.
      {
        const rawIndex = JSON.parse(readFileSync(join(takeDir, "frames-index.json"), "utf8"));
        // shape guard mirrors renderTake's: a non-array would make `.length`
        // undefined and the sparse comparison silently false — gate passed.
        // record() just wrote this file, so today it can't happen; the guard is
        // for whatever writes it tomorrow.
        if (!Array.isArray(rawIndex)) throw new Error("generate: frames-index.json is not an array");
        const health = assessCaptureHealth(result.eventLog, rawIndex);
        if (health.action === "fail") {
          if (process.env.SUPERCUT_ALLOW_SPARSE === "1") {
            // LOUD, matching render/index.ts: someone who exported the variable
            // once to salvage an old take must not keep generating starved
            // videos with no line saying the health gate is off
            console.error(`[generate] WARNING: ${health.reason} (continuing: SUPERCUT_ALLOW_SPARSE=1)`);
          } else {
            throw new Error(
              `generate: ${health.reason}. The app may suspend rendering when headless, or the repaint ` +
                `beacon failed to attach — try re-running; SUPERCUT_ALLOW_SPARSE=1 forces a render anyway.`,
            );
          }
        }
      }
      return { result, takeDir };
    };

    const qcTake = async (result: RecordResult, takeDir: string): Promise<SceneVerdict[]> => {
      log("④ qc: deterministic checks…");
      const verdicts = deterministicChecks(result);
      if (vision) {
        log("④ qc: vision pass…");
        llm.stage = "qc";
        verdicts.push(...await visionVerdictsOrNone(() => visionQc(llm, takeDir, result.eventLog), log));
      }
      return verdicts;
    };

    let film: FilmResult;
    try {
      film = await filmWithRetakes({ recipe, maxRetakes: MAX_RETAKES, recordTake, qc: qcTake, log, verdictLog });
    } catch (err) {
      if (!(err instanceof AllScenesCutAfterTakeError)) throw err;
      // Refusing to render an empty video is right; discarding a recorded,
      // renderable take after the full crawl + both LLM stages + a complete
      // capture is not. The finalizer preserves every artifact; fail with the
      // way out.
      throw new Error(
        `QC cut every scene (${err.cut.join(", ")}) — refusing to render an empty video. ` +
          `The recorded take is preserved at ${err.takeDir} (recipe.json and director-report.json ` +
          `sit beside it); inspect the verdicts, and render it anyway with: ` +
          `supercut render --take ${shellQuote(err.takeDir)}`,
      );
    }
    const { result, takeDir, adjustments } = film;
    renderAdjustments = adjustments;
    recipe = film.recipe;
    retakes = film.retakes;

    // report + usage BEFORE render (the finalizer rewrites the report with
    // the error if render fails): the artifacts exist even if the process is
    // killed mid-encode
    writeArtifacts();
    logUsage();

    log("⑤ render…");
    const outFile = join(opts.outDir, "final.mp4");
    const music = pickMusic(opts.music, recipe.music_track);
    if (music.warning) log(`   warning: ${music.warning}`);
    // NO on-screen text. supercut is a pure product demo — the product is the
    // whole story. The cinematic camera (zoom-to-action, frame-the-result) carries
    // it; nothing is ever drawn over the app. (The director still writes copy in
    // the report for reference, but it is deliberately NOT rendered.)
    // record() aborts the take when most scenes fail; a take that lost a few
    // lower-priority scenes is still filmed, QC'd and rendered here, so the
    // render's partial-take gate is lifted for this one known take only.
    const partial = result.failedScenes.length > 0;
    if (partial) {
      log(
        `   warning: rendering without failed scene(s) [${result.failedScenes.join(", ")}]` +
          formatSceneErrors(result.sceneErrors),
      );
    }
    const renderRes = await renderTake({
      takeDir,
      outFile,
      ...(partial ? { allowPartial: true } : {}),
      ...(opts.background ? { background: opts.background } : {}),
      ...(music.spec ? { music: music.spec } : {}),
      ...(hasAdjustments(adjustments) ? { adjust: adjustments } : {}),
    });
    log(`done: ${outFile} (${renderRes.frames} frames, ${(renderRes.encodedBytes / 1048576).toFixed(1)}MB, music ${music.label})`);
    // a take a re-take replaced is hundreds of MB of frames no video uses:
    // once the video exists, only the rendered take is kept
    for (let i = 0; i < retakes; i++) rmSync(join(opts.outDir, `take-${i}`), { recursive: true, force: true });
    if (retakes > 0) log(`   removed ${retakes} superseded take(s); the rendered take is ${takeDir}`);

    return { outFile, recipe, analysis, retakes, verdictLog };
  } catch (err) {
    try {
      writeArtifacts({ error: err instanceof Error ? err.message : String(err) });
    } catch {
      /* never mask the run's own error with a report-write failure */
    }
    logUsage();
    throw err;
  }
}

/** "; name: reason" pairs for the scenes record() reported as failed. */
function formatSceneErrors(errors: Record<string, string> | undefined): string {
  const entries = Object.entries(errors ?? {});
  return entries.length ? ` (${entries.map(([name, reason]) => `${name}: ${reason}`).join("; ")})` : "";
}
