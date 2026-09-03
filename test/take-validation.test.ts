import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderTake } from "../src/render/index.js";
import type { EventLog } from "../src/schema/index.js";

/**
 * Malformed take directories must be refused by renderTake BEFORE any
 * browser/encode work — these are the inputs a third-party recorder (or a
 * hand-edit) is most likely to get wrong. All of these throw during the
 * fail-fast validation phase, so no browser is needed.
 */

const viewport = { width: 1920, height: 1080, dpr: 2 };

const goodLog: EventLog = {
  version: 0,
  t_source_unified: true,
  viewport,
  fps: 60,
  events: [
    { t: 0, type: "scene", name: "s1", priority: 1 },
    { t: 300, type: "click", bbox: [10, 10, 50, 20], selector: "#x", point: [20, 20] },
  ],
};

const goodIndex = [
  { file: "frames/000000.png", t_source: 0 },
  { file: "frames/000001.png", t_source: 500 },
];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeTake(opts: { events?: unknown; index?: unknown; skipEvents?: boolean; skipIndex?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "supercut-badtake-"));
  dirs.push(dir);
  mkdirSync(join(dir, "frames"), { recursive: true });
  if (!opts.skipEvents) writeFileSync(join(dir, "events.json"), JSON.stringify(opts.events ?? goodLog));
  if (!opts.skipIndex) writeFileSync(join(dir, "frames-index.json"), JSON.stringify(opts.index ?? goodIndex));
  return dir;
}

const render = (takeDir: string) => renderTake({ takeDir, outFile: join(takeDir, "final.mp4") });

describe("renderTake refuses malformed take directories", () => {
  it("missing events.json", async () => {
    await expect(render(makeTake({ skipEvents: true }))).rejects.toThrow(/events\.json/);
  });

  it("missing frames-index.json", async () => {
    await expect(render(makeTake({ skipIndex: true }))).rejects.toThrow(/frames-index\.json/);
  });

  it("frames-index that is not an array", async () => {
    await expect(render(makeTake({ index: { frames: [] } }))).rejects.toThrow(/not an array/);
  });

  it("frames-index entry with an empty file", async () => {
    await expect(render(makeTake({ index: [{ file: "", t_source: 0 }] }))).rejects.toThrow(/malformed/);
  });

  it("frames-index entry outside the frames/ namespace", async () => {
    await expect(
      render(makeTake({ index: [{ file: "render-plan.json", t_source: 0 }] })),
    ).rejects.toThrow(/frames\//);
  });

  it("non-monotonic t_source", async () => {
    const index = [
      { file: "frames/000000.png", t_source: 0 },
      { file: "frames/000001.png", t_source: 500 },
      { file: "frames/000002.png", t_source: 100 },
    ];
    await expect(render(makeTake({ index }))).rejects.toThrow(/monotonic/);
  });

  it("a corrupt huge timestamp is refused (health gate or take cap, never an allocation)", async () => {
    const log: EventLog = {
      ...goodLog,
      events: [{ t: 0, type: "scene", name: "s1", priority: 1 }],
    };
    const index = [{ file: "frames/000000.png", t_source: 500_000 }];
    await expect(render(makeTake({ events: log, index }))).rejects.toThrow(/sparse|cap/);
  });
});
