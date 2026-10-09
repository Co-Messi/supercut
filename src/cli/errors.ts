import { ZodError } from "zod";

/**
 * Human-readable CLI errors. Users see one short message and the command's
 * usage line, never a raw Node or Zod stack.
 */

/** Thrown for a mistake in how the command was invoked or in a file it was
 *  pointed at; main() prints the message plus the command's usage. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly usage?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

const MAX_ISSUES = 8;

/** "scenes.0.actions.1.selector: Required" lines for a Zod error, capped */
export function formatZodError(err: ZodError): string {
  const lines = err.issues.slice(0, MAX_ISSUES).map((i) => {
    const where = i.path.length ? i.path.join(".") : "(root)";
    return `  ${where}: ${i.message}`;
  });
  const more = err.issues.length - lines.length;
  if (more > 0) lines.push(`  ...and ${more} more`);
  return lines.join("\n");
}

/** Turn node's parseArgs failure into a plain sentence. */
export function describeArgsError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const unknown = /Unknown option '([^']+)'/.exec(raw);
  if (unknown) return `unknown option ${unknown[1]}`;
  const missing = /Option '([^']+?)(?: <value>)?' argument missing/.exec(raw);
  if (missing) return `option ${missing[1]} needs a value`;
  const ambiguous = /Option '([^']+)' argument is ambiguous/.exec(raw);
  if (ambiguous) return `the value after ${ambiguous[1]} looks like a flag (write ${ambiguous[1]}=<value> to pass it anyway)`;
  const unexpected =/Unexpected argument '([^']+)'/.exec(raw);
  if (unexpected) return `unexpected argument ${unexpected[1]}`;
  // first sentence only: node appends "To specify a positional..." advice
  return raw.split(/\.\s/)[0]!.replace(/\.$/, "");
}

/** Message for any error escaping a command. */
export function describeError(err: unknown): string {
  if (err instanceof ZodError) return `invalid input:\n${formatZodError(err)}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Parse a recipe file's text into JSON with a readable failure. */
export function parseJsonFile(text: string, path: string, usage?: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, usage);
  }
}

/** A browser navigation failure (`net::ERR_...`) from the recorder, reduced to
 *  its first line with a hint. Other errors are returned unchanged. */
export function describeRecordError(err: unknown): CliError | unknown {
  const msg = err instanceof Error ? err.message : "";
  const net = /net::ERR_[A-Z_]+/.exec(msg);
  if (!net) return err;
  const first = msg.split("\n")[0]!;
  return new CliError(
    `${first}\nCheck that the app is running at the recipe's app_url and that the port is not used by something else.`,
  );
}

const URL_HINT = [
  "Check that the app URL is right and reachable, and that the port is not used by something else",
  "(a different app on the same port records the wrong pages).",
];
const SELECTOR_HINT = [
  "Check the selector: it must match an element that is visible when the action runs",
  "(a control revealed by another action needs that action first, in the same scene).",
];
/** an entry page answering with an HTTP error, or no connection at all */
const URL_FAILURE = /entry page .* returned \d{3}|net::ERR_|ECONNREFUSED/;
/** a locator that never matched a visible element in time */
const SELECTOR_FAILURE = /locator\.|waiting for locator|strict mode violation/;

/** What `record` prints and returns once the take is on disk: every failed
 *  scene with the first line of its reason, then the hint those reasons call
 *  for (the URL and port for an unreachable or wrong app, the selector for a
 *  control that never showed up). */
export function recordOutcome(res: {
  failedScenes: string[];
  aborted: boolean;
  sceneErrors?: Record<string, string>;
}): { code: number; lines: string[] } {
  if (res.failedScenes.length === 0 && !res.aborted) return { code: 0, lines: [] };
  const lines = [
    `supercut: ${res.failedScenes.length} scene(s) failed: ${res.failedScenes.join(", ") || "(none named)"}` +
      (res.aborted ? " (recording aborted early)" : ""),
  ];
  const reasons = res.failedScenes.map((name) => res.sceneErrors?.[name]).filter((r): r is string => !!r);
  for (const name of res.failedScenes) {
    const reason = res.sceneErrors?.[name]?.split("\n")[0]?.trim();
    if (reason) lines.push(`  ${name}: ${reason.length > 300 ? `${reason.slice(0, 300)}...` : reason}`);
  }
  lines.push("The take was still written, but it is partial footage.");
  // without reasons (an older caller) the URL and port are the likeliest cause
  if (reasons.length === 0 || reasons.some((r) => URL_FAILURE.test(r))) lines.push(...URL_HINT);
  if (reasons.some((r) => SELECTOR_FAILURE.test(r))) lines.push(...SELECTOR_HINT);
  return { code: 1, lines };
}
