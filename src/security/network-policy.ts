/**
 * Which private-network posture a run takes, decided once from its target.
 *
 *  - explicit `true` (`--allow-private-network`): no guard at all;
 *  - explicit `false` (`--block-private-network`): the strict guard, which
 *    refuses a private target too;
 *  - unset (the default everywhere: CLI, generate(), record(), crawlApp()):
 *    a private or localhost target is the user's own app, so it and its
 *    private subresources are allowed (a frontend on :3000 calling an API on
 *    :8000 keeps working). A target that resolves to a public address gets
 *    the guard, so a page on it cannot reach the user's router, localhost
 *    services or cloud metadata. A target that cannot be classified gets the
 *    guard too.
 */
import { urlResolvesPrivate } from "./url-policy.js";

export interface PrivateNetworkPolicy {
  allowPrivateNetwork: boolean;
  reason: "explicit" | "private-target" | "public-target";
}

export async function resolvePrivateNetworkPolicy(
  targetUrl: string,
  allowPrivateNetwork: boolean | undefined,
  isPrivate: (url: string) => Promise<boolean> = urlResolvesPrivate,
): Promise<PrivateNetworkPolicy> {
  if (allowPrivateNetwork !== undefined) return { allowPrivateNetwork, reason: "explicit" };
  let priv = false;
  try {
    priv = await isPrivate(targetUrl);
  } catch {
    priv = false; // unknown reads as public: the guarded side
  }
  return priv
    ? { allowPrivateNetwork: true, reason: "private-target" }
    : { allowPrivateNetwork: false, reason: "public-target" };
}

/** the one-line explanation a run prints when the default engaged the guard */
export function publicTargetNote(targetUrl: string): string {
  let host = targetUrl;
  try {
    host = new URL(targetUrl).host;
  } catch {
    /* keep the raw string */
  }
  return (
    `network: ${host} resolves to a public address, so requests to private and localhost addresses are ` +
    `blocked (pass --allow-private-network to allow them)`
  );
}
