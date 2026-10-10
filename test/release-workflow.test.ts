import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The release path: a v* tag publishes to npm through trusted publishing
 * (OIDC, no long-lived token), which also attaches provenance, and only after
 * the full CI suite has passed on that exact commit.
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const release = read(".github/workflows/release.yml");
const ci = read(".github/workflows/ci.yml");

describe("CI matrix", () => {
  it("covers the engines floor and the current LTS (Node 24)", () => {
    const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(">=20");
    expect(ci).toMatch(/node-version: \[20, 22, 24\]/);
  });
});

describe("release workflow", () => {
  it("publishes with trusted publishing, not a stored npm token", () => {
    expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
    expect(release).toMatch(/id-token: write/);
    // npm's docs: trusted publishing needs npm CLI 11.5.1+ and Node 22.14.0+
    const npm = /npm@(\d+)\.(\d+)\.(\d+) publish/.exec(release);
    expect(npm, "the publish step pins an npm version").not.toBeNull();
    const [maj, min, patch] = npm!.slice(1).map(Number) as [number, number, number];
    expect(maj * 1e6 + min * 1e3 + patch).toBeGreaterThanOrEqual(11 * 1e6 + 5 * 1e3 + 1);
    expect(release).toMatch(/node-version: 24/);
  });

  it("publishes only after the whole CI suite passed on the tagged commit", () => {
    expect(ci).toMatch(/^\s+workflow_call:/m);
    expect(release).toMatch(/uses: \.\/\.github\/workflows\/ci\.yml/);
    expect(release).toMatch(/needs: \[check, ci\]/);
  });

  it("still skips a version that is already on npm instead of failing", () => {
    expect(release).toMatch(/npm view/);
    expect(release).toMatch(/needs\.check\.outputs\.published != 'true'/);
  });
});
