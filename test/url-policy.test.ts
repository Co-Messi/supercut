import { describe, expect, it } from "vitest";
import { assertSafeNavigationUrl, resolveAndPinHost, urlResolvesPrivate } from "../src/security/url-policy.js";

describe("navigation URL policy", () => {
  it("blocks cloud metadata addresses by default", async () => {
    await expect(assertSafeNavigationUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private network/i);
  });

  it("blocks localhost by default but allows it explicitly", async () => {
    await expect(assertSafeNavigationUrl("http://127.0.0.1:3000/")).rejects.toThrow(/private network/i);
    await expect(assertSafeNavigationUrl("http://127.0.0.1:3000/", { allowPrivateNetwork: true })).resolves.toBeUndefined();
  });

  it("blocks bracketed IPv6 localhost and ULA literals by default", async () => {
    await expect(assertSafeNavigationUrl("http://[::1]:3000/")).rejects.toThrow(/private network/i);
    await expect(assertSafeNavigationUrl("http://[fd00::1]/")).rejects.toThrow(/private network/i);
  });

  it("rejects alternate IP encodings of loopback when private nets are blocked", async () => {
    // decimal int, hex int, and IPv4-mapped IPv6 all canonicalize to 127.0.0.1
    await expect(assertSafeNavigationUrl("http://2130706433/")).rejects.toThrow(/private network/i);
    await expect(assertSafeNavigationUrl("http://0x7f000001/")).rejects.toThrow(/private network/i);
    await expect(assertSafeNavigationUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(/private network/i);
  });

  it("rejects redirects to private networks", async () => {
    await expect(
      assertSafeNavigationUrl("https://example.com/start", {
        finalUrl: "http://10.0.0.2/admin",
      }),
    ).rejects.toThrow(/redirect/i);
  });
});

describe("resolve-and-pin (DNS-rebinding defense)", () => {
  it("returns undefined for IP-literal hosts — nothing to rebind", async () => {
    await expect(resolveAndPinHost("http://127.0.0.1:3000/", { allowPrivateNetwork: true })).resolves.toBeUndefined();
    await expect(resolveAndPinHost("http://[::1]:3000/", { allowPrivateNetwork: true })).resolves.toBeUndefined();
    // alt-encodings of an IP are still IP literals, not rebindable hostnames
    await expect(resolveAndPinHost("http://2130706433/", { allowPrivateNetwork: true })).resolves.toBeUndefined();
  });

  it("pins a hostname to the exact resolved IP as a Chromium resolver rule", async () => {
    const pinned = await resolveAndPinHost("http://localhost:3000/", { allowPrivateNetwork: true });
    expect(pinned).toBeDefined();
    expect(pinned!.hostname).toBe("localhost");
    expect(["127.0.0.1", "::1"]).toContain(pinned!.ip);
    expect(pinned!.hostResolverRule).toBe(`MAP localhost ${pinned!.ip}`);
  });

  it("rejects hostnames whose addresses are private when the guard is on", async () => {
    await expect(resolveAndPinHost("http://localhost:3000/")).rejects.toThrow(/private network/i);
  });
});

describe("urlResolvesPrivate (advisory hint)", () => {
  it("classifies loopback as private", async () => {
    await expect(urlResolvesPrivate("http://127.0.0.1:3000/")).resolves.toBe(true);
    await expect(urlResolvesPrivate("http://[::1]/")).resolves.toBe(true);
  });

  it("never throws — malformed input is simply not private", async () => {
    await expect(urlResolvesPrivate("not a url")).resolves.toBe(false);
  });
});
