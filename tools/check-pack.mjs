#!/usr/bin/env node
/**
 * Assert the published tarball's shape (CI, after `npm run build`):
 *  - the CLI entry is in it;
 *  - no source, tests, spikes, tooling, secrets or editor backups are;
 *  - it stays under a size ceiling (the bundled music/backgrounds dominate,
 *    so a jump means something unintended got swept in).
 * `npm pack --dry-run` alone only prints the list; nothing ever read it.
 */
import { execFileSync } from "node:child_process";

const MAX_PACKED_BYTES = 22 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 24 * 1024 * 1024;
const FORBIDDEN = [
  [/^src\//, "TypeScript source"],
  [/^test\//, "tests"],
  [/^spikes\//, "spikes"],
  [/^tools\//, "build tooling"],
  [/^\.github\//, "CI config"],
  [/(^|\/)\.env(\.|$)/, "an env file"],
  [/\.bak$/, "an editor backup"],
  [/(^|\/)node_modules\//, "node_modules"],
];
const REQUIRED = ["package.json", "dist/cli/index.js", "dist/index.js", "dist/index.d.ts"];

const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const [pack] = JSON.parse(out);
const paths = pack.files.map((f) => f.path);
const problems = [];

for (const p of paths) {
  for (const [re, what] of FORBIDDEN) if (re.test(p)) problems.push(`${p} is ${what}`);
}
for (const r of REQUIRED) if (!paths.includes(r)) problems.push(`${r} is missing (did the build run?)`);
if (pack.size > MAX_PACKED_BYTES) problems.push(`packed size ${pack.size} B exceeds ${MAX_PACKED_BYTES} B`);
if (pack.unpackedSize > MAX_UNPACKED_BYTES) {
  problems.push(`unpacked size ${pack.unpackedSize} B exceeds ${MAX_UNPACKED_BYTES} B`);
}

if (problems.length > 0) {
  console.error(`npm pack check failed for ${pack.filename}:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `npm pack check ok: ${pack.filename}, ${paths.length} files, ` +
    `${(pack.size / 1048576).toFixed(1)} MB packed / ${(pack.unpackedSize / 1048576).toFixed(1)} MB unpacked`,
);
