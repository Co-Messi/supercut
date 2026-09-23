/**
 * Browser-side enforcement of the private-network policy (guard ON only).
 *
 * Why every request is fetched from Node instead of `route.continue()`d:
 * Playwright's Chromium backend auto-continues a REDIRECTED request without
 * ever handing it to a `route()` handler, so a handler that vets a URL and
 * then continues it only ever sees the first hop of a chain — a public URL
 * answering `302 Location: http://169.254.169.254/` sails through. Here the
 * handler performs the request itself with `maxRedirects: 0`, checks every
 * `Location` against the gate BEFORE requesting it, follows the chain
 * manually (bounded), and fulfils the browser with the final response.
 * Chromium therefore never sees a 3xx, so it never follows a hop on its own.
 *
 * Redirected navigations: fulfilling the final body under the URL the browser
 * asked for would leave the document at the pre-redirect URL, so relative
 * assets, `location` and client-side routers would all resolve against the
 * wrong path (`/login` → 302 `/app/` then loads `/main.js`, not
 * `/app/main.js`). Handing Chromium the validated 3xx is not safe either: it
 * follows that hop natively, without calling route(), and the target can
 * answer the second request with a 302 to a private host. Instead, a
 * redirected GET navigation is fulfilled with a tiny stub that
 * `location.replace()`s to the final URL. That is a fresh navigation, which
 * does reach this handler, and it is served from the response the gate
 * already fetched (one-shot, short-lived), so the target is requested once
 * and never re-asked. The stub carries GATED_REDIRECT_HEADER so callers that
 * awaited the navigation can wait for the real document (settleGatedRedirect).
 *
 * Costs, all confined to --block-private-network runs:
 *  - a 307/308 chain that ends in a POST still renders at the pre-redirect
 *    URL (a client-side hop cannot replay a POST);
 *  - HTTP traffic is made by Playwright's Node client, so Chromium's
 *    `--host-resolver-rules` pin does not apply to it, and responses are
 *    buffered in memory rather than streamed (a response that never
 *    completes fails when Playwright's fetch timeout, 30s, runs out).
 */
import type { APIResponse, BrowserContext, Page, Request, Response, Route } from "playwright";
import type { RequestGate } from "./url-policy.js";

/** longer chains than this are treated as a loop and fail the request */
export const MAX_REDIRECT_HOPS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** set on the stub a redirected navigation is first fulfilled with; its
 *  value is the URL the stub replaces itself with */
export const GATED_REDIRECT_HEADER = "x-supercut-gated-redirect";
/** how long a redirect target's already-fetched response waits for the
 *  stub's follow-up navigation before it is dropped (a later request for the
 *  same URL is then simply fetched again, through the gate) */
const PENDING_TTL_MS = 10_000;

function withoutFragment(u: string): string {
  const url = new URL(u);
  url.hash = "";
  return url.href;
}

/** the stub document: replace this entry with the final URL, nothing else.
 *  `<` is escaped so the URL can never close the script element. */
function redirectStub(target: string): string {
  const literal = JSON.stringify(target).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `<!doctype html><meta charset="utf-8"><script>location.replace(${literal})</script>`;
}

export interface GatedContext {
  /** main-frame navigations the policy refused (the first hop or any
   *  redirect hop), in order — the browser is left on an error page, which
   *  the caller must not mistake for the product */
  blockedNavigations: string[];
}

export interface InstallGateOptions {
  /** extra veto for requests the policy allows (e.g. the crawler refusing
   *  download navigations); a vetoed request is aborted, not recorded */
  veto?: (request: Request) => boolean;
}

function isMainFrameNavigation(request: Request): boolean {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame().parentFrame() === null;
  } catch {
    return false; // service-worker requests have no frame
  }
}

/** Headers for a manually followed hop: never forward what the transport or
 *  the cookie jar owns, drop credentials when the hop changes origin, and
 *  drop body headers when the redirect turned the request into a GET. */
function hopHeaders(
  original: Record<string, string>,
  from: string,
  to: string,
  hasBody: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  const crossOrigin = new URL(from).origin !== new URL(to).origin;
  for (const [k, v] of Object.entries(original)) {
    const name = k.toLowerCase();
    if (name === "host" || name === "content-length" || name === "cookie") continue;
    if (crossOrigin && (name === "authorization" || name === "proxy-authorization")) continue;
    if (!hasBody && name === "content-type") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Install the gate as the context's catch-all route. Every path settles the
 * route exactly once: a throw anywhere aborts the request (fail closed).
 */
export async function installRequestGate(
  ctx: BrowserContext,
  gate: RequestGate,
  opts: InstallGateOptions = {},
): Promise<GatedContext> {
  const state: GatedContext = { blockedNavigations: [] };
  /** redirect targets already fetched for a stub, keyed by fragmentless URL */
  const pending = new Map<string, { res: APIResponse; expires: number }>();
  const prune = (now: number): void => {
    for (const [k, v] of pending) {
      if (v.expires <= now) {
        pending.delete(k);
      }
    }
  };

  await ctx.route("**/*", async (route: Route) => {
    const request = route.request();
    const block = async (url: string): Promise<void> => {
      if (isMainFrameNavigation(request)) state.blockedNavigations.push(url);
      await route.abort("blockedbyclient").catch(() => {});
    };
    try {
      let url = request.url();
      if (!(await gate.allows(url))) return await block(url);
      if (opts.veto?.(request)) return await route.abort().catch(() => {});

      // a stub's follow-up: serve what the gate already fetched for it
      prune(Date.now());
      if (request.isNavigationRequest() && request.method() === "GET") {
        const key = withoutFragment(url);
        const hit = pending.get(key);
        if (hit) {
          pending.delete(key);
          await route.fulfill({ response: hit.res });
          return;
        }
      }

      let res: APIResponse = await route.fetch({ maxRedirects: 0 });
      let redirected = false;
      let method = request.method();
      let body = request.postDataBuffer();
      for (let hop = 0; REDIRECT_STATUSES.has(res.status()); hop++) {
        const location = res.headers()["location"];
        if (!location) break; // a 3xx without a target is delivered as-is
        const next = new URL(location, url).href;
        if (!(await gate.allows(next))) return await block(next);
        if (hop >= MAX_REDIRECT_HOPS) return await route.abort("failed").catch(() => {});
        // browser method rewriting: 303 → GET (HEAD stays HEAD); 301/302
        // turn a POST into a GET; 307/308 keep method and body
        const status = res.status();
        if ((status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) {
          method = "GET";
          body = null;
        }
        res = await ctx.request.fetch(next, {
          method,
          headers: hopHeaders(request.headers(), url, next, body !== null),
          ...(body !== null ? { data: body } : {}),
          maxRedirects: 0,
        });
        url = next;
        redirected = true;
      }
      if (
        redirected &&
        request.isNavigationRequest() &&
        method === "GET" &&
        !REDIRECT_STATUSES.has(res.status()) &&
        withoutFragment(url) !== withoutFragment(request.url())
      ) {
        pending.set(withoutFragment(url), { res, expires: Date.now() + PENDING_TTL_MS });
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            [GATED_REDIRECT_HEADER]: url,
          },
          body: redirectStub(url),
        });
        return;
      }
      await route.fulfill({ response: res });
    } catch {
      await route.abort("failed").catch(() => {});
    }
  });

  return state;
}


/**
 * After awaiting a navigation made under the gate: if the response is the
 * stub of a gated redirect, wait until the frame has replaced it with the
 * real document. Returns null in that case (the stub is not the document —
 * callers fall back to page.url()); otherwise returns the response unchanged.
 */
export async function settleGatedRedirect(
  page: Page,
  response: Response | null,
  opts: { timeout: number; waitUntil: "load" | "domcontentloaded" },
): Promise<Response | null> {
  if (!response?.headers()[GATED_REDIRECT_HEADER]) return response;
  const stub = response.url();
  await page.waitForURL((u) => withoutFragment(u.href) !== withoutFragment(stub), opts);
  return null;
}
