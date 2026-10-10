#!/usr/bin/env node
/**
 * Assert the published tarball's shape (CI, prepublishOnly, after a build):
 *  - every file is on the allowlist of what the package ships, so anything
 *    else (source, tests, secrets, editor backups, stray notes) fails;
 *  - no path looks like a sync service's conflict copy (`index 2.js`, a
 *    `node 2/` folder: iCloud makes these next to the real file);
 *  - the CLI and library entry points are in it;
 *  - it stays under a size ceiling (the bundled music and backgrounds
 *    dominate, so a jump means something unintended got swept in).
 * `npm pack --dry-run` alone only prints the list; nothing ever read it.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_PACKED_BYTES = 22 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 24 * 1024 * 1024;

/** what the package ships, and nothing else */
const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE$/,
  /^dist\/[A-Za-z0-9._/-]+\.(js|d\.ts|js\.map|d\.ts\.map)$/,
  /^assets\/backgrounds\/[a-z0-9-]+\.png$/,
  /^assets\/music\/([a-z0-9-]+\.mp3|CREDITS\.md)$/,
  /^examples\/demo-app\/[A-Za-z0-9._/-]+\.html$/,
  /^examples\/demo\.recipe\.json$/,
];

/** a path segment ending in " <n>" before its extension: a sync conflict copy */
const DUPLICATE = /(^|\/)[^/]* \d+(\.[^/]*)?(\/|$)/;

const REQUIRED = ["package.json", "dist/cli/index.js", "dist/index.js", "dist/index.d.ts"];

/** every problem with a tarball of these paths and sizes ([] when it is fine) */
export function checkPackFiles(paths, sizes) {
  const problems = [];
  for (const p of paths) {
    if (DUPLICATE.test(p)) problems.push(`${p} looks like a sync-conflict duplicate (a " 2" copy)`);
    else if (!ALLOWED.some((re) => re.test(p))) problems.push(`${p} is not on the allowlist of shipped files`);
  }
  for (const r of REQUIRED) if (!paths.includes(r)) problems.push(`${r} is missing (did the build run?)`);
  if (sizes.size > MAX_PACKED_BYTES) problems.push(`packed size ${sizes.size} B exceeds ${MAX_PACKED_BYTES} B`);
  if (sizes.unpackedSize > MAX_UNPACKED_BYTES) {
    problems.push(`unpacked size ${sizes.unpackedSize} B exceeds ${MAX_UNPACKED_BYTES} B`);
  }
  return problems;
}

function main() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
  const [pack] = JSON.parse(out);
  const paths = pack.files.map((f) => f.path);
  const problems = checkPackFiles(paths, pack);
  if (problems.length > 0) {
    console.error(`npm pack check failed for ${pack.filename}:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    `npm pack check ok: ${pack.filename}, ${paths.length} files, ` +
      `${(pack.size / 1048576).toFixed(1)} MB packed / ${(pack.unpackedSize / 1048576).toFixed(1)} MB unpacked`,
  );
}

// run when executed (npm run check:pack), not when a test imports it
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
