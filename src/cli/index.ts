#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from "node:util";
import { ZodError } from "zod";
import { doctor } from "./doctor.js";
import { terminalSafe } from "../security/terminal.js";
import {
  CliError,
  describeArgsError,
  describeError,
  describeRecordError,
  formatZodError,
  parseJsonFile,
  recordOutcome,
} from "./errors.js";

/**
 * supercut: point it at your app, get the supercut.
 *
 *   supercut generate --url <app> [--repo <path>]                      full pipeline
 *   supercut record   --recipe <file> [--out <dir>] [--seed <n>]       stage 3 only
 *   supercut render   --take <dir> [--out <mp4>] [--bg <stage>]        stage 5 only
 *   supercut doctor                                                    check deps
 */

const HELP = `supercut: an AI director that films your real app into a cinematic 60s launch video

Usage:
  supercut generate --url <running app URL> [--repo <path>] [--music <track|file|off>]
  supercut record   --recipe <recipe.json> [--out <dir>] [--seed <n>]
  supercut render   --take <dir> [--out <file.mp4>] [--bg <wallpaper|palette|image>] [--music <track|file|off>]
  supercut doctor

Key generate flags:
  --url <url>       the running app to film (required)
  --repo <path>     the app's source, so the director films real routes
  --dry-run         crawl (page loads only), write recipe.json, stop before any click or typing
  --yes             film without the confirmation prompt (required when there is no terminal)
  --out <dir>       where the take and video go (default out/generate)
  --max-tokens <n>  LLM token ceiling, checked before every call (default 300000, 0 or off disables)
  --storage-state <file>    film signed in: a Playwright storage state (also on record)
  --block-private-network   refuse localhost and private addresses, for any target
  --allow-private-network   allow them even when the target is public (by default a
                            public target cannot reach private addresses)

generate needs an LLM key; record and render need none.
Run \`supercut generate --help\` for every generate flag.`;

const RECORD_USAGE =
  "usage: supercut record --recipe <recipe.json> [--out <dir>] [--seed <n>] [--storage-state <file>] [--block-private-network | --allow-private-network]";
const RENDER_USAGE =
  "usage: supercut render --take <take dir from record> [--out <file.mp4>] " +
  "[--bg cobalt|glacier|sunrise|daydream|magenta|coral|lavender|aurora|midnight|dusk|paper|<image path>] " +
  "[--music <bundled track|audio file|off>]";
const GENERATE_USAGE =
  "usage: supercut generate --url <running app URL> [--repo <path>] [--app <name>] [--out <dir>] " +
  "[--bg <stage>] [--music <bundled track|audio file|off>] [--seed <n>] [--model <id>] " +
  "[--env-file <file>] [--max-tokens <n|off>] [--dry-run] [--skip-preflight] [--storage-state <file>] " +
  "[--block-private-network | --allow-private-network] [--allow-destructive] [--no-vision] [--yes]";

/** parseArgs with plain-language failures. Positionals are accepted by the
 *  parse and rejected here with the usage line, since node's own error for a
 *  bare positional is a stack trace. */
function parse<T extends ParseArgsConfig["options"]>(args: string[], options: T, usage: string) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options });
  } catch (err) {
    throw new CliError(describeArgsError(err), usage);
  }
  if (parsed.positionals.length > 0) {
    const p0 = parsed.positionals[0]!;
    const hint = /^https?:\/\//.test(p0) ? ` (did you mean --url ${p0}?)` : "";
    throw new CliError(`unexpected argument "${p0}"${hint}`, usage);
  }
  return parsed.values;
}

/** Parse a non-negative integer flag value, or fail with the flag's name. */
function nonNegativeInt(raw: string, flag: string, usage: string, extra = ""): number {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < 0) {
    throw new CliError(`invalid ${flag} "${raw}" (expected a non-negative integer${extra})`, usage);
  }
  return n;
}

/** `--max-tokens` / SUPERCUT_MAX_TOKENS: an integer, 0, or "off" (= 0) */
function parseBudget(raw: string, source: string, usage: string): number {
  return raw.toLowerCase() === "off" ? 0 : nonNegativeInt(raw, source, usage, ' or "off"');
}

/**
 * The private-network posture from the two flags. Neither: the default, which
 * allows a private or localhost target and its private requests, and guards
 * a target that resolves public. --block-private-network: the strict guard
 * for any target. --allow-private-network: no guard, even for a public
 * target. Both at once is a contradiction and fails.
 */
function privateNetworkFlag(values: { "block-private-network"?: boolean; "allow-private-network"?: boolean }, usage: string): boolean | undefined {
  if (values["block-private-network"] && values["allow-private-network"]) {
    throw new CliError("--block-private-network and --allow-private-network contradict each other; pick one", usage);
  }
  if (values["block-private-network"]) return false;
  if (values["allow-private-network"]) return true;
  return undefined;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "doctor":
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log("usage: supercut doctor   (checks ffmpeg and Chromium/WebCodecs H.264, takes no flags)");
        return 0;
      }
      if (rest.length > 0) {
        throw new CliError(`doctor takes no arguments (got "${rest[0]}")`, "usage: supercut doctor");
      }
      return doctor();
    case "record": {
      // help is a real parsed boolean, not a substring scan, so a --help that
      // is the VALUE of another flag can't hijack the command.
      const values = parse(
        rest,
        {
          recipe: { type: "string" },
          out: { type: "string" },
          seed: { type: "string" },
          "storage-state": { type: "string" },
          "block-private-network": { type: "boolean" },
          "allow-private-network": { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
        RECORD_USAGE,
      );
      if (values.help) {
        console.log(RECORD_USAGE);
        return 0;
      }
      if (!values.recipe) throw new CliError("missing --recipe", RECORD_USAGE);
      // flags are validated before any file is read
      const seed = values.seed === undefined ? 1 : nonNegativeInt(values.seed, "--seed", RECORD_USAGE);
      const allowPrivateNetwork = privateNetworkFlag(values, RECORD_USAGE);

      const { readFileSync } = await import("node:fs");
      const { parseRecipe } = await import("../schema/index.js");
      let text: string;
      try {
        text = readFileSync(values.recipe, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const why = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "that is a directory" : String(code ?? err);
        throw new CliError(`cannot read recipe ${values.recipe}: ${why}`, RECORD_USAGE);
      }
      const raw = parseJsonFile(text, values.recipe, RECORD_USAGE);
      let recipe;
      try {
        recipe = parseRecipe(raw);
      } catch (err) {
        if (err instanceof ZodError) {
          throw new CliError(`${values.recipe} is not a valid recipe:\n${formatZodError(err)}`, RECORD_USAGE);
        }
        if (err instanceof Error && err.name === "RecipeValidationError") {
          throw new CliError(`${values.recipe} is not a valid recipe: ${err.message}`, RECORD_USAGE);
        }
        throw err;
      }

      const { record } = await import("../capture/index.js");
      const outDir = values.out ?? "out/take";
      console.log(`recording ${recipe.scenes.length} scene(s) from ${recipe.app_url} → ${outDir}`);
      const t0 = Date.now();
      const storageState = values["storage-state"] ? await storageStateOrUsage(values["storage-state"], RECORD_USAGE) : undefined;
      const res = await record({
        recipe, outDir, seed,
        ...(allowPrivateNetwork !== undefined ? { allowPrivateNetwork } : {}),
        ...(storageState ? { storageState } : {}),
      }).catch(
        (err: unknown) => {
          throw describeRecordError(err);
        },
      );
      console.log(
        `done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${res.frameCount} frames ` +
          `(avg ${res.avgSourceFps.toFixed(1)} fps source), ` +
          `${res.eventLog.events.length} events` +
          (res.failedScenes.length ? `, FAILED scenes: ${terminalSafe(res.failedScenes.join(", "))}` : ""),
      );
      // the take is on disk either way; a failed scene still means the caller
      // must not treat this run as a success
      const outcome = recordOutcome(res);
      for (const line of outcome.lines) console.error(line);
      return outcome.code;
    }
    case "render": {
      const values = parse(
        rest,
        {
          take: { type: "string" },
          out: { type: "string" },
          bg: { type: "string" },
          music: { type: "string" },
          help: { type: "boolean", short: "h" },
        },
        RENDER_USAGE,
      );
      if (values.help) {
        console.log(RENDER_USAGE);
        return 0;
      }
      if (!values.take) throw new CliError("missing --take", RENDER_USAGE);
      const { existsSync, statSync } = await import("node:fs");
      if (!existsSync(values.take) || !statSync(values.take).isDirectory()) {
        throw new CliError(
          `take directory ${values.take} not found (it is the --out directory of \`supercut record\`)`,
          RENDER_USAGE,
        );
      }
      const { renderTake } = await import("../render/index.js");
      const outFile = values.out ?? "out/final.mp4";
      console.log(`rendering take ${values.take} → ${outFile}`);
      const res = await renderTake({
        takeDir: values.take,
        outFile,
        ...(values.bg ? { background: values.bg } : {}),
        ...(values.music ? { music: values.music } : {}),
      });
      console.log(
        `done in ${(res.wallMs / 1000).toFixed(1)}s — ${res.frames} frames, ` +
          `${(res.encodedBytes / 1048576).toFixed(1)}MB encoded` +
          (res.music ? `, music: ${res.music}` : "") +
          ` → ${res.outFile}\n${res.summary} (report: ${res.reportFile})`,
      );
      return 0;
    }
    case "generate": {
      const values = parse(
        rest,
        {
          url: { type: "string" },
          repo: { type: "string" },
          app: { type: "string" },
          out: { type: "string" },
          bg: { type: "string" },
          music: { type: "string" },
          seed: { type: "string" },
          model: { type: "string" },
          "no-vision": { type: "boolean" },
          "env-file": { type: "string" },
          // LLM token ceiling for the whole run (SUPERCUT_MAX_TOKENS env);
          // 0 or "off" disables, default 300000
          "max-tokens": { type: "string" },
          // preview: analyze + script only; print every action (incl. typed
          // text), write recipe.json, and stop before capture touches the app
          "dry-run": { type: "boolean" },
          // skip the HTTP reachability probe (bare fetch, no browser UA), for
          // apps it misjudges; the ffmpeg + URL policy checks still run
          "skip-preflight": { type: "boolean" },
          // a Playwright storage state file: the crawl and every take run
          // signed in. Only its path is passed on.
          "storage-state": { type: "string" },
          help: { type: "boolean", short: "h" },
          // private network posture (see privateNetworkFlag): by default a
          // private target is allowed and a public one is guarded;
          // --block-private-network guards any target, --allow-private-network
          // guards none
          "block-private-network": { type: "boolean" },
          "allow-private-network": { type: "boolean" },
          // fail-safe OFF: destructive controls (Delete, Pay, ...) are excluded
          // from the inventory by default so the director can't script a real
          // harmful action on the live app. Opt in only when you trust the target.
          "allow-destructive": { type: "boolean" },
          yes: { type: "boolean" },
        },
        GENERATE_USAGE,
      );
      if (values.help) {
        console.log(GENERATE_USAGE);
        return 0;
      }
      if (!values.url) throw new CliError("missing --url", GENERATE_USAGE);
      // flags are validated before any file (.env, repo) is read
      const seed = values.seed === undefined ? undefined : nonNegativeInt(values.seed, "--seed", GENERATE_USAGE);
      const flagBudget =
        values["max-tokens"] !== undefined && values["max-tokens"].trim() !== ""
          ? parseBudget(values["max-tokens"], "--max-tokens", GENERATE_USAGE)
          : undefined;
      const allowPrivateNetwork = privateNetworkFlag(values, GENERATE_USAGE);
      // The action preview only protects anyone if a human can stop it. With
      // no terminal to ask on (CI, a coding agent, piped stdin) do not quietly
      // film a model-written recipe: refuse before any crawl or LLM spend
      // unless the caller opted in with --yes (--dry-run never films).
      if (!process.stdin.isTTY && !values.yes && !values["dry-run"]) {
        console.error(
          "generate: stdin is not a terminal, so supercut cannot ask before it clicks and types in your app.\n" +
            "Pass --yes to film without confirmation, or --dry-run to preview the recipe first.",
        );
        return 1;
      }
      const storageState = values["storage-state"]
        ? await storageStateOrUsage(values["storage-state"], GENERATE_USAGE)
        : undefined;
      const { dotEnvWarnings, loadDotEnv, resolveProvider } = await import("../director/config.js");
      const { dryRunFollowUpCommand, generate } = await import("../director/generate.js");
      const envLoad = loadDotEnv(values["env-file"] ?? ".env");
      // a missing .env is fine (reason "not found"), but a file that EXISTED
      // and failed to PARSE is a real error: surface it even without verbose
      // so a malformed .env isn't silently swallowed (the user would otherwise
      // see only a downstream "no API key").
      if (envLoad.reason === "not found") {
        if (process.env.SUPERCUT_VERBOSE) console.error(`env: ${envLoad.path} ${envLoad.reason}`);
      } else if (envLoad.reason) {
        console.error(`env: failed to parse ${envLoad.path}: ${envLoad.reason}`);
      }
      // a .env nobody named can redirect where the app's content goes, or
      // lift the spend ceiling: say so loudly, every time (even with --yes)
      for (const line of dotEnvWarnings(envLoad.path, envLoad.applied ?? [], process.env, { explicit: !!values["env-file"] })) {
        console.error(terminalSafe(line));
      }
      // flag wins over env; 0 or "off" disables the cap (generate defaults to
      // 300000). An empty value is treated as unset: Number("") is 0, which
      // would silently disable the budget.
      let maxTokens = flagBudget;
      if (maxTokens === undefined) {
        const envBudget = process.env.SUPERCUT_MAX_TOKENS;
        if (envBudget !== undefined && envBudget.trim() !== "") {
          maxTokens = parseBudget(envBudget, "SUPERCUT_MAX_TOKENS", GENERATE_USAGE);
        }
      }
      // privacy notice (informational, NOT a gate). --yes silences it, and
      // also skips the pre-capture confirmation below.
      if (!values.yes) {
        console.error(
          "privacy: generate sends crawled page text" +
            (values.repo ? " and repo notes" : "") +
            " to your configured LLM provider. In vision mode, FULL UNREDACTED\n" +
            "SCREENSHOTS of your app are uploaded too. Text redaction is best-effort and cannot cover images.\n" +
            "Don't film apps showing real customer data or secrets with vision on. (record/render need no LLM.)",
        );
      }
      let provider;
      try {
        provider = resolveProvider(process.env, { ...(values.model ? { model: values.model } : {}) });
      } catch (err) {
        console.error(
          `${err instanceof Error ? err.message : err}\n` +
            "No key? `supercut record` + `supercut render` work fully without one, " +
            "and your coding agent can write the recipe (see the supercut skill in the README).",
        );
        return 1;
      }
      console.log(`director: ${provider.summary}`);
      const res = await generate({
        llm: provider.client,
        url: values.url,
        outDir: values.out ?? "out/generate",
        // --no-vision forces off; otherwise follow the provider's capability
        vision: values["no-vision"] ? false : provider.vision,
        ...(values.repo ? { repoPath: values.repo } : {}),
        ...(values.app ? { appName: values.app } : {}),
        ...(values.bg ? { background: values.bg } : {}),
        ...(values.music ? { music: values.music } : {}),
        ...(seed !== undefined ? { seed } : {}),
        // unset: private targets allowed, public targets guarded
        ...(allowPrivateNetwork !== undefined ? { allowPrivateNetwork } : {}),
        // default OFF; --allow-destructive opts into filming destructive controls
        allowDestructive: !!values["allow-destructive"],
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(values["dry-run"] ? { dryRun: true } : {}),
        ...(values["skip-preflight"] ? { skipPreflight: true } : {}),
        ...(storageState ? { storageState } : {}),
        // a human at a terminal gets the last word between the printed action
        // preview and the first real click; --yes proceeds without asking (a
        // non-TTY stdin without --yes was refused above)
        ...(process.stdin.isTTY && !values.yes ? { confirmCapture: confirmOnTty } : {}),
      });
      if (values["dry-run"]) {
        // the suggested command must preserve the security posture of THIS
        // run: an explicit network flag and the session carry over
        const followUp = dryRunFollowUpCommand(values.out ?? "out/generate", {
          blockPrivateNetwork: allowPrivateNetwork === false,
          allowPrivateNetwork: allowPrivateNetwork === true,
          ...(values["storage-state"] ? { storageState: values["storage-state"] } : {}),
        });
        console.log(`\nsupercut: dry run complete. Review the recipe, then film it with:\n  ${followUp}`);
        return 0;
      }
      console.log(`\nsupercut: ${res.outFile} (${res.recipe.scenes.length} scenes, ${res.retakes} re-take(s))`);
      return 0;
    }
    case undefined:
    case "--help":
    case "-h":
      console.log(HELP);
      return command === undefined ? 1 : 0;
    default:
      console.error(`unknown command "${command}"\n\n${HELP}`);
      return 1;
  }
}

/** --storage-state: a readable Playwright storage state file, or a usage
 *  error that names the problem without quoting the file */
async function storageStateOrUsage(path: string, usage: string): Promise<string> {
  const { assertStorageStateFile } = await import("../capture/session.js");
  try {
    return assertStorageStateFile(path);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), usage);
  }
}

/** y/N prompt on stderr (stdout stays clean for piping) */
async function confirmOnTty(info: { maxPerformances: number }): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const { captureConsentPrompt } = await import("../director/retakes.js");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(captureConsentPrompt(info.maxPerformances));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// process.exitCode, not process.exit(): an explicit exit() can truncate
// buffered stdout when the CLI's output is piped. Set the code and let the
// process drain and exit on its own (all servers/browsers are closed by now).
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // an error can quote a scene name or page text: escape control
    // characters, keeping the message's own line breaks
    const safe = (s: string) => s.split("\n").map(terminalSafe).join("\n");
    if (err instanceof CliError) {
      console.error(safe(`supercut: ${err.message}`));
      if (err.usage) console.error(err.usage);
    } else {
      console.error(safe(describeError(err)));
    }
    process.exitCode = 1;
  },
);
