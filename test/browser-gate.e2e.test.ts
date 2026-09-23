import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installRequestGate, settleGatedRedirect } from "../src/security/browser-gate.js";
import { createRequestGate } from "../src/security/url-policy.js";

/**
 * installRequestGate on its own, against a real Chromium, with the DNS
 * classifier injected: "localhost" plays the vetted public app and 127.0.0.1
 * the private network. These pin down what a redirected DOCUMENT looks like
 * to the page under the guard — the request-gate e2e file covers the SSRF
 * side through record()/crawlApp().
 */

let browser: Browser;
let app: { origin: string; log: string[]; close: () => Promise<void> };
let priv: { origin: string; hits: string[]; close: () => Promise<void> };
/** how many times /flip has been served: 200 the first time, then 302 → private */
let flips = 0;

function listen(srv: Server, host: string): Promise<number> {
  return new Promise((r) => srv.listen(0, host, () => r((srv.address() as { port: number }).port)));
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });

  const hits: string[] = [];
  const p = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("internal");
  });
  const pport = await listen(p, "127.0.0.1");
  priv = { origin: `http://127.0.0.1:${pport}`, hits, close: () => new Promise((r) => p.close(() => r())) };

  const log: string[] = [];
  const a = createServer((req, res) => {
    log.push(`${req.method} ${req.url} cookie=${req.headers.cookie ?? ""}`);
    if (req.url === "/login") {
      res.writeHead(302, { location: "/app/", "set-cookie": "sid=abc; Path=/" });
      return res.end();
    }
    if (req.url === "/app/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(
        `<!doctype html><html><body><div id="path"></div><div id="asset">missing</div>` +
          `<script>document.getElementById("path").textContent = location.pathname</script>` +
          `<script src="main.js"></script></body></html>`,
      );
    }
    if (req.url === "/app/main.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(`document.getElementById("asset").textContent = "loaded"`);
    }
    if (req.url === "/to-flip") {
      res.writeHead(302, { location: "/flip" });
      return res.end();
    }
    if (req.url === "/flip") {
      flips++;
      if (flips === 1) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<!doctype html><p id="flip">first answer</p>`);
      }
      // every later request for the same URL now bounces to the private host
      res.writeHead(302, { location: `${priv.origin}/rebound` });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  const aport = await listen(a, "localhost");
  app = { origin: `http://localhost:${aport}`, log, close: () => new Promise((r) => a.close(() => r())) };
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await priv?.close();
});

async function guardedPage() {
  const page = await browser.newPage({ serviceWorkers: "block" });
  const gate = createRequestGate({ allowPrivateNetwork: false, isPrivateHost: async (h) => h !== "localhost" });
  await installRequestGate(page.context(), gate);
  return page;
}

describe("installRequestGate: redirected documents", () => {
  it("a redirected navigation lands on the redirect target, so relative URLs and location resolve there", async () => {
    const page = await guardedPage();
    try {
      app.log.length = 0;
      const res = await page.goto(`${app.origin}/login`, { waitUntil: "domcontentloaded" });
      await settleGatedRedirect(page, res, { timeout: 10_000, waitUntil: "load" });

      expect(page.url()).toBe(`${app.origin}/app/`);
      expect(await page.textContent("#path")).toBe("/app/");
      // main.js is relative: it must resolve against /app/, not /login
      await page.waitForFunction(() => document.getElementById("asset")?.textContent === "loaded", null, {
        timeout: 5_000,
      });
      // the cookie set on the intermediate 302 reached the jar and the next hop
      expect((await page.context().cookies()).map((c) => `${c.name}=${c.value}`)).toContain("sid=abc");
      // the redirect target was requested exactly once: the browser's
      // follow-up navigation is served from what the gate already fetched
      expect(app.log.filter((l) => l.startsWith("GET /app/ "))).toEqual(["GET /app/ cookie=sid=abc"]);
    } finally {
      await page.close();
    }
  }, 30_000);

  it("the follow-up navigation is never re-fetched: a target that turns hostile on its second request never reaches the private host", async () => {
    const page = await guardedPage();
    try {
      flips = 0;
      const res = await page.goto(`${app.origin}/to-flip`, { waitUntil: "domcontentloaded" });
      await settleGatedRedirect(page, res, { timeout: 10_000, waitUntil: "load" });

      expect(page.url()).toBe(`${app.origin}/flip`);
      expect(await page.textContent("#flip")).toBe("first answer");
      expect(flips).toBe(1);
      expect(priv.hits).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
