/**
 * May a page requested at `requested` be filmed when it settled at
 * `settled`? Yes for the same origin, for an http to https upgrade of the
 * same host and port, and for the apex and `www.` forms of one host. Not for
 * anything else: another host (an identity provider's sign-in page, most
 * often), another port (another app), or an https to http downgrade.
 */
export function isSameSite(requested: string, settled: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(requested);
    b = new URL(settled);
  } catch {
    return false;
  }
  if (a.origin === b.origin) return true;
  const upgrade = a.protocol === "http:" && b.protocol === "https:";
  if (a.protocol !== b.protocol && !upgrade) return false;
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
  if (bare(a.hostname) !== bare(b.hostname)) return false;
  // default ports read as "" in URL; an upgrade moves 80 to 443
  return a.port === b.port || (upgrade && a.port === "" && b.port === "");
}
