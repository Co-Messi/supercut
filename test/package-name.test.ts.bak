import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The npm name is a supply-chain boundary: `npx <name>` runs whatever the
 * registry owner of <name> published, in the user's app directory, next to
 * the `.env` holding their LLM keys. The unscoped `supercut` belongs to an
 * unrelated publisher, so the package ships under a scope this project owns,
 * and every documented `npx` invocation must use exactly that name.
 */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  bin: Record<string, string>;
  publishConfig?: { access?: string };
};
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("package name ownership (C1)", () => {
  it("publishes under the owned scope, publicly, with the bin still named supercut", () => {
    expect(pkg.name).toBe("@co-messi/supercut");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(Object.keys(pkg.bin)).toEqual(["supercut"]);
  });

  it("every README npx invocation of supercut uses the owned package name", () => {
    const npxTargets = [...readme.matchAll(/npx\s+(\S+)/g)].map((m) => m[1]!);
    const ours = npxTargets.filter((t) => t.includes("supercut"));
    expect(ours.length).toBeGreaterThan(0);
    for (const t of ours) expect(t).toBe(pkg.name);
  });
});
