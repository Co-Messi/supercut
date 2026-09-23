import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { record } from "../src/capture/index.js";
import { crawlApp } from "../src/director/inventory.js";
import { createRequestGate, resolveAndPinHost } from "../src/security/url-policy.js";
import { parseRecipe, type Recipe } from "../src/schema/index.js";
import { startDemoApp, type DemoApp } from "./fixtures/demo-app/server.js";

/**
 * WIRING coverage for the H4/H5 request gate, through record() itself — not
 * createRequestGate as a pure function (test/url-policy.test.ts owns that),
 * and not assertRecipeNavigationPolicy (which fires first and rejects any
 * private recipe URL long before the gate exists, so no unmocked localhost
 * run can ever reach the gate).
 *
 * Why the host classifier is injected: a hermetic guard-ON run needs an entry
 * host the policy calls public that still lands on the local fixture. Real
 * DNS cannot deliver that — and the reviewer-suggested route (a fake hostname
 * pinned to loopback via --host-resolver-rules) is not portable either:
 * on a machine whose resolver hijacks unknown names (VPN/TUN fake-IP DNS,
 * e.g. Clash's 198.18/15) the pin is bypassed entirely and the navigation
 * never reaches loopback (verified here: even `MAP example.com 127.0.0.1`
 * never produced a TCP connection to a local server). So this file mocks the
 * pre-flight assert/pin seams and swaps ONLY the gate's DNS classifier:
 * "localhost" plays the vetted public app; 127.0.0.1 (the probe server) is
 * private. Everything downstream is real — record()'s launch, its route
 * handler install, route.abort(), the WebSocket gate, the verdict cache —
 * which is exactly the wiring the unit tests could not see.
 */

vi.mock("../src/security/url-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/security/url-policy.js")>();
  return {
    ...actual, // gateWebSockets et al stay REAL
    assertSafeNavigationUrl: vi.fn(async () => {}),
    resolveAndPinHost: vi.fn(async () => undefined),
    createRequestGate: vi.fn((opts: { allowPrivateNetwork: boolean }) =>
      actual.createRequestGate({
        ...opts,
        isPrivateHost: async (h) => h !== "localhost",
      }),
    ),
  };
});

let app: DemoApp;
/** the "internal service" the probe page attacks: records every plain request
 *  and every WebSocket upgrade that actually LEAVES the browser */
let probe: { port: number; requests: string[]; upgrades: string[]; close: () => Promise<void> };
const dirs: string[] = [];

beforeAll(async () => {
  app = await startDemoApp();
  const requests: string[] = [];
  const upgrades: string[] = [];
  const srv: Server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hit");
  });
  srv.on("upgrade", (req, socket) => {
    upgrades.push(req.url ?? "");
    socket.destroy(); // the attempt is what we count; no handshake needed
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  probe = { port, requests, upgrades, close: () => new Promise((r) => srv.close(() => r())) };
}, 30_000);

afterAll(async () => {
  await app.close();
  await probe.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function probeRecipe(entryOrigin: string): Recipe {
  const fetchTarget = `http://127.0.0.1:${probe.port}/hit`;
  const wsTarget = `ws://127.0.0.1:${probe.port}/ws`;
  const entry =
    `${entryOrigin}/probe?fetch=${encodeURIComponent(fetchTarget)}&ws=${encodeURIComponent(wsTarget)}`;
  return parseRecipe({
    version: 0,
    app_url: entryOrigin,
    music_track: "institutional-01",
    scenes: [
      {
        name: "probe",
        priority: 1,
        entry: { url: entry, prelude: [] },
        depends_on: [],
        // the page needs only time: its inline script fires the fetch and the
        // WebSocket at the "internal" probe server on load
        actions: [{ kind: "wait", duration_ms: 2600 }],
        hold_ms: 0,
      },
    ],
  });
}

describe("request gate wiring through record() (H4/H5)", () => {
  it("guard ON: the entry loads, but the page's fetch() and WebSocket to a private host never leave the browser", async () => {
    vi.clearAllMocks();
    const appPort = new URL(app.url).port;
    const out = mkdtempSync(join(tmpdir(), "supercut-gate-on-"));
    dirs.push(out);

    const res = await record({
      recipe: probeRecipe(`http://localhost:${appPort}`),
      outDir: out,
      seed: 1,
      captureFrames: false,
      allowPrivateNetwork: false,
    });

    // the entry navigated and the scene ran to completion — the gate allowed
    // the vetted app host through (a gate that blocked everything would have
    // aborted the entry itself and failed the scene)
    expect(res.aborted).toBe(false);
    expect(res.failedScenes).toEqual([]);

    // the in-flight attacks were stopped BEFORE the wire: zero requests, zero
    // upgrade attempts observed by the private server. The positive control
    // below proves the same page genuinely fires both.
    expect(probe.requests).toEqual([]);
    expect(probe.upgrades).toEqual([]);

    // and the guard-on plumbing ran: the gate was constructed with the guard
    // engaged, and the pin loop visited the entry host before launch
    expect(vi.mocked(createRequestGate)).toHaveBeenCalledWith(
      expect.objectContaining({ allowPrivateNetwork: false }),
    );
    expect(vi.mocked(resolveAndPinHost)).toHaveBeenCalledWith(
      expect.stringContaining(`http://localhost:${appPort}/probe`),
      expect.objectContaining({ allowPrivateNetwork: false }),
    );
  }, 60_000);

  it("guard OFF: no gate is even installed, and the same page's probes reach the server — the blocked run measured a real gate, not a broken page", async () => {
    vi.clearAllMocks();
    const out = mkdtempSync(join(tmpdir(), "supercut-gate-off-"));
    dirs.push(out);

    const res = await record({
      recipe: probeRecipe(app.url),
      outDir: out,
      seed: 1,
      captureFrames: false,
      allowPrivateNetwork: true,
    });

    expect(res.aborted).toBe(false);
    expect(probe.requests.some((u) => u.startsWith("/hit"))).toBe(true);
    expect(probe.upgrades.some((u) => u.startsWith("/ws"))).toBe(true);

    // the default local path pays no interception tax: neither the gate nor
    // the pinning path is touched when the guard is off
    expect(vi.mocked(createRequestGate)).not.toHaveBeenCalled();
    expect(vi.mocked(resolveAndPinHost)).not.toHaveBeenCalled();
  }, 60_000);
});

/**
 * Redirect hops (H-new-1). Playwright's Chromium backend auto-continues every
 * redirected request WITHOUT calling route() handlers, so a gate that only
 * vets the first URL of a chain lets `public → 302 → private` through. Each
 * case below starts on the vetted "public" app host (localhost) and 302s,
 * via the fixture's open /redirect, to the "private" probe server
 * (127.0.0.1). The assertion is on the probe server itself: the private hop
 * must never arrive. Guard-off controls prove the same chains DO arrive when
 * nothing gates them, so a pass means a real gate, not a broken fixture.
 */
describe("request gate vs redirect hops (H-new-1)", () => {
  const appOrigin = () => `http://localhost:${new URL(app.url).port}`;
  const privateUrl = (path: string) => `http://127.0.0.1:${probe.port}${path}`;
  const viaRedirect = (to: string) => `/redirect?to=${encodeURIComponent(to)}`;
  const hit = (path: string) => probe.requests.filter((u) => u.startsWith(path));

  /** the probe page, fetching a redirect-to-private and linking to another */
  function probeWithRedirects(origin: string, tag: string): string {
    const qs = new URLSearchParams({
      fetch: viaRedirect(privateUrl(`/sub-${tag}`)),
      link: viaRedirect(privateUrl(`/nav-${tag}`)),
    });
    return `${origin}/probe?${qs}`;
  }

  function redirectRecipe(origin: string, tag: string): Recipe {
    return parseRecipe({
      version: 0,
      app_url: origin,
      music_track: "institutional-01",
      scenes: [
        {
          name: "hop",
          priority: 1,
          entry: { url: probeWithRedirects(origin, tag), prelude: [] },
          depends_on: [],
          actions: [
            { kind: "wait", duration_ms: 1200 },
            { kind: "click", selector: "#hop", duration_ms: 1200 },
            { kind: "wait", duration_ms: 1200 },
          ],
          hold_ms: 0,
        },
      ],
    });
  }

  it("record, guard ON: a subresource redirect and a clicked-link redirect to a private host never reach it", async () => {
    vi.clearAllMocks();
    const out = mkdtempSync(join(tmpdir(), "supercut-gate-redir-on-"));
    dirs.push(out);

    const res = await record({
      recipe: redirectRecipe(appOrigin(), "rec-on"),
      outDir: out,
      seed: 1,
      captureFrames: false,
      allowPrivateNetwork: false,
    });

    expect(hit("/sub-rec-on")).toEqual([]);
    expect(hit("/nav-rec-on")).toEqual([]);
    // the blocked click navigation fails the scene rather than filming an
    // error page as if it were the product
    expect(res.failedScenes).toEqual(["hop"]);
  }, 60_000);

  it("record, guard OFF (control): the same chains do reach the private host", async () => {
    vi.clearAllMocks();
    const out = mkdtempSync(join(tmpdir(), "supercut-gate-redir-off-"));
    dirs.push(out);

    await record({
      recipe: redirectRecipe(app.url, "rec-off"),
      outDir: out,
      seed: 1,
      captureFrames: false,
      allowPrivateNetwork: true,
    });

    expect(hit("/sub-rec-off").length).toBeGreaterThan(0);
    expect(hit("/nav-rec-off").length).toBeGreaterThan(0);
  }, 60_000);

  it("crawl, guard ON: neither the page's redirected fetch nor the crawled redirect link reaches the private host", async () => {
    vi.clearAllMocks();
    const digests = await crawlApp(probeWithRedirects(appOrigin(), "crawl-on"), {
      maxPages: 3,
      screenshots: false,
      allowPrivateNetwork: false,
    });

    // the start page itself was crawled (the gate let the vetted host through)
    expect(digests.length).toBeGreaterThan(0);
    // the crawler did discover the redirect link — so the navigation below
    // was genuinely attempted, not skipped
    expect(digests[0]!.inventory.some((i) => i.href?.includes("/redirect?to="))).toBe(true);
    expect(hit("/sub-crawl-on")).toEqual([]);
    expect(hit("/nav-crawl-on")).toEqual([]);
  }, 60_000);

  it("crawl, guard OFF (control): the same chains do reach the private host", async () => {
    vi.clearAllMocks();
    await crawlApp(probeWithRedirects(app.url, "crawl-off"), {
      maxPages: 3,
      screenshots: false,
      allowPrivateNetwork: true,
    });

    expect(hit("/sub-crawl-off").length).toBeGreaterThan(0);
    expect(hit("/nav-crawl-off").length).toBeGreaterThan(0);
  }, 60_000);
});
