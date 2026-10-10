/**
 * Signed-in sessions: `--storage-state <file>` hands Playwright a saved
 * storage state (cookies and per-origin localStorage) so the crawl and the
 * capture see the app as a signed-in user. The file holds live credentials,
 * so only its path is ever passed on: its contents never reach a prompt, the
 * take directory, director-report.json, or a log line, including the error
 * messages below.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Check that `path` is a readable Playwright storage state file and return
 *  its absolute path. Errors name the file and the problem, never its text. */
export function assertStorageStateFile(path: string): string {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "that is a directory" : String(code ?? "unreadable");
    throw new Error(`--storage-state ${path}: ${why}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON.parse quotes the offending text in its message: never surface it
    throw new Error(`--storage-state ${path} is not valid JSON (expected a Playwright storage state file)`);
  }
  const state = parsed as { cookies?: unknown; origins?: unknown } | null;
  if (!state || typeof state !== "object" || !Array.isArray(state.cookies) || (state.origins !== undefined && !Array.isArray(state.origins))) {
    throw new Error(
      `--storage-state ${path} is not a Playwright storage state file (expected an object with a "cookies" array ` +
        `and an optional "origins" array; save one with \`npx playwright codegen --save-storage=${path} <app url>\`)`,
    );
  }
  return abs;
}
