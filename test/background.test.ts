import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBackgroundSpec } from "../src/render/index.js";

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
