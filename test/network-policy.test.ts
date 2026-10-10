import { describe, expect, it } from "vitest";
import { dryRunFollowUpCommand } from "../src/director/generate.js";
import { resolvePrivateNetworkPolicy } from "../src/security/network-policy.js";

describe("the printed record command keeps an explicit network choice", () => {
  it("carries --allow-private-network or --block-private-network, and nothing for the default", () => {
    expect(dryRunFollowUpCommand("o", { allowPrivateNetwork: true })).toBe("supercut record --recipe o/recipe.json --allow-private-network");
    expect(dryRunFollowUpCommand("o", { blockPrivateNetwork: true })).toBe("supercut record --recipe o/recipe.json --block-private-network");
    expect(dryRunFollowUpCommand("o")).toBe("supercut record --recipe o/recipe.json");
  });
});

/**
 * Default posture: a private or localhost target is the user's own app, so
 * its private subresources (a frontend on :3000 calling an API on :8000) stay
 * allowed. A target that resolves public is somebody's site, so requests from
 * it to private addresses (a router admin, cloud metadata, localhost
 * services) are blocked unless the caller opts in.
 */

const classify = (privateHosts: string[]) => async (url: string) => privateHosts.includes(new URL(url).hostname);

describe("resolvePrivateNetworkPolicy", () => {
  it("allows private requests by default when the target itself is private", async () => {
    const p = await resolvePrivateNetworkPolicy("http://localhost:3000/", undefined, classify(["localhost"]));
    expect(p).toEqual({ allowPrivateNetwork: true, reason: "private-target" });
  });

  it("blocks private requests by default when the target resolves public", async () => {
    const p = await resolvePrivateNetworkPolicy("https://app.example.com/", undefined, classify([]));
    expect(p).toEqual({ allowPrivateNetwork: false, reason: "public-target" });
  });

  it("fails closed when the target cannot be classified", async () => {
    const p = await resolvePrivateNetworkPolicy("https://app.example.com/", undefined, async () => {
      throw new Error("dns down");
    });
    expect(p.allowPrivateNetwork).toBe(false);
  });

  it("an explicit choice wins either way", async () => {
    expect(await resolvePrivateNetworkPolicy("https://app.example.com/", true, classify([]))).toEqual({ allowPrivateNetwork: true, reason: "explicit" });
    expect(await resolvePrivateNetworkPolicy("http://localhost:3000/", false, classify(["localhost"]))).toEqual({ allowPrivateNetwork: false, reason: "explicit" });
  });
});
