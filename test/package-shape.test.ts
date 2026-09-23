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
