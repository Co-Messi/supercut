import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, Route } from "playwright";
import { installRequestGate } from "../src/security/browser-gate.js";
import { createRequestGate } from "../src/security/url-policy.js";

/**
 * Playwright keeps every APIResponse body in the driver until dispose() or
 * context close. Under the guard EVERY request of a run is fetched that way,
 * so the gate must release each body once it has been delivered (or skipped
 * over as a redirect hop) — otherwise a whole take's traffic stays resident.
 */

function fakeResponse(status: number, headers: Record<string, string> = {}) {
  return { status: () => status, headers: () => headers, dispose: vi.fn(async () => {}) };
}

async function driveOne(chain: ReturnType<typeof fakeResponse>[], navigation = false) {
  let handler!: (route: Route) => Promise<void>;
  const [first, ...rest] = chain;
  const ctx = {
    route: async (_p: string, h: (route: Route) => Promise<void>) => {
      handler = h;
    },
    request: { fetch: vi.fn(async () => rest.shift()) },
  } as unknown as BrowserContext;
  const gate = createRequestGate({ allowPrivateNetwork: false, isPrivateHost: async () => false });
  await installRequestGate(ctx, gate);
  const route = {
    request: () => ({
      url: () => "http://app.test/a",
      method: () => "GET",
      isNavigationRequest: () => navigation,
      frame: () => ({ parentFrame: () => null }),
      headers: () => ({}),
      postDataBuffer: () => null,
    }),
    fetch: vi.fn(async () => first),
    fulfill: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  await handler(route as unknown as Route);
  return route;
}

describe("installRequestGate releases fetched bodies", () => {
  it("disposes a delivered response", async () => {
    const ok = fakeResponse(200);
    const route = await driveOne([ok]);
    expect(route.fulfill).toHaveBeenCalledWith({ response: ok });
    expect(ok.dispose).toHaveBeenCalled();
  });

  it("disposes every redirect hop and the final response", async () => {
    const hop1 = fakeResponse(302, { location: "/b" });
    const hop2 = fakeResponse(301, { location: "/c" });
    const ok = fakeResponse(200);
    const route = await driveOne([hop1, hop2, ok]);
    expect(route.fulfill).toHaveBeenCalledWith({ response: ok });
    for (const r of [hop1, hop2, ok]) expect(r.dispose).toHaveBeenCalled();
  });
});
