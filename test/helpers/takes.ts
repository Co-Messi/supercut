/**
 * Synthetic take builders for render tests: an events.json + frames-index.json
 * pair written to a fresh temp directory. Frames are not written unless a test
 * asks for them; gates that refuse a take run before any frame is read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameIndexEntry } from "../../src/render/plan.js";
import type { EventLog } from "../../src/schema/index.js";

export const VIEWPORT = { width: 1920, height: 1080, dpr: 2 };

export function makeLog(events: EventLog["events"], extra: Partial<EventLog> = {}): EventLog {
  return { version: 0, t_source_unified: true, viewport: VIEWPORT, fps: 60, events, ...extra };
}

/** `count` frames `spacingMs` apart, named frames/000000.<ext> onward */
export function frames(count: number, spacingMs: number, ext = "png"): FrameIndexEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    file: `frames/${String(i).padStart(6, "0")}.${ext}`,
    t_source: Math.round(i * spacingMs * 1000) / 1000,
  }));
}

/** a temp-dir registry: `make` writes a take, `cleanup` removes them all */
export function takeDirs(prefix = "supercut-take-") {
  const dirs: string[] = [];
  return {
    make(log: EventLog, index: FrameIndexEntry[]): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      mkdirSync(join(dir, "frames"), { recursive: true });
      writeFileSync(join(dir, "events.json"), JSON.stringify(log));
      writeFileSync(join(dir, "frames-index.json"), JSON.stringify(index));
      return dir;
    },
    cleanup(): void {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}

/** a launcher that fails like a missing Chromium: proves a render got past
 *  every pre-browser gate without starting a browser */
export async function noBrowser(): Promise<never> {
  throw new Error("browserType.launch: Executable doesn't exist at /nonexistent/chromium (test launcher)");
}
