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

function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
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
