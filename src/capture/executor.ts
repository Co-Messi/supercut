/**
 * Capture executor — stage 3. Pure code, zero AI.
 *
 *   recipe ──▶ ┌─────────────────────────────────────────────┐
 *              │ for each scene:                              │
 *              │   entry navigation (fixed scheduled allowance)│
 *              │   for each action:                           │
 *              │     cursor path → CDP mouse events           │──▶ frames/*.png
 *              │     perform (click/type/scroll/hover/wait)   │    + frame index
 *              │     log event {t scheduled, observed_t}      │──▶ events.json
 *              │   on action timeout → scene failed, continue │
 *              └─────────────────────────────────────────────┘
 *
 * A take is ALWAYS a whole-run recording (no per-scene stitching).
 * Timestamp canon: `t` is the scheduled clock; when reality overruns a slot,
 * the remainder of the schedule shifts by whole frames and the shifted times
 * are canonical (design doc, stage 3). On a local fixture nothing overruns,
 * so the scheduled timeline is byte-identical across runs.
 *
 * Capture path per spike verdict (spikes/RESULTS.md): CDP screencast PNG at
 * 2x DPR, ack-throttled, frames streamed straight to disk.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright";
import type { EventLog, KnownEvent, Recipe, Scene, Action } from "../schema/index.js";
import { cursorPath, makeRng, type CursorPoint } from "./cursor.js";

const VIEWPORT = { width: 1920, height: 1080 };
const DPR = 2;
const FPS = 60;
const FRAME_MS = 1000 / FPS;
const ACTION_TIMEOUT_MS = 10_000;
const ENTRY_NAV_ALLOWANCE_MS = 1_000;

export interface RecordOptions {
  recipe: Recipe;
  outDir: string;
  seed?: number;
  /** Skip screencast (faster scheduling-only tests). */
  captureFrames?: boolean;
}

export interface RecordResult {
  eventLog: EventLog;
  frameCount: number;
  failedScenes: string[];
  aborted: boolean;
  outDir: string;
}

interface FrameIndexEntry {
  file: string;
  /** source timestamp, ms since first frame */
  t_source: number;
}

function roundToFrame(ms: number): number {
  return Math.round(ms / FRAME_MS) * FRAME_MS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function record(opts: RecordOptions): Promise<RecordResult> {
  const { recipe, outDir } = opts;
  const captureFrames = opts.captureFrames ?? true;
  const rng = makeRng(opts.seed ?? 1);

  mkdirSync(join(outDir, "frames"), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DPR });
  const cdp: CDPSession = await page.context().newCDPSession(page);

  const events: KnownEvent[] = [];
  const pathPoints: [number, number, number][] = []; // [t, x, y] global cursor track
  const frameIndex: FrameIndexEntry[] = [];
  const pendingWrites: Promise<unknown>[] = [];
  let firstFrameStamp = -1;
  let frameCounter = 0;

  if (captureFrames) {
    cdp.on("Page.screencastFrame", (ev) => {
      const stampMs = (ev.metadata.timestamp ?? 0) * 1000;
      if (firstFrameStamp < 0) firstFrameStamp = stampMs;
      const file = `frames/${String(frameCounter++).padStart(6, "0")}.png`;
      frameIndex.push({ file, t_source: stampMs - firstFrameStamp });
      pendingWrites.push(
        writeFile(join(outDir, file), Buffer.from(ev.data, "base64")),
      );
      cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
    });
  }

  /** scheduled clock (canonical `t`) and wall anchor for observed_t */
  let clock = 0;
  let wallStart = 0;
  const cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height - 100 }; // parked off-content
  const failedScenes: string[] = [];
  let aborted = false;

  const observedNow = () => Date.now() - wallStart;

  async function moveCursor(points: CursorPoint[], baseT: number): Promise<void> {
    const t0 = Date.now();
    for (const p of points) {
      const wait = p.t - (Date.now() - t0);
      if (wait > 4) await sleep(wait);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      pathPoints.push([baseT + p.t, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
    }
    const last = points[points.length - 1];
    if (last) { cursor.x = last.x; cursor.y = last.y; }
  }

  async function targetBox(selector: string): Promise<{ x: number; y: number; w: number; h: number }> {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    const box = await loc.boundingBox();
    if (!box) throw new Error(`selector "${selector}" has no bounding box`);
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  }

  async function runAction(a: Action): Promise<void> {
    const scheduledT = clock;
    const slotEnd = clock + a.duration_ms;

    switch (a.kind) {
      case "goto": {
        if (!a.url) throw new Error("goto action requires url");
        await page.goto(a.url, { timeout: ACTION_TIMEOUT_MS, waitUntil: "load" });
        break;
      }
      case "wait":
        await sleep(a.duration_ms);
        break;
      case "click":
      case "hover":
      case "type": {
        if (!a.selector) throw new Error(`${a.kind} action requires selector`);
        const box = await targetBox(a.selector);
        const target = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
        const travelBudget = Math.max(250, a.duration_ms * 0.7);
        const points = cursorPath({
          from: { ...cursor }, to: target, targetWidth: box.w,
          maxDurationMs: travelBudget, rng,
        });
        await moveCursor(points, scheduledT);

        if (a.kind === "click" || a.kind === "type") {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1,
          });
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1,
          });
          events.push({
            t: scheduledT, observed_t: observedNow(), type: "click",
            bbox: [box.x, box.y, box.w, box.h], selector: a.selector,
            point: [target.x, target.y],
          });
        } else {
          events.push({
            t: scheduledT, observed_t: observedNow(), type: "hover",
            bbox: [box.x, box.y, box.w, box.h], selector: a.selector,
          });
        }

        if (a.kind === "type") {
          const text = a.text ?? "";
          const remaining = Math.max(200, a.duration_ms - (observedNow() - scheduledT));
          const perChar = Math.min(90, remaining / Math.max(text.length, 1));
          for (const ch of text) {
            await cdp.send("Input.insertText", { text: ch });
            await sleep(perChar);
          }
          events.push({
            t: scheduledT, observed_t: observedNow(), type: "type",
            bbox: [box.x, box.y, box.w, box.h], selector: a.selector,
            textLen: text.length,
          });
        }
        break;
      }
      case "scroll": {
        const from: [number, number] = [cursor.x, cursor.y];
        const steps = 12;
        const totalDy = 600;
        for (let i = 0; i < steps; i++) {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel", x: cursor.x, y: cursor.y,
            deltaX: 0, deltaY: totalDy / steps,
          });
          await sleep(a.duration_ms / steps / 2);
        }
        events.push({
          t: scheduledT, observed_t: observedNow(), type: "scroll",
          from, to: [cursor.x, cursor.y + totalDy],
        });
        break;
      }
    }

    // dwell out the remainder of the slot, then advance the canonical clock;
    // on overrun, shift the schedule by whole frames (timestamp canon)
    const observedEnd = observedNow();
    if (observedEnd < slotEnd) {
      await sleep(slotEnd - observedEnd);
      clock = slotEnd;
    } else {
      clock = roundToFrame(observedEnd);
    }
  }

  try {
    // navigate to first scene's entry before starting capture, so frame 0 is content
    const firstScene = recipe.scenes[0];
    if (!firstScene) throw new Error("recipe has no scenes");
    await page.goto(firstScene.entry.url, { timeout: ACTION_TIMEOUT_MS, waitUntil: "load" });

    if (captureFrames) {
      await cdp.send("Page.startScreencast", {
        format: "png",
        maxWidth: VIEWPORT.width * DPR,
        maxHeight: VIEWPORT.height * DPR,
        everyNthFrame: 1,
      });
    }
    wallStart = Date.now();

    for (let i = 0; i < recipe.scenes.length; i++) {
      const scene: Scene = recipe.scenes[i]!;

      // dependency cascade: parent failed → this scene dies with it
      if (scene.depends_on.some((d) => failedScenes.includes(d))) {
        failedScenes.push(scene.name);
        if (failedScenes.length > recipe.scenes.length / 2) {
          aborted = true;
          console.error(
            `abort: ${failedScenes.length}/${recipe.scenes.length} scenes lost (cascade from "${scene.depends_on.join(",")}")`,
          );
          break;
        }
        continue;
      }

      events.push({ t: clock, observed_t: observedNow(), type: "scene", name: scene.name, priority: scene.priority });

      try {
        if (i > 0) {
          await page.goto(scene.entry.url, { timeout: ACTION_TIMEOUT_MS, waitUntil: "load" });
          const navEnd = observedNow();
          clock = navEnd > clock + ENTRY_NAV_ALLOWANCE_MS
            ? roundToFrame(navEnd)
            : clock + ENTRY_NAV_ALLOWANCE_MS;
        }
        for (const a of scene.entry.prelude) await runAction(a);
        for (const a of scene.actions) await runAction(a);
      } catch (err) {
        failedScenes.push(scene.name);
        const failedWithDeps = failedScenes.length;
        if (i === 0 || failedWithDeps > recipe.scenes.length / 2) {
          aborted = true;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`abort: scene "${scene.name}" failed (${msg}); ${failedWithDeps}/${recipe.scenes.length} scenes lost`);
          break;
        }
      }
    }
  } finally {
    if (captureFrames) {
      await cdp.send("Page.stopScreencast").catch(() => {});
    }
    await Promise.allSettled(pendingWrites);
    await browser.close();
  }

  if (pathPoints.length > 0) {
    events.push({ t: 0, type: "cursor_path", points: pathPoints });
  }

  const eventLog: EventLog = {
    version: 0,
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height, dpr: DPR },
    fps: FPS,
    events,
  };

  writeFileSync(join(outDir, "events.json"), JSON.stringify(eventLog, null, 2));
  writeFileSync(join(outDir, "frames-index.json"), JSON.stringify(frameIndex));

  return { eventLog, frameCount: frameIndex.length, failedScenes, aborted, outDir };
}
