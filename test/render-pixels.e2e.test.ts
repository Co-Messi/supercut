import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { renderTake } from "../src/render/index.js";
import { planTake, type FrameIndexEntry } from "../src/render/plan.js";
import type { RenderReport } from "../src/render/report.js";
import type { EventLog } from "../src/schema/index.js";
import { makeLog } from "./helpers/takes.js";

/**
 * Pixel-level checks of the real render path (host page + WebCodecs + mux):
 * the plan-level motion suite cannot see what the compositor draws.
 *
 *  - luminance: a flat grey page renders at the source level, both while the
 *    camera is still (one pass) and while it zooms (motion-blur passes
 *    accumulate), in float16 and in the 8-bit fallback
 *  - cuts: a frame never shows the old page at a different camera state; the
 *    camera may jump only on the frame where the page itself changes
 *
 * Source frames are synthetic 3840x2160 PNGs made with ffmpeg; many index
 * entries may point at one file.
 */

const W = 1920;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function ffmpeg(args: string[]): Buffer {
  return execFileSync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 512 * 1024 * 1024 });
}

/** a 2x-DPR source frame: flat grey, optionally with a black 200x200 CSS px
 *  square at the viewport centre (it reveals the camera's zoom on screen) */
function sourcePng(path: string, grey: number, square: boolean): void {
  const hex = grey.toString(16).padStart(2, "0").repeat(3);
  const filter = `color=c=0x${hex}:s=3840x2160` + (square ? ",drawbox=x=1720:y=880:w=400:h=400:color=black:t=fill" : "");
  ffmpeg(["-f", "lavfi", "-i", filter, "-frames:v", "1", "-y", path]);
}

function writeTake(log: EventLog, index: FrameIndexEntry[], pngs: Record<string, [number, boolean]>): string {
  const dir = mkdtempSync(join(tmpdir(), "supercut-pixels-"));
  dirs.push(dir);
  mkdirSync(join(dir, "frames"));
  for (const [name, [grey, square]] of Object.entries(pngs)) sourcePng(join(dir, "frames", name), grey, square);
  writeFileSync(join(dir, "events.json"), JSON.stringify(log));
  writeFileSync(join(dir, "frames-index.json"), JSON.stringify(index));
  return dir;
}

/** frames every 1000/60 ms over [from, to), all showing `file` */
function span(file: string, from: number, to: number): FrameIndexEntry[] {
  const out: FrameIndexEntry[] = [];
  for (let t = from; t < to; t += 1000 / 60) out.push({ file: `frames/${file}`, t_source: Math.round(t * 1000) / 1000 });
  return out;
}

/**
 * The encoded video is limited-range BT.709 4:2:0. For neutral greys luma
 * alone carries the level, so the checks read the decoded Y plane and map it
 * back to full range exactly; a generic YUV to RGB conversion in the decoder
 * adds its own rounding (measured 2 levels) that is not the renderer's.
 */
const fullRange = (y: number) => ((y - 16) * 255) / 219;
/**
 * The decoded level is quantized to luma codes 255/219 full-range levels
 * apart, and platform encoders convert RGB to luma with different integer
 * rounding: the same grey 134 page encodes to Y 131 with the macOS encoder
 * and to Y 130 on the Linux CI runner. An absolute level is only known to
 * within one code; a level measured against another frame of the same video
 * shares the encoder's conversion and is exact.
 */
const LUMA_CODE = 255 / 219;
/** the decoded level of a grey encoded with exact rounding */
const encodedLevel = (grey: number) => fullRange(Math.round(16 + (219 * grey) / 255));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

/** full-range luma of one canvas row per output frame */
function rows(mp4: string, y: number): number[][] {
  // 4:2:0 needs an even crop height: take two rows, keep the first
  const raw = ffmpeg(["-i", mp4, "-vf", `crop=${W}:2:0:${y}`, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]);
  const frameBytes = W * 2 + 2 * (W / 2);
  const out: number[][] = [];
  for (let o = 0; o + frameBytes <= raw.length; o += frameBytes) {
    out.push(Array.from(raw.subarray(o, o + W), fullRange));
  }
  return out;
}

/** mean full-range grey of a patch around the canvas centre, per output frame */
function centrePatchMeans(mp4: string): number[] {
  const pw = 200, ph = 120;
  const raw = ffmpeg(["-i", mp4, "-vf", `crop=${pw}:${ph}:860:472`, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]);
  const frameBytes = pw * ph + 2 * (pw / 2) * (ph / 2);
  const out: number[] = [];
  for (let o = 0; o + frameBytes <= raw.length; o += frameBytes) {
    let sum = 0;
    for (let i = o; i < o + pw * ph; i++) sum += raw[i]!;
    out.push(fullRange(sum / (pw * ph)));
  }
  return out;
}

async function render(takeDir: string, accumulator: "auto" | "8bit"): Promise<{ mp4: string; report: RenderReport; stderr: string }> {
  const mp4 = join(takeDir, `out-${accumulator}`, "final.mp4");
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await renderTake({ takeDir, outFile: mp4, background: "midnight", accumulator });
    const stderr = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    const report = JSON.parse(readFileSync(join(takeDir, `out-${accumulator}`, "render-report.json"), "utf8")) as RenderReport;
    return { mp4, report, stderr };
  } finally {
    spy.mockRestore();
  }
}

describe("rendered pixels", () => {
  const zoomLog = makeLog([
    { t: 0, type: "scene", name: "s1", priority: 1 },
    { t: 2000, type: "click", bbox: [900, 500, 120, 40], selector: "#a", point: [960, 520] },
    { t: 0, type: "cursor_path", points: [[0, 100, 1000]] },
  ]);
  const zoomIndex = span("grey.png", 0, 3500);

  // An 8-bit accumulator adds round(v/n) per pass, so n passes shift a level
  // by n times that rounding. 134 is the worst case for the 4-pass cap (+2);
  // 132 is exact at 4 passes but shifts by 4 at 8, which the cap prevents.
  // The encode itself adds up to about half a level.
  const cases: [string, "auto" | "8bit", number, number][] = [
    ["float16 accumulator", "auto", 134, 1],
    ["8-bit accumulator, worst case for its pass cap", "8bit", 134, 2.5],
    ["8-bit accumulator, a level that 8 passes would shift by 4", "8bit", 132, 2.5],
  ];
  for (const [name, accumulator, GREY, tolerance] of cases) {
    it(`keeps the source luminance through still and zooming frames (${name})`, async () => {
      const takeDir = writeTake(zoomLog, zoomIndex, { "grey.png": [GREY, false] });
      const { mp4, report, stderr } = await render(takeDir, accumulator);
      expect(report.status).toBe("rendered");
      // "auto" is float16 wherever the browser has it; a GPU-less runner may
      // not, and then the 8-bit bound applies to the same frames
      const mode = report.accumulator?.mode;
      if (accumulator === "8bit") expect(mode).toBe("8bit");
      else expect(mode === "float16" || mode === "8bit").toBe(true);
      const bound = mode === "8bit" ? Math.max(tolerance, 2.5) : tolerance;
      // a normal render prints no warning about bitrate (a flat page encodes tiny)
      expect(stderr).not.toMatch(/WARNING: .*bitrate/i);

      const { plan } = planTake(zoomLog, zoomIndex);
      const means = centrePatchMeans(mp4);
      expect(means.length).toBe(plan.frames);
      const clean = means.slice(plan.fade.inFrames, plan.frames - plan.fade.outFrames);
      const z = (f: number) => plan.camera[f * 8 * 3]!;
      const still = clean.filter((_, i) => z(i + plan.fade.inFrames) < 1.0001);
      const moving = clean.filter((_, i) => {
        const f = i + plan.fade.inFrames;
        return Math.abs(plan.camera[(f * 8 + 7) * 3]! - z(f)) > 1e-4;
      });
      expect(still.length).toBeGreaterThan(10);
      expect(moving.length).toBeGreaterThan(10);
      // a still frame is one pass of the source: every still frame decodes to
      // the same level, within one luma code of the source grey's own code
      const level = median(still);
      for (const m of still) expect(Math.abs(m - level), `still frame at ${m.toFixed(2)}, others at ${level.toFixed(2)}`).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(level - encodedLevel(GREY)),
        `still frames decode to ${level.toFixed(2)} for source ${GREY} (mode ${mode})`,
      ).toBeLessThanOrEqual(LUMA_CODE + 1e-9);
      // zooming frames sum several passes: float16 keeps them at the still
      // level, the 8-bit fallback stays within its cap's rounding of it
      for (const m of moving) {
        expect(Math.abs(m - level), `zooming frame at ${m.toFixed(2)}, still at ${level.toFixed(2)} (mode ${mode})`).toBeLessThanOrEqual(bound);
      }
    }, 120_000);
  }

  it("a frame never shows the old page at a different camera state: the camera jumps only on the page's own cut", async () => {
    // page A (light) is punched into for a hover, then a click navigates: the
    // new page B (darker) paints at the logged commit time, gapless
    const log = makeLog([
      { t: 0, type: "scene", name: "s1", priority: 1 },
      { t: 1400, type: "hover", bbox: [900, 520, 120, 40], selector: "#a" },
      { t: 2150, type: "click", bbox: [900, 520, 120, 40], selector: "#a", point: [960, 540] },
      { t: 2200, type: "navigation" },
      { t: 0, type: "cursor_path", points: [[0, 100, 1000]] },
    ]);
    const index = [...span("a.png", 0, 2200), ...span("b.png", 2200, 3500)];
    const takeDir = writeTake(log, index, { "a.png": [224, true], "b.png": [150, true] });
    const { mp4 } = await render(takeDir, "auto");
    const { plan } = planTake(log, index);
    const row = rows(mp4, 532); // the row through the square's centre

    // per frame: the page (median brightness of the row's content) and the
    // on-screen zoom (the square is 200 CSS px = 160 canvas px wide at z=1)
    const measure = (r: number[]) => {
      let dark = 0;
      const lum: number[] = [];
      for (let x = 600; x < 1320; x++) {
        const v = r[x]!;
        // the square's edges are anti-aliased (and motion-blurred while the
        // camera moves): count partial coverage so the width stays sub-pixel
        if (v < 75) dark++;
        else lum.push(v);
      }
      lum.sort((a, b) => a - b);
      return { z: dark / 160, page: lum[lum.length >> 1]! > 187 ? "A" : "B" };
    };
    const frames = row.slice(0, plan.frames - plan.fade.outFrames).map(measure);
    const first = plan.fade.inFrames;
    let cuts = 0;
    for (let f = first + 1; f < frames.length; f++) {
      const jump = Math.abs(frames[f]!.z - frames[f - 1]!.z);
      if (frames[f]!.page !== frames[f - 1]!.page) {
        cuts++;
        // the page cut: zoomed into A right before, wide on B right after
        expect(frames[f - 1]!.z).toBeGreaterThan(1.3);
        expect(frames[f]!.z).toBeLessThan(1.03);
      } else {
        // same page: the camera only glides (spring speed is under 0.02/frame)
        expect(jump, `camera jumped ${jump.toFixed(3)} at frame ${f} without a page change`).toBeLessThan(0.03);
      }
    }
    expect(cuts).toBe(1);
  }, 120_000);
});
