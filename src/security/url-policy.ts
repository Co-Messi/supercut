import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface NavigationPolicyOptions {
  allowPrivateNetwork?: boolean;
  /** optional final URL after following redirects; checked with stricter redirect error */
  finalUrl?: string;
}

function ipToLong(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const n = ipToLong(ip);
  const b = ipToLong(base);
  if (n === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (b & mask);
}

/**
 * Canonicalize alternate IP encodings to dotted-decimal IPv4 so the private-host
 * check can't be bypassed by writing the loopback/metadata address a different
 * way. Covers: bare decimal int (`2130706433`), hex (`0x7f000001`), and
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1` / `::ffff:7f00:1`). WHATWG `new URL()`
 * already folds the decimal/hex forms before we ever see them, but normalizing
 * here makes the guard self-contained and covers the mapped-IPv6 case the URL
 * parser leaves intact. Returns the original host when it isn't an alt-encoding.
 *
 * DNS-rebinding (a hostname that resolves public at check time and private at
 * connect time — resolve-time TOCTOU): when the guard is ON, `resolveAndPinHost`
 * below resolves once, validates the addresses, and yields a Chromium
 * `--host-resolver-rules` mapping so the browser connects to the exact IP that
 * was vetted. Both the director's crawler and the capture executor apply it
 * to their browser launches (the executor pins every recipe host); both also
 * install a `createRequestGate` route handler so in-flight requests to
 * unpinned hosts are policy-checked before they leave the browser, and a
 * `gateWebSockets` handler for the WebSocket upgrades that route interception
 * cannot see.
 */
function normalizeHostToIPv4(h: string): string {
  // whole-host bare decimal integer, e.g. "2130706433" → "127.0.0.1"
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
    }
    return h;
  }
  // whole-host hex integer, e.g. "0x7f000001" → "127.0.0.1"
  if (/^0x[0-9a-f]+$/i.test(h)) {
    const n = Number(h);
    if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
    }
    return h;
  }
  // IPv4-mapped IPv6: "::ffff:127.0.0.1" (dotted tail) or "::ffff:7f00:1" (hex
  // tail). Brackets are already stripped by the caller.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (mappedDotted && isIP(mappedDotted[1]!) === 4) return mappedDotted[1]!;
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
  }
  return h;
}

function isPrivateHostname(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  // normalize numeric/hex/mapped-IPv6 encodings to canonical IPv4 BEFORE the
  // private check, so alt-encodings of loopback/metadata can't slip through.
  h = normalizeHostToIPv4(h);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0") return true;
  // "::" is the unspecified address (equivalent to 0.0.0.0) — routers/servers
  // bound to it accept loopback traffic, so treat it as private too.
  if (isIP(h) === 6) return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
  if (isIP(h) === 4) {
    return (
      inCidr(h, "10.0.0.0", 8) ||
      inCidr(h, "127.0.0.0", 8) ||
      inCidr(h, "169.254.0.0", 16) ||
      inCidr(h, "172.16.0.0", 12) ||
      inCidr(h, "192.168.0.0", 16)
    );
  }
  return false;
}

/** ADVISORY-path resolver: swallows lookup failures ("couldn't tell" reads as
 *  "not private"). Fine for hints; never use it to enforce the policy. */
async function resolvesPrivate(hostname: string): Promise<boolean> {
  if (isPrivateHostname(hostname)) return true;
  try {
    return await resolvesPrivateStrict(hostname);
  } catch {
    return false;
  }
}

/** ENFORCEMENT-path resolver: a failed or empty lookup PROPAGATES so the
 *  caller fails closed. Swallowing it here was the rebinding window: an
 *  NXDOMAIN at check time read as "not private", the gate allowed (and
 *  cached) the host, and Chromium's own later resolution could then connect
 *  to a private address the policy never saw. On machines where a proxy/TUN
 *  does the real resolving, the request gate is the load-bearing SSRF
 *  defense (the --host-resolver-rules pin is bypassed inside the tunnel), so
 *  "can't verify" must mean "deny", not "shrug". */
async function resolvesPrivateStrict(hostname: string): Promise<boolean> {
  if (isPrivateHostname(hostname)) return true;
  const addrs = await lookup(hostname, { all: true, verbatim: true });
  return addrs.some((a) => isPrivateHostname(a.address));
}

async function checkOne(raw: string, opts: NavigationPolicyOptions, redirect: boolean): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid navigation URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`navigation URL must be http(s): ${raw}`);
  }
  if (!opts.allowPrivateNetwork) {
    let priv: boolean;
    try {
      priv = await resolvesPrivateStrict(url.hostname);
    } catch (err) {
      // fail CLOSED while the guard is engaged: an unresolvable host cannot be
      // verified against the policy, and allowing it hands the decision to
      // whatever the browser's resolver returns later.
      throw new Error(
        `cannot verify ${raw} against the private-network policy (DNS lookup failed: ` +
          `${err instanceof Error ? err.message : err}) — refusing while the guard is engaged`,
      );
    }
    if (priv) {
      throw new Error(`${redirect ? "redirect target" : "navigation URL"} is on a private network: ${raw}`);
    }
  }
}

export async function assertSafeNavigationUrl(raw: string, opts: NavigationPolicyOptions = {}): Promise<void> {
  await checkOne(raw, opts, false);
  if (opts.finalUrl && opts.finalUrl !== raw) await checkOne(opts.finalUrl, opts, true);
}

/**
 * Route-decision for an IN-FLIGHT browser navigation request (Playwright route
 * handler): may this request leave the browser? Runs the full policy — scheme,
 * string/IP-literal private checks (synchronous), then DNS resolution — and
 * never throws, because a route handler must always settle the request.
 * Post-settle URL checks only run AFTER Chromium fetched a redirect target;
 * this gate runs BEFORE.
 */
export async function navigationRequestAllowed(
  raw: string,
  opts: NavigationPolicyOptions = {},
): Promise<boolean> {
  try {
    await assertSafeNavigationUrl(raw, opts);
    return true;
  } catch {
    return false;
  }
}

/** Does this URL's host name/resolve to a private address? Never throws —
 *  used for advisory hints, not enforcement. */
export async function urlResolvesPrivate(raw: string): Promise<boolean> {
  try {
    return await resolvesPrivate(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/**
 * Per-run request gate for a Playwright route handler: decides whether ANY
 * in-flight browser request — navigation, fetch/XHR, <img>, <script>, <link>,
 * form POST — may leave the browser under the private-network policy. The
 * navigation-only check this replaces left every subresource free to reach
 * private hosts while the CLI reported the guard as engaged. (WebSocket
 * upgrades never reach a route handler — gateWebSockets below covers those
 * with the same gate.)
 *
 * DNS verdicts are cached per host for the lifetime of the gate, so enforcing
 * on every subresource doesn't become a per-request DNS storm. Fail-closed:
 * an unparseable URL, a throwing check, or a FAILED LOOKUP blocks the request
 * while the guard is engaged — and a verdict born of a failed lookup is never
 * cached (see below). With the guard off it allows everything and resolves
 * nothing.
 */
export interface RequestGate {
  allows(url: string): Promise<boolean>;
}

export function createRequestGate(opts: {
  allowPrivateNetwork: boolean;
  /** injectable for tests; defaults to the module's STRICT DNS-backed private
   *  check (lookup failures propagate → the gate denies) */
  isPrivateHost?: (hostname: string) => Promise<boolean>;
}): RequestGate {
  // (review) enforcement uses the STRICT resolver: the advisory one swallowed
  // lookup errors into "not private", so a transient failure or NXDOMAIN
  // during a rebinding attempt produced an ALLOW — which the cache then held
  // for the rest of the run while Chromium re-resolved on its own.
  const isPrivate = opts.isPrivateHost ?? resolvesPrivateStrict;
  const verdicts = new Map<string, Promise<boolean>>();
  return {
    async allows(raw: string): Promise<boolean> {
      if (opts.allowPrivateNetwork) return true;
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      const host = url.hostname;
      let verdict = verdicts.get(host);
      if (!verdict) {
        verdict = isPrivate(host).then(
          (p) => !p,
          () => {
            // deny THIS request, but do not cache a verdict derived from a
            // failed lookup: the host was never actually validated. A later
            // request re-resolves — if the name then points somewhere private
            // the fresh lookup catches it; caching the failure would instead
            // freeze whatever the outage happened to look like.
            verdicts.delete(host);
            return false;
          },
        );
        verdicts.set(host, verdict);
      }
      return verdict;
    },
  };
}

/** structural slice of Playwright's WebSocketRoute — keeps this module free
 *  of a hard playwright type dependency */
interface WebSocketRouteLike {
  url(): string;
  connectToServer(): unknown;
  close(options?: { code?: number; reason?: string }): Promise<void>;
}

/**
 * Gate WebSocket connections under the same policy as createRequestGate.
 * `ctx.route("**\/*")` cannot intercept WebSocket upgrades — Playwright's
 * routeWebSocket (shipped in 1.48) can, so without this a page could open a
 * socket to a private host with the guard nominally engaged. Allowed sockets
 * are connected straight through (`connectToServer()` with no message
 * handlers installed = Playwright forwards frames both ways untouched);
 * blocked sockets are never connected and close with 1008 (policy violation).
 *
 * Feature-detected rather than assumed: the declared peer floor is ^1.53.0
 * so routeWebSocket is always there in practice, but a caller running an
 * unexpected build must WARN that WebSockets are ungated, not crash. Returns
 * true when the gate was installed.
 */
export async function gateWebSockets(
  target: {
    routeWebSocket?: (
      url: RegExp,
      handler: (ws: WebSocketRouteLike) => unknown,
    ) => Promise<void>;
  },
  gate: RequestGate,
): Promise<boolean> {
  if (typeof target.routeWebSocket !== "function") return false;
  await target.routeWebSocket(/.*/, async (ws) => {
    // the gate speaks http(s): map the ws scheme before asking it, so the
    // same host verdict (and per-host DNS cache) covers both request kinds
    const httpUrl = ws.url().replace(/^ws(s?):/i, (_m, s) => (s ? "https:" : "http:"));
    if (await gate.allows(httpUrl)) {
      ws.connectToServer();
    } else {
      await ws.close({ code: 1008, reason: "blocked by private-network policy" });
    }
  });
  return true;
}

export interface PinnedHost {
  hostname: string;
  /** the exact address that passed validation */
  ip: string;
  /** value for Chromium's `--host-resolver-rules=` launch arg */
  hostResolverRule: string;
}

/**
 * Resolve-and-pin (DNS-rebinding defense): resolve the target hostname ONCE,
 * validate every returned address against the private-network policy, and
 * return a Chromium host-resolver rule that pins the hostname to the first
 * vetted IP — so the browser connects to the address we checked, not whatever
 * a second resolve returns. Returns undefined for IP-literal hosts (nothing
 * to rebind).
 */
export async function resolveAndPinHost(
  raw: string,
  opts: NavigationPolicyOptions = {},
): Promise<PinnedHost | undefined> {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  if (isIP(hostname) !== 0 || isIP(normalizeHostToIPv4(hostname)) !== 0) return undefined;
  // "," separates rules in --host-resolver-rules; a comma can survive URL
  // parsing inside a hostname, so refuse rather than emit a second rule.
  if (hostname.includes(",")) throw new Error(`unsupported character in hostname: ${hostname}`);
  const addrs = await lookup(hostname, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error(`cannot resolve host: ${hostname}`);
  if (!opts.allowPrivateNetwork) {
    const bad = addrs.find((a) => isPrivateHostname(a.address));
    if (bad) {
      throw new Error(`navigation URL is on a private network: ${raw} (${hostname} → ${bad.address})`);
    }
  }
  const ip = addrs[0]!.address;
  return { hostname, ip, hostResolverRule: hostResolverRule(hostname, ip) };
}

/** Chromium `--host-resolver-rules` MAP entry. IPv6 replacement addresses
 *  must be bracketed — `MAP host ::1` is malformed and silently ignored. */
export function hostResolverRule(hostname: string, ip: string): string {
  return `MAP ${hostname} ${isIP(ip) === 6 ? `[${ip}]` : ip}`;
}
