import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { generate } from "../src/director/generate.js";
import type { ChatOptions, LlmClient } from "../src/director/llm.js";
import { assertBackground, resolveBackgroundSpec } from "../src/render/index.js";

describe("--bg is validated before any spend", () => {
  it("assertBackground accepts wallpapers, palettes and nothing, and names the choices for a typo", () => {
    expect(() => assertBackground(undefined)).not.toThrow();
    expect(() => assertBackground("sunrise")).not.toThrow();
    expect(() => assertBackground("aurora")).not.toThrow();
    expect(() => assertBackground("cobaltt")).toThrow(/unknown background.*cobaltt/);
  });

  it("generate rejects an unknown --bg before any LLM call or network probe", async () => {
    let calls = 0;
    const llm: LlmClient = {
      label: "count",
      async chat(_o: ChatOptions) {
        calls++;
        return "{}";
      },
    };
    const out = mkdtempSync(join(tmpdir(), "supercut-bg-"));
    try {
      // port 9 is closed: a run that got past the bg check would fail on the probe instead
      await expect(generate({ llm, url: "http://127.0.0.1:9/", outDir: out, background: "cobaltt", log: () => {} })).rejects.toThrow(
        /unknown background/,
      );
      expect(calls).toBe(0);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("resolveBackgroundSpec", () => {
  it("default (no --bg) resolves to the bundled cobalt wallpaper", () => {
    const r = resolveBackgroundSpec(undefined);
    expect(r.isImage).toBe(true);
    expect(r.spec.endsWith(["backgrounds", "cobalt.png"].join(sep))).toBe(true);
  });

  it("named wallpaper fuzzy-matches: any case, with or without extension", () => {
    expect(resolveBackgroundSpec("SUNRISE").spec.endsWith(`${sep}sunrise.png`)).toBe(true);
    expect(resolveBackgroundSpec("lavender.png").isImage).toBe(true);
  });

  it("procedural palette names pass through as non-image specs", () => {
    expect(resolveBackgroundSpec("aurora")).toEqual({ spec: "aurora", isImage: false });
    expect(resolveBackgroundSpec("midnight")).toEqual({ spec: "midnight", isImage: false });
  });

  it("missing bundled assets: the DEFAULT falls back to the aurora palette, never crashes", () => {
    expect(resolveBackgroundSpec(undefined, ["/nonexistent-supercut-assets"])).toEqual({
      spec: "aurora",
      isImage: false,
    });
  });

  it("an explicit unknown name passes through untouched (fails loud downstream)", () => {
    expect(resolveBackgroundSpec("not-a-real-stage", ["/nonexistent-supercut-assets"])).toEqual({
      spec: "not-a-real-stage",
      isImage: false,
    });
  });
});
