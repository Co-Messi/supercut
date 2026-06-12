#!/usr/bin/env node
import { parseArgs } from "node:util";
import { doctor } from "./doctor.js";

/**
 * supercut — point it at your app, get the supercut.
 *
 *   supercut generate --url <app> [--repo <path>] [--config <file>]   full pipeline
 *   supercut record   --recipe <file> [--out <dir>] [--seed <n>]       stage 3 only
 *   supercut render   --take <dir> [--out <mp4>] [--bg <stage>]        stage 5 only
 *   supercut doctor                                                    check deps
 */

const HELP = `supercut — institutional-grade 60s launch videos from your real app

Usage:
  supercut generate --url <running app URL> [--repo <path>] [--config <file>]
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
      const { values } = parseArgs({
        args: rest,
        options: {
          recipe: { type: "string" },
          out: { type: "string" },
          seed: { type: "string" },
        },
      });
      if (!values.recipe) {
        console.error("usage: supercut record --recipe <recipe.json> [--out <dir>] [--seed <n>]");
        return 1;
      }
      const { readFileSync } = await import("node:fs");
      const { parseRecipe } = await import("../schema/index.js");
      const { record } = await import("../capture/index.js");

      const recipe = parseRecipe(JSON.parse(readFileSync(values.recipe, "utf8")));
      const outDir = values.out ?? "out/take";
      console.log(`recording ${recipe.scenes.length} scene(s) from ${recipe.app_url} → ${outDir}`);
      const t0 = Date.now();
      const res = await record({ recipe, outDir, seed: values.seed ? Number(values.seed) : 1 });
      console.log(
        `done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${res.frameCount} frames, ` +
          `${res.eventLog.events.length} events` +
          (res.failedScenes.length ? `, FAILED scenes: ${res.failedScenes.join(", ")}` : ""),
      );
      return res.aborted ? 1 : 0;
    }
    case "render": {
      const { values } = parseArgs({
        args: rest,
        options: {
          take: { type: "string" },
          out: { type: "string" },
          bg: { type: "string" },
        },
      });
      if (!values.take) {
        console.error(
          "usage: supercut render --take <take dir from record> [--out <file.mp4>] " +
            "[--bg aurora|midnight|dusk|paper|<image path>]",
        );
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
      const { values } = parseArgs({
        args: rest,
        options: {
          url: { type: "string" },
          repo: { type: "string" },
          out: { type: "string" },
          bg: { type: "string" },
          seed: { type: "string" },
          model: { type: "string" },
          "no-vision": { type: "boolean" },
        },
      });
      if (!values.url) {
        console.error(
          "usage: supercut generate --url <running app URL> [--repo <path>] [--out <dir>] " +
            "[--bg <stage>] [--seed <n>] [--model <openrouter id>] [--no-vision]",
        );
        return 1;
      }
      const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.SUPERCUT_API_KEY ?? "";
      if (!apiKey) {
        console.error(
          "generate needs an LLM: set OPENROUTER_API_KEY (one key, many models — https://openrouter.ai/keys).\n" +
            "No key? `supercut record` + `supercut render` work fully without one.",
        );
        return 1;
      }
      const { OpenRouterClient } = await import("../director/llm.js");
      const { generate } = await import("../director/generate.js");
      const res = await generate({
        llm: new OpenRouterClient({ apiKey, ...(values.model ? { model: values.model } : {}) }),
        url: values.url,
        outDir: values.out ?? "out/generate",
        ...(values.repo ? { repoPath: values.repo } : {}),
        ...(values.bg ? { background: values.bg } : {}),
        ...(values.seed ? { seed: Number(values.seed) } : {}),
        ...(values["no-vision"] ? { noVision: true } : {}),
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
