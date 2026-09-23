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
 * Chromium therefore never sees a 3xx and never makes a request of its own
 * that the gate did not approve.
 *
 * Costs, all confined to --block-private-network runs:
 *  - a redirected DOCUMENT renders at its pre-redirect URL (the browser was
 *    handed the final body for the URL it asked for);
 *  - HTTP traffic is made by Playwright's Node client, so Chromium's
 *    `--host-resolver-rules` pin does not apply to it, and responses are
 *    buffered in memory rather than streamed.
 */
import type { APIResponse, BrowserContext, Request, Route } from "playwright";
import type { RequestGate } from "./url-policy.js";

/** longer chains than this are treated as a loop and fail the request */
export const MAX_REDIRECT_HOPS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

      let res: APIResponse = await route.fetch({ maxRedirects: 0 });
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
      }
      await route.fulfill({ response: res });
    } catch {
      await route.abort("failed").catch(() => {});
    }
  });

  return state;
}
