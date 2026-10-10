import { describe, expect, it } from "vitest";
import { recordOutcome } from "../src/cli/errors.js";
import { formatRecipePreview } from "../src/director/generate.js";
import { parseRecipe } from "../src/schema/index.js";
import { terminalSafe } from "../src/security/terminal.js";

/**
 * The action preview is the human gate: a model-written string (typed text,
 * a scene name, a selector) that carries terminal control sequences could
 * erase or overwrite preview lines, forge benign-looking ones, or write the
 * clipboard through an OSC sequence. Every console line built from model or
 * page strings shows those characters as visible escapes instead.
 */

const c = (...cps: number[]) => String.fromCodePoint(...cps);
// ESC [2K (erase line), CR, a forged line, LF, CSI (C1), RLO (bidi), LS, BEL
const NASTY = `ok${c(0x1b)}[2K${c(0x0d)}  . click #benign${c(0x0a)}${c(0x9b)}31m${c(0x202e)}evil${c(0x2028)}x${c(0x07)}`;

/** a code point a terminal or a bidi renderer acts on */
function isRawControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
}
const hasRawControl = (s: string) => [...s].some((ch) => isRawControl(ch.codePointAt(0)!));

describe("terminalSafe", () => {
  it("escapes C0 and C1 controls, line separators and bidi overrides, and keeps ordinary text", () => {
    const out = terminalSafe(NASTY);
    expect(hasRawControl(out)).toBe(false);
    expect(out).toContain("\\u001b[2K");
    expect(out).toContain("\\u202e");
    const fine = `Caf${c(0xe9)} ${c(0x1f469, 0x200d, 0x1f4bb)} fine`;
    expect(terminalSafe(fine)).toBe(fine);
  });
});

describe("console lines built from model or page strings", () => {
  it("formatRecipePreview shows no raw control character from any field", () => {
    const recipe = parseRecipe({
      version: 0, app_url: "http://127.0.0.1:9999", music_track: "off",
      scenes: [
        { name: NASTY, priority: 1, entry: { url: "http://127.0.0.1:9999/", prelude: [] }, depends_on: [],
          actions: [
            { kind: "type", selector: `#q${NASTY}`, text: NASTY, submit: true, focus_selector: `#r${NASTY}`, duration_ms: 1500 },
          ],
          hold_ms: 400 },
      ],
    });
    const lines = formatRecipePreview(recipe);
    for (const l of lines) expect(hasRawControl(l)).toBe(false);
    // one line for the scene, one for the action, one for the hold: no forged lines
    expect(lines).toHaveLength(3);
  });

  it("record's failure summary escapes scene names and reasons", () => {
    const { lines } = recordOutcome({ failedScenes: [NASTY], aborted: false, sceneErrors: { [NASTY]: `boom ${NASTY}` } });
    for (const l of lines) expect(hasRawControl(l)).toBe(false);
  });
});
