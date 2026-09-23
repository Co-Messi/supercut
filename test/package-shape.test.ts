import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The package is a CLI AND a library: `import "@co-messi/supercut"` must
 * resolve to a built entry with types, not only deep dist/ paths.
 */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
};

describe("library entry point", () => {
  it("package.json points main, types and exports at the built src/index.ts", () => {
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(pkg.exports?.["."]).toEqual({ types: "./dist/index.d.ts", import: "./dist/index.js" });
    expect(pkg.exports?.["./package.json"]).toBe("./package.json");
    expect(existsSync(new URL("../src/index.ts", import.meta.url))).toBe(true);
  });

  it("exposes the pipeline stages", async () => {
    const lib = await import("../src/index.js");
    for (const name of ["generate", "record", "renderTake", "parseRecipe", "parseEventLog", "resolveProvider"]) {
      expect(typeof (lib as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});

describe("publish guard", () => {
  // npm always packs README* whatever `files` says, so a stray README.md.bak
  // (or any other backup/secret swept into dist/) ships unless the pack is
  // checked at publish time — CI's check runs on a clean checkout, not on the
  // laptop that actually runs `npm publish`
  it("prepublishOnly builds, then asserts the tarball's contents", () => {
    const pre = pkg.scripts?.prepublishOnly ?? "";
    expect(pre).toMatch(/npm run build/);
    expect(pre).toMatch(/check:pack/);
    expect(pre.indexOf("check:pack")).toBeGreaterThan(pre.indexOf("npm run build"));
  });
});
