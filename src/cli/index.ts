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
            "[--bg <stage>] [--seed <n>] [--model <id>] [--no-vision]",
        );
        return 1;
      }
      const { loadDotEnv, resolveProvider } = await import("../director/config.js");
      const { generate } = await import("../director/generate.js");
      loadDotEnv(); // read .env at repo root (DEEPSEEK_API_KEY etc.)
      if (values.model) process.env.SUPERCUT_MODEL = values.model; // --model overrides .env
      let provider;
      try {
        provider = resolveProvider();
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
        ...(values.bg ? { background: values.bg } : {}),
        ...(values.seed ? { seed: Number(values.seed) } : {}),
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
