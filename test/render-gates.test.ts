import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { renderTake } from "../src/render/index.js";
import { frames, makeLog, noBrowser, takeDirs } from "./helpers/takes.js";

/**
 * Pre-browser gates of renderTake. Each runs before any Chromium work, so a
 * failing test launcher (noBrowser) proves a take got PAST the gates: the
 * render then fails on the launch, not on the gate.
 */
const takes = takeDirs("supercut-gates-");
afterAll(() => takes.cleanup());
afterEach(() => {
  delete process.env.SUPERCUT_ALLOW_PARTIAL;
  vi.restoreAllMocks();
});

const healthy = frames(120, 1000 / 60); // 2s at 60fps

describe("partial takes (failed_scenes)", () => {
  const partial = () =>
    takes.make(
      makeLog([{ t: 0, type: "scene", name: "intro", priority: 1 }], { failed_scenes: ["checkout", "billing"] }),
      healthy,
    );

  it("refuses a take with failed scenes and names them", async () => {
    const takeDir = partial();
    const err = await renderTake({ takeDir, outFile: join(takeDir, "out", "final.mp4"), launchBrowser: noBrowser }).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/partial/);
    expect((err as Error).message).toContain('"checkout", "billing"');
    expect((err as Error).message).toContain("SUPERCUT_ALLOW_PARTIAL=1");
    expect((err as Error).message).not.toMatch(/could not launch Chromium/);
  });

  it("SUPERCUT_ALLOW_PARTIAL=1 renders it anyway, with a loud warning", async () => {
    const takeDir = partial();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.SUPERCUT_ALLOW_PARTIAL = "1";
    await expect(
      renderTake({ takeDir, outFile: join(takeDir, "out", "final.mp4"), launchBrowser: noBrowser }),
    ).rejects.toThrow(/could not launch Chromium/);
    const printed = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(printed).toMatch(/WARNING: .*partial.*"checkout", "billing".*SUPERCUT_ALLOW_PARTIAL=1/s);
  });

  it("an embedding caller can opt in with allowPartial", async () => {
    const takeDir = partial();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      renderTake({ takeDir, outFile: join(takeDir, "out", "final.mp4"), launchBrowser: noBrowser, allowPartial: true }),
    ).rejects.toThrow(/could not launch Chromium/);
  });

  it("an empty failed_scenes list is a complete take", async () => {
    const takeDir = takes.make(makeLog([{ t: 0, type: "scene", name: "intro", priority: 1 }], { failed_scenes: [] }), healthy);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      renderTake({ takeDir, outFile: join(takeDir, "out", "final.mp4"), launchBrowser: noBrowser }),
    ).rejects.toThrow(/could not launch Chromium/);
  });
});
