#!/usr/bin/env node
import { parseArgs } from "node:util";
import { doctor } from "./doctor.js";

/**
 * supercut — point it at your app, get the supercut.
 *
 *   supercut generate --url <app> [--repo <path>]                      full pipeline
 *   supercut record   --recipe <file> [--out <dir>] [--seed <n>]       stage 3 only
 *   supercut render   --take <dir> [--out <mp4>] [--bg <stage>]        stage 5 only
 *   supercut doctor                                                    check deps
 */

const HELP = `supercut — institutional-grade 60s launch videos from your real app

Usage:
  supercut generate --url <running app URL> [--repo <path>]
  supercut record   --recipe <recipe.json> [--out <dir>] [--seed <n>]
  supercut render   --take <dir> [--out <file.mp4>] [--bg aurora|midnight|dusk|paper|<asset>|<image>]
  supercut doctor

Run any command with --help for details.`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "doctor":
      return doctor();
    case "record": {
      const recordUsage =
        "usage: supercut record --recipe <recipe.json> [--out <dir>] [--seed <n>] [--block-private-network]";
      // A1: subcommands advertised "--help" but strict parseArgs would throw on
      // it — intercept before parsing and print this command's usage.
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(recordUsage);
        return 0;
      }
      const { values } = parseArgs({
        args: rest,
        options: {
          recipe: { type: "string" },
          out: { type: "string" },
          seed: { type: "string" },
          "block-private-network": { type: "boolean" },
          "allow-private-network": { type: "boolean" }, // deprecated no-op
        },
      });
      if (!values.recipe) {
        console.error(recordUsage);
        return 1;
      }
      // A1: --allow-private-network is parsed for back-compat but ignored;
      // warn that it no longer does anything so callers don't rely on it.
      if (values["allow-private-network"]) {
        console.error(
          "--allow-private-network is deprecated and ignored; private/localhost is allowed by default — use --block-private-network to restrict",
        );
      }
      const { readFileSync } = await import("node:fs");
      const { parseRecipe } = await import("../schema/index.js");
      const { record } = await import("../capture/index.js");

      const recipe = parseRecipe(JSON.parse(readFileSync(values.recipe, "utf8")));
      const outDir = values.out ?? "out/take";
      console.log(`recording ${recipe.scenes.length} scene(s) from ${recipe.app_url} → ${outDir}`);
      const t0 = Date.now();
      const seed = values.seed === undefined ? 1 : Number(values.seed);
      if (!Number.isInteger(seed) || seed < 0) {
        console.error(`invalid --seed "${values.seed}" (expected a non-negative integer)`);
        return 1;
      }
      const res = await record({ recipe, outDir, seed, allowPrivateNetwork: !values["block-private-network"] });
      console.log(
        `done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${res.frameCount} frames, ` +
          `${res.eventLog.events.length} events` +
          (res.failedScenes.length ? `, FAILED scenes: ${res.failedScenes.join(", ")}` : ""),
      );
      return res.aborted ? 1 : 0;
    }
    case "render": {
      const renderUsage =
        "usage: supercut render --take <take dir from record> [--out <file.mp4>] " +
        "[--bg aurora|midnight|dusk|paper|<image path>]";
      // A1: print this command's usage on --help instead of letting strict
      // parseArgs throw on the unknown flag.
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(renderUsage);
        return 0;
      }
      const { values } = parseArgs({
        args: rest,
        options: {
          take: { type: "string" },
          out: { type: "string" },
          bg: { type: "string" },
        },
      });
      if (!values.take) {
        console.error(renderUsage);
        return 1;
      }
      const { renderTake } = await import("../render/index.js");
      const outFile = values.out ?? "out/final.mp4";
      console.log(`rendering take ${values.take} → ${outFile}`);
      const res = await renderTake({
        takeDir: values.take,
        outFile,
        ...(values.bg ? { background: values.bg } : {}),
      });
      console.log(
        `done in ${(res.wallMs / 1000).toFixed(1)}s — ${res.frames} frames, ` +
          `${(res.encodedBytes / 1048576).toFixed(1)}MB encoded → ${res.outFile}`,
      );
      return 0;
    }
    case "generate": {
      const generateUsage =
        "usage: supercut generate --url <running app URL> [--repo <path>] [--out <dir>] " +
        "[--bg <stage>] [--seed <n>] [--model <id>] [--env-file <file>] [--block-private-network] [--allow-destructive] [--no-vision]";
      // A1: print this command's usage on --help instead of letting strict
      // parseArgs throw on the unknown flag.
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(generateUsage);
        return 0;
      }
      const { values } = parseArgs({
        args: rest,
        options: {
          url: { type: "string" },
          repo: { type: "string" },
          app: { type: "string" },
          out: { type: "string" },
          bg: { type: "string" },
          seed: { type: "string" },
          model: { type: "string" },
          "no-vision": { type: "boolean" },
          "env-file": { type: "string" },
          // private/localhost is ALLOWED BY DEFAULT — filming your own local
          // dev app is the #1 use case. --block-private-network opts into the
          // SSRF guard (for untrusted/public targets). --allow-private-network
          // kept as a deprecated no-op for back-compat.
          "block-private-network": { type: "boolean" },
          "allow-private-network": { type: "boolean" },
          // fail-safe OFF: destructive controls (Delete, Pay, …) are excluded
          // from the inventory by default so the director can't script a real
          // harmful action on the live app. Opt in only when you trust the target.
          "allow-destructive": { type: "boolean" },
          yes: { type: "boolean" },
        },
      });
      if (!values.url) {
        console.error(generateUsage);
        return 1;
      }
      // A1: --allow-private-network is parsed for back-compat but ignored;
      // warn that it no longer does anything so callers don't rely on it.
      if (values["allow-private-network"]) {
        console.error(
          "--allow-private-network is deprecated and ignored; private/localhost is allowed by default — use --block-private-network to restrict",
        );
      }
      const { loadDotEnv, resolveProvider } = await import("../director/config.js");
      const { generate } = await import("../director/generate.js");
      const envLoad = loadDotEnv(values["env-file"] ?? ".env");
      // L2: a missing .env is fine (reason "not found"), but a file that EXISTED
      // and failed to PARSE is a real error — surface it even without verbose so
      // a malformed .env isn't silently swallowed (user otherwise sees only a
      // downstream "no API key").
      if (envLoad.reason === "not found") {
        if (process.env.SUPERCUT_VERBOSE) console.error(`env: ${envLoad.path} ${envLoad.reason}`);
      } else if (envLoad.reason) {
        console.error(`env: failed to parse ${envLoad.path} — ${envLoad.reason}`);
      }
      const seed = values.seed === undefined ? undefined : Number(values.seed);
      if (seed !== undefined && (!Number.isInteger(seed) || seed < 0)) {
        console.error(`invalid --seed "${values.seed}" (expected a non-negative integer)`);
        return 1;
      }
      // privacy notice (informational, NOT a gate — blocking the primary
      // command on --yes was a usability regression). --yes silences it.
      if (!values.yes) {
        console.error(
          "note: generate sends crawled DOM text" +
            (values.repo ? " + repo notes" : "") +
            " to your LLM provider; in vision mode, screenshots of your app are " +
            "uploaded too. (record/render need no LLM.)",
        );
      }
      let provider;
      try {
        provider = resolveProvider(process.env, { ...(values.model ? { model: values.model } : {}) });
      } catch (err) {
        console.error(
          `${err instanceof Error ? err.message : err}\n` +
            "No key? `supercut record` + `supercut render` work fully without one.",
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
        ...(seed !== undefined ? { seed } : {}),
        // default ALLOW; only --block-private-network engages the SSRF guard
        allowPrivateNetwork: !values["block-private-network"],
        // default OFF; --allow-destructive opts into filming destructive controls
        allowDestructive: !!values["allow-destructive"],
      });
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

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
