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
 * NOTE: this does NOT defend against DNS-rebinding (a hostname that resolves
 * public at check time and private at connect time — resolve-time TOCTOU).
 * Resolve-and-pin (connect to the exact IP we validated) is out of scope here;
 * the guard validates the host string and the post-redirect final URL only.
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
  if (isIP(h) === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
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

async function resolvesPrivate(hostname: string): Promise<boolean> {
  if (isPrivateHostname(hostname)) return true;
  try {
    const addrs = await lookup(hostname, { all: true, verbatim: true });
    return addrs.some((a) => isPrivateHostname(a.address));
  } catch {
    return false;
  }
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
  if (!opts.allowPrivateNetwork && await resolvesPrivate(url.hostname)) {
    throw new Error(`${redirect ? "redirect target" : "navigation URL"} is on a private network: ${raw}`);
  }
}

export async function assertSafeNavigationUrl(raw: string, opts: NavigationPolicyOptions = {}): Promise<void> {
  await checkOne(raw, opts, false);
  if (opts.finalUrl && opts.finalUrl !== raw) await checkOne(opts.finalUrl, opts, true);
}
