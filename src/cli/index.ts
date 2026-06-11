#!/usr/bin/env node
import { parseArgs } from "node:util";
import { doctor } from "./doctor.js";

/**
 * supercut — point it at your app, get the supercut.
 *
 *   supercut generate --url <app> [--repo <path>] [--config <file>]   full pipeline
 *   supercut record   --recipe <file>                                  stage 3 only
 *   supercut render   --video <file> --events <file>                   stage 5 only
 *   supercut doctor                                                    check deps
 */

const HELP = `supercut — institutional-grade 60s launch videos from your real app

Usage:
  supercut generate --url <running app URL> [--repo <path>] [--config <file>]
  supercut record   --recipe <recipe.json>
  supercut render   --video <footage> --events <events.json>
  supercut doctor

Run any command with --help for details.`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "doctor":
      return doctor();
    case "generate":
    case "record":
    case "render": {
      // Parsed now so flags are validated from day one; stages land per build plan.
      parseArgs({
        args: rest,
        options: {
          url: { type: "string" },
          repo: { type: "string" },
          config: { type: "string" },
          recipe: { type: "string" },
          video: { type: "string" },
          events: { type: "string" },
        },
      });
      console.error(`supercut ${command}: not implemented yet (build in progress — see plan)`);
      return 1;
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
