import { describe, expect, it, vi } from "vitest";

/**
 * DNS-failure behavior of the DEFAULT resolvers (no injected isPrivateHost):
 * with --block-private-network engaged, a lookup that fails or NXDOMAINs must
 * DENY, not read as "not private". The old advisory resolver swallowed the
 * error into an allow, and the request gate then cached that allow for the
 * whole run — a rebinding window, because Chromium re-resolves on its own
 * once the hostname starts pointing somewhere private. Lives in its own file
 * because vi.mock of node:dns/promises is module-wide; the main url-policy
 * suite does real lookups.
 */

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname === "nxdomain.example") {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND nxdomain.example"), { code: "ENOTFOUND" });
    }
    if (hostname === "public.example") return [{ address: "93.184.216.34", family: 4 }];
    if (hostname === "private.example") return [{ address: "127.0.0.1", family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  }),
}));

import {
  assertSafeNavigationUrl,
  createRequestGate,
  navigationRequestAllowed,
  urlResolvesPrivate,
} from "../src/security/url-policy.js";

describe("default resolvers under DNS failure (guard engaged = fail closed)", () => {
  it("request gate denies an unresolvable host with its DEFAULT resolver", async () => {
    const gate = createRequestGate({ allowPrivateNetwork: false });
    expect(await gate.allows("http://nxdomain.example/latest/meta-data/")).toBe(false);
  });

  it("request gate still verifies resolvable hosts with its DEFAULT resolver", async () => {
    const gate = createRequestGate({ allowPrivateNetwork: false });
    expect(await gate.allows("http://public.example/app.js")).toBe(true);
    expect(await gate.allows("http://private.example/internal")).toBe(false);
  });

  it("assertSafeNavigationUrl refuses an unverifiable URL while the guard is on", async () => {
    await expect(assertSafeNavigationUrl("http://nxdomain.example/")).rejects.toThrow(/cannot verify|DNS lookup failed/i);
  });

  it("navigationRequestAllowed blocks the same unverifiable URL", async () => {
    expect(await navigationRequestAllowed("http://nxdomain.example/")).toBe(false);
  });

  it("with the guard OFF no lookup happens at all — an unresolvable host is not an error", async () => {
    await expect(
      assertSafeNavigationUrl("http://nxdomain.example/", { allowPrivateNetwork: true }),
    ).resolves.toBeUndefined();
  });

  it("the advisory urlResolvesPrivate stays lenient (hints must never throw or deny)", async () => {
    await expect(urlResolvesPrivate("http://nxdomain.example/")).resolves.toBe(false);
    await expect(urlResolvesPrivate("http://private.example/")).resolves.toBe(true);
  });
});
