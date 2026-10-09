import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { record } from "../src/capture/index.js";
import { parseRecipe } from "../src/schema/index.js";
import { startCaptureApp, type CaptureApp } from "./fixtures/capture-app/server.js";

/**
 * Navigation logging with the private-network guard engaged. As in
 * request-gate.e2e.test.ts, the pre-flight policy seams are mocked and the
 * gate's DNS classifier calls "localhost" public, so a hermetic guard-ON run
 * films the local fixture through the real request gate.
 */

vi.mock("../src/security/url-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/security/url-policy.js")>();
  return {
    ...actual,
    assertSafeNavigationUrl: vi.fn(async () => {}),
    resolveAndPinHost: vi.fn(async () => undefined),
    createRequestGate: vi.fn((opts: { allowPrivateNetwork: boolean }) =>
      actual.createRequestGate({ ...opts, isPrivateHost: async (h) => h !== "localhost" }),
    ),
  };
});

let app: CaptureApp;
const dirs: string[] = [];

beforeAll(async () => {
  app = await startCaptureApp();
}, 30_000);

afterAll(async () => {
  await app.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("navigation logging under the private-network guard", () => {
  it("logs a redirected click navigation once: the gate's stub and its target are one page change", async () => {
    const origin = `http://localhost:${new URL(app.url).port}`;
    const out = mkdtempSync(join(tmpdir(), "supercut-cap-gate-"));
    dirs.push(out);
    const res = await record({
      recipe: parseRecipe({
        version: 0,
        app_url: origin,
        music_track: "institutional-01",
        scenes: [{
          name: "redirected-link", priority: 1,
          entry: { url: `${origin}/spa`, prelude: [] }, depends_on: [],
          actions: [
            { kind: "click", selector: "#server-redirect", duration_ms: 1500 },
            { kind: "wait", duration_ms: 600 },
          ],
          hold_ms: 0,
        }],
      }),
      outDir: out, seed: 1, captureFrames: false, allowPrivateNetwork: false,
    });
    expect(res.failedScenes).toEqual([]);
    // the click really went through the gate's stub to the target
    expect(app.hits.get("/redirect")).toBe(1);
    expect(app.hits.get("/form")).toBe(1);
    const navs = res.eventLog.events.filter((e) => e.type === "navigation");
    expect(navs).toHaveLength(1);
    expect(navs[0]!.kind ?? "document").toBe("document");
  }, 60_000);
});
