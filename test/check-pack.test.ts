import { describe, expect, it } from "vitest";
import { checkPackFiles } from "../tools/check-pack.mjs";

/**
 * The tarball check is an allowlist: only files the package is meant to ship
 * pass. A sync service's conflict copy (`index 2.js`, a `node 2/` folder),
 * an editor backup or anything else unexpected fails the publish.
 */

const GOOD = [
  "package.json", "README.md", "LICENSE",
  "dist/index.js", "dist/index.d.ts", "dist/cli/index.js", "dist/cli/index.js.map",
  "assets/backgrounds/cobalt.png", "assets/music/pulse.mp3", "assets/music/CREDITS.md",
  "examples/demo-app/index.html", "examples/demo-app/dash/index.html", "examples/demo.recipe.json",
];
const sizes = { size: 1_000_000, unpackedSize: 2_000_000 };
const check = (paths: string[]): string[] => checkPackFiles(paths, sizes);

describe("check-pack", () => {
  it("passes the files the package ships", () => {
    expect(check(GOOD)).toEqual([]);
  });

  it.each([
    "dist/cli/index 2.js",
    "dist/node 2/index.js",
    "assets/music/pulse 2.mp3",
    "README 2.md",
  ])("rejects the sync-conflict duplicate %s", (p) => {
    expect(check([...GOOD, p]).join("\n")).toMatch(/duplicate/);
  });

  it.each(["README.md.bak", "src/index.ts", ".env", "dist/secrets.txt", "notes.md", "examples/pulse-demo.recipe.json"])(
    "rejects %s, which is not on the allowlist",
    (p) => {
      expect(check([...GOOD, p]).length).toBeGreaterThan(0);
    },
  );

  it("still requires the entry points and enforces the size ceiling", () => {
    expect(check(GOOD.filter((p) => p !== "dist/cli/index.js")).join("\n")).toMatch(/dist\/cli\/index\.js is missing/);
    expect(checkPackFiles(GOOD, { size: 99 * 1024 * 1024, unpackedSize: 1 }).join("\n")).toMatch(/packed size/);
  });
});
