import { describe, expect, it } from "vitest";
import {
  assertSafeNavigationUrl,
  createRequestGate,
  gateWebSockets,
  hostResolverRule,
  navigationRequestAllowed,
  resolveAndPinHost,
  urlResolvesPrivate,
} from "../src/security/url-policy.js";

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

  it("blocks the unspecified IPv6 address (::), a mapped-IPv6 metadata address, and link-local metadata", async () => {
    // :: is the unspecified address (binds accept loopback), the mapped form
    // folds to the dotted IPv4, and 169.254.169.254 is the cloud-metadata host
    await expect(assertSafeNavigationUrl("http://[::]/")).rejects.toThrow(/private network/i);
    await expect(assertSafeNavigationUrl("http://[::ffff:169.254.169.254]/")).rejects.toThrow(/private network/i);
    await expect(assertSafeNavigationUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private network/i);
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
    expect(pinned!.hostResolverRule).toBe(hostResolverRule("localhost", pinned!.ip));
  });

  it("rejects hostnames whose addresses are private when the guard is on", async () => {
    await expect(resolveAndPinHost("http://localhost:3000/")).rejects.toThrow(/private network/i);
  });

  it("formats resolver rules: bare IPv4, bracketed IPv6 (Chromium rejects bare ::1)", () => {
    expect(hostResolverRule("example.com", "93.184.216.34")).toBe("MAP example.com 93.184.216.34");
    expect(hostResolverRule("example.com", "::1")).toBe("MAP example.com [::1]");
    expect(hostResolverRule("example.com", "2606:2800:220:1:248:1893:25c8:1946")).toBe(
      "MAP example.com [2606:2800:220:1:248:1893:25c8:1946]",
    );
  });
});

describe("navigationRequestAllowed (in-flight route gate)", () => {
  it("blocks private/metadata/alt-encoded targets before the request leaves the browser", async () => {
    expect(await navigationRequestAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(await navigationRequestAllowed("http://127.0.0.1:3000/")).toBe(false);
    expect(await navigationRequestAllowed("http://[::1]/")).toBe(false);
    expect(await navigationRequestAllowed("http://0x7f000001/")).toBe(false);
  });

  it("allows private targets when the guard is explicitly off", async () => {
    expect(await navigationRequestAllowed("http://127.0.0.1:3000/", { allowPrivateNetwork: true })).toBe(true);
  });

  it("never throws — malformed and non-http URLs are simply blocked", async () => {
    expect(await navigationRequestAllowed("not a url")).toBe(false);
    expect(await navigationRequestAllowed("file:///etc/passwd", { allowPrivateNetwork: true })).toBe(false);
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

describe("request gate — every request type, not just navigations (H4)", () => {
  it("blocks a subresource request to a private host while the guard is on", async () => {
    const gate = createRequestGate({ allowPrivateNetwork: false });
    // the SSRF classic: a crawled page fetch()es cloud metadata / loopback
    expect(await gate.allows("http://169.254.169.254/latest/meta-data/iam/")).toBe(false);
    expect(await gate.allows("http://127.0.0.1:8080/internal.js")).toBe(false);
    expect(await gate.allows("http://[::1]/img.png")).toBe(false);
    expect(await gate.allows("http://0x7f000001/x")).toBe(false);
  });

  it("allows everything when the guard is off, resolving nothing", async () => {
    let resolves = 0;
    const gate = createRequestGate({
      allowPrivateNetwork: true,
      isPrivateHost: async () => { resolves++; return true; },
    });
    expect(await gate.allows("http://127.0.0.1:3000/app.js")).toBe(true);
    expect(resolves).toBe(0);
  });

  it("fails closed on non-http(s) and malformed URLs while the guard is on", async () => {
    const gate = createRequestGate({ allowPrivateNetwork: false });
    expect(await gate.allows("file:///etc/passwd")).toBe(false);
    expect(await gate.allows("not a url")).toBe(false);
  });

  it("caches the DNS verdict per host so subresources don't become a DNS storm", async () => {
    const lookups: string[] = [];
    const gate = createRequestGate({
      allowPrivateNetwork: false,
      isPrivateHost: async (h) => { lookups.push(h); return h === "internal.corp"; },
    });
    expect(await gate.allows("http://internal.corp/a.png")).toBe(false);
    expect(await gate.allows("http://internal.corp/b.png")).toBe(false);
    expect(await gate.allows("http://internal.corp/api/steal")).toBe(false);
    expect(await gate.allows("https://cdn.example/lib.js")).toBe(true);
    expect(await gate.allows("https://cdn.example/style.css")).toBe(true);
    expect(lookups).toEqual(["internal.corp", "cdn.example"]);
  });

  it("fails closed when the resolver itself throws", async () => {
    const gate = createRequestGate({
      allowPrivateNetwork: false,
      isPrivateHost: async () => { throw new Error("resolver down"); },
    });
    expect(await gate.allows("http://flaky.example/x.js")).toBe(false);
  });
});

describe("WebSocket gate — upgrades bypass route interception", () => {
  /** minimal fake of Playwright's routeWebSocket surface: capture the handler,
   *  then feed it fake WebSocketRoute objects and observe connect vs close */
  function fakeWsTarget() {
    let handler: ((ws: {
      url(): string;
      connectToServer(): unknown;
      close(o?: { code?: number; reason?: string }): Promise<void>;
    }) => unknown) | undefined;
    const target = {
      routeWebSocket: async (_url: RegExp, h: typeof handler) => { handler = h; },
    };
    const drive = async (url: string) => {
      const calls: { connected: boolean; closed?: { code?: number; reason?: string } } = { connected: false };
      await handler!({
        url: () => url,
        connectToServer: () => { calls.connected = true; return {}; },
        close: async (o?: { code?: number; reason?: string }) => { calls.closed = o ?? {}; },
      });
      return calls;
    };
    return { target, drive };
  }

  it("blocks ws:// to a private host (never connected, closed with 1008) and passes a public one through", async () => {
    const asked: string[] = [];
    const gate = createRequestGate({
      allowPrivateNetwork: false,
      isPrivateHost: async (h) => { asked.push(h); return h === "127.0.0.1"; },
    });
    const { target, drive } = fakeWsTarget();
    expect(await gateWebSockets(target, gate)).toBe(true);

    const blocked = await drive("ws://127.0.0.1:8080/socket");
    expect(blocked.connected).toBe(false);
    expect(blocked.closed?.code).toBe(1008);

    const allowed = await drive("wss://api.example/live");
    expect(allowed.connected).toBe(true);
    expect(allowed.closed).toBeUndefined();
    // the ws/wss scheme was mapped to http(s) before the gate saw it: the gate
    // rejects non-http(s) outright, so reaching isPrivateHost proves the map
    expect(asked).toEqual(["127.0.0.1", "api.example"]);
  });

  it("shares the gate's per-host DNS cache with plain requests", async () => {
    const lookups: string[] = [];
    const gate = createRequestGate({
      allowPrivateNetwork: false,
      isPrivateHost: async (h) => { lookups.push(h); return false; },
    });
    const { target, drive } = fakeWsTarget();
    await gateWebSockets(target, gate);
    await gate.allows("https://api.example/prefetch.js");
    const ws = await drive("wss://api.example/live");
    expect(ws.connected).toBe(true);
    expect(lookups).toEqual(["api.example"]); // one lookup covered both
  });

  it("reports (not throws) when routeWebSocket is unavailable, so callers can warn", async () => {
    const gate = createRequestGate({ allowPrivateNetwork: false });
    expect(await gateWebSockets({}, gate)).toBe(false);
  });
});
