/**
 * Console output built from model or page strings. A string that reaches the
 * terminal raw can carry control sequences: ESC sequences that erase or
 * rewrite lines (so a forged, harmless-looking action list hides the real
 * one), OSC sequences some terminals act on (clipboard writes), carriage
 * returns and line separators that start fake lines, and bidi overrides that
 * reorder what a reader sees. The action preview is the human gate, so such
 * characters are shown as visible `\uXXXX` escapes instead.
 */

/** C0 controls, DEL and C1 controls, line and paragraph separators, and the
 *  bidi marks, embeddings, overrides and isolates */
const UNSAFE: readonly [number, number][] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function unsafe(cp: number): boolean {
  return UNSAFE.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** the string with every unsafe character written as a visible escape */
export function terminalSafe(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += unsafe(cp) ? `\\u${cp.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

/** a model or page string as a quoted, escaped literal for a console line */
export function quoteForTerminal(s: string): string {
  return terminalSafe(JSON.stringify(s));
}
