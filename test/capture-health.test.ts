import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assessCaptureHealth, renderTake } from "../src/render/index.js";
import type { EventLog } from "../src/schema/index.js";

/**
 * H1: the deterministic capture-health gate. A capture that starved (repaint
 * beacon dead, page never committing frames) produces a clean event timeline
 * over almost no footage; rendering it yields a slideshow that used to ship
 * with a green run. The gate must refuse it — and must NOT fire on healthy or
 * merely-throttled captures, because a gate that fires on everything is as
 * broken as one that fires on nothing.
 */

const viewport = { width: 1920, height: 1080, dpr: 2 };

function makeLog(events: EventLog["events"], extra: Partial<EventLog> = {}): EventLog {
  return { version: 0, t_source_unified: true, viewport, fps: 60, events, ...extra };
}

function frames(count: number, spacingMs: number): { file: string; t_source: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    file: `frames/${String(i).padStart(6, "0")}.png`,
    t_source: Math.round(i * spacingMs),
  }));
}

describe("assessCaptureHealth", () => {
  it("refuses a starved take: 3 frames over 40 seconds", () => {
    const log = makeLog([
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 40_000, type: "click", bbox: [10, 10, 50, 20], selector: "#x", point: [20, 20] },
    ]);
    const health = assessCaptureHealth(log, frames(3, 100));
    expect(health.action).toBe("fail");
    expect(health.reason).toMatch(/sparse/i);
    expect(health.avgSourceFps).toBeLessThan(1);
  });

  it("passes a healthy 60fps take", () => {
    const idx = frames(600, 1000 / 60); // 10s at 60fps
    const log = makeLog([{ t: 9_800, type: "scene", name: "s1", priority: 1 }]);
    const health = assessCaptureHealth(log, idx);
    expect(health.action).toBe("ok");
    expect(health.avgSourceFps).toBeGreaterThan(55);
  });

  it("tolerates a throttled-but-real capture (slow CI disk, ~30fps)", () => {
    const idx = frames(300, 1000 / 30); // 10s at 30fps against a declared 60
    const log = makeLog([{ t: 9_800, type: "scene", name: "s1", priority: 1 }]);
    expect(assessCaptureHealth(log, idx).action).toBe("ok");
  });

  it("catches a single-frame take with a long event timeline (spanMs=0 was the old blind spot)", () => {
    const log = makeLog([
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 30_000, type: "click", bbox: [10, 10, 50, 20], selector: "#x", point: [20, 20] },
    ]);
    const health = assessCaptureHealth(log, frames(1, 0));
    expect(health.action).toBe("fail");
    expect(health.expectedFrames).toBe(1800);
  });

  it("does not judge takes too short to have a meaningful frame budget", () => {
    const log = makeLog([{ t: 900, type: "scene", name: "s1", priority: 1 }]);
    expect(assessCaptureHealth(log, frames(4, 200)).action).toBe("ok");
  });

  it("respects a lower declared fps — a 30fps third-party recorder at 30fps is healthy", () => {
    const idx = frames(300, 1000 / 30);
    const log = makeLog([{ t: 9_800, type: "scene", name: "s1", priority: 1 }], { fps: 30 });
    expect(assessCaptureHealth(log, idx).action).toBe("ok");
  });
});

describe("renderTake capture-health gate", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function writeTake(log: EventLog, index: { file: string; t_source: number }[]): string {
    const dir = mkdtempSync(join(tmpdir(), "supercut-health-"));
    dirs.push(dir);
    mkdirSync(join(dir, "frames"), { recursive: true });
    writeFileSync(join(dir, "events.json"), JSON.stringify(log));
    writeFileSync(join(dir, "frames-index.json"), JSON.stringify(index));
    return dir;
  }

  it("refuses to render a starved take (throws before any browser/encode work)", async () => {
    const takeDir = writeTake(
      makeLog([
        { t: 0, type: "scene", name: "s1", priority: 1 },
        { t: 40_000, type: "click", bbox: [10, 10, 50, 20], selector: "#x", point: [20, 20] },
      ]),
      frames(3, 100),
    );
    await expect(
      renderTake({ takeDir, outFile: join(takeDir, "final.mp4") }),
    ).rejects.toThrow(/sparse/i);
  });

  it("a legacy sparse take (no clock declaration) is refused the same way — rendering one requires the explicit SUPERCUT_ALLOW_SPARSE opt-in", async () => {
    const takeDir = writeTake(
      makeLog(
        [
          { t: 0, type: "scene", name: "s1", priority: 1 },
          { t: 40_000, type: "click", bbox: [10, 10, 50, 20], selector: "#x", point: [20, 20] },
        ],
        { t_source_unified: undefined },
      ),
      frames(3, 100),
    );
    await expect(
      renderTake({ takeDir, outFile: join(takeDir, "final.mp4") }),
    ).rejects.toThrow(/SUPERCUT_ALLOW_SPARSE/);
  });
});
