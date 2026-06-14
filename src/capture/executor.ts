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
 * Capture path: CDP screencast PNG at
 * 2x DPR, ack-throttled, frames streamed straight to disk.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright";
import type { EventLog, KnownEvent, Recipe, Scene, Action } from "../schema/index.js";
import { cursorPath, makeRng, type CursorPoint } from "./cursor.js";
import { assertSafeNavigationUrl } from "../security/url-policy.js";

const VIEWPORT = { width: 1920, height: 1080 };
const DPR = 2;
const FPS = 60;
const FRAME_MS = 1000 / FPS;
const ACTION_TIMEOUT_MS = 10_000;
const ENTRY_NAV_ALLOWANCE_MS = 1_000;
/** `load` ≠ app ready (hydration, fonts, late paints) — every navigation gets
 *  a settle pause before the schedule continues */
const SETTLE_MS = 400;

export interface RecordOptions {
  recipe: Recipe;
  outDir: string;
  seed?: number;
  /** Skip screencast (faster scheduling-only tests). */
  captureFrames?: boolean;
  /** allow localhost/RFC1918/cloud-metadata navigation; off by default for safety */
  allowPrivateNetwork?: boolean;
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

// Navigate robustly. Waiting for "load" hangs on apps that pull heavy subresources
// from a CDN (e.g. the Pandora demo's d3 bundle) or hold an open connection — the
// 10s budget blew on a page whose `load` only fired at ~12s, even though the DOM
// was interactive almost immediately. So: resolve on "domcontentloaded" (DOM parsed
// + scripts available), then give the full `load` a best-effort grace window but
// never fail on it. SETTLE_MS after this lets first paints land. Returns the nav
// response so callers can re-check the final URL against the SSRF policy.
async function gotoReady(page: Page, url: string) {
  const response = await page.goto(url, { timeout: ACTION_TIMEOUT_MS, waitUntil: "domcontentloaded" });
  await page.waitForLoadState("load", { timeout: 2_000 }).catch(() => {});
  return response;
}

async function assertRecipeNavigationPolicy(recipe: Recipe, allowPrivateNetwork: boolean): Promise<void> {
  for (const scene of recipe.scenes) {
    await assertSafeNavigationUrl(scene.entry.url, { allowPrivateNetwork });
    for (const action of [...scene.entry.prelude, ...scene.actions]) {
      if (action.kind === "goto" && action.url) {
        await assertSafeNavigationUrl(action.url, { allowPrivateNetwork });
      }
    }
  }
}

export async function record(opts: RecordOptions): Promise<RecordResult> {
  const { recipe, outDir } = opts;
  const captureFrames = opts.captureFrames ?? true;
  const allowPrivateNetwork = opts.allowPrivateNetwork ?? false;
  const rng = makeRng(opts.seed ?? 1);

  await assertRecipeNavigationPolicy(recipe, allowPrivateNetwork);

  mkdirSync(join(outDir, "frames"), { recursive: true });

  // launch is the only setup outside try/finally; everything else (newPage,
  // CDP session) lives inside so a setup failure can't leak the browser
  const browser = await chromium.launch({ headless: true });

  const events: KnownEvent[] = [];
  const pathPoints: [number, number, number][] = []; // [t, x, y] global cursor track
  const frameIndex: FrameIndexEntry[] = [];
  let firstFrameStamp = -1;
  let frameCounter = 0;
  // true while an inter-scene navigation is in flight: the page is blank/white
  // mid-reload, and capturing those frames makes the video FLASH at every scene
  // change. Skip them — the renderer holds the last good frame across the gap.
  let isNavigating = false;
  let writeErrors = 0;
  let lastWrite: Promise<void> = Promise.resolve();
  let signalFirstFrame: () => void = () => {};
  const firstFrameSeen = new Promise<void>((r) => (signalFirstFrame = r));

  // assigned inside try (so failures can't leak the browser); helpers close over them
  let page!: Page;
  let cdp!: CDPSession;

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
    // scroll the element INTO the viewport before targeting it. Without this,
    // boundingBox returns document coordinates for below/above-fold elements
    // (e.g. y=6549 or y=-3883), the cursor + camera then aim off-frame and the
    // shot is pure background. Scrolling is also how a single-viewport recording
    // reveals different parts of a long page. (Found on the first live run.)
    const pre = await loc.boundingBox();
    const alreadyInView =
      !!pre && pre.y >= 0 && pre.y + pre.height <= VIEWPORT.height && pre.x >= 0;
    await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    // settle ONLY when a scroll actually happened — an unconditional sleep adds
    // wall-time to every action, tipping in-view actions into the overrun path
    // and breaking the scheduled-timeline determinism contract on fixtures
    if (!alreadyInView) await sleep(350);
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
        await assertSafeNavigationUrl(a.url, { allowPrivateNetwork });
        const response = await gotoReady(page, a.url);
        await assertSafeNavigationUrl(a.url, { allowPrivateNetwork, finalUrl: response?.url() ?? page.url() });
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
            textLen: [...text].length, // code points, matching the for...of insertion
          });
          if (a.submit) {
            // Many query inputs only reveal their payoff on submit (a form's
            // submit handler / an Enter keydown). Typing alone leaves the app in
            // its idle state — the video would show a filled box and no result.
            await page.keyboard.press("Enter");
          }
        }
        // 4b — frame the result, not the cursor: if this action names a result
        // region, resolve its box AFTER the action (and a settle for the payoff
        // to render) and attach it to the event. The renderer prefers it over
        // the interaction bbox, so the camera holds on the graph/results the
        // action produced — not the input box. Unresolvable → silently skip.
        if (a.focus_selector) {
          await sleep(SETTLE_MS);
          const fb = await page.locator(a.focus_selector).first().boundingBox().catch(() => null);
          const ev = events[events.length - 1];
          if (fb && fb.width > 4 && fb.height > 4 && ev &&
              (ev.type === "click" || ev.type === "type" || ev.type === "hover")) {
            ev.focus_bbox = [fb.x, fb.y, fb.width, fb.height];
          }
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
    page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DPR });
    cdp = await page.context().newCDPSession(page);

    if (captureFrames) {
      // ack-AFTER-write: Chromium won't send the next frame until we ack, so
      // awaiting the disk write before acking gives true backpressure (one
      // write in flight) and a failed write can never be silently indexed
      cdp.on("Page.screencastFrame", (ev) => {
        lastWrite = (async () => {
          // drop blank frames captured mid-navigation (the scene-change flash)
          if (isNavigating) {
            await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
            return;
          }
          const stampMs = (ev.metadata.timestamp ?? 0) * 1000;
          if (firstFrameStamp < 0) {
            firstFrameStamp = stampMs;
            signalFirstFrame();
          }
          const file = `frames/${String(frameCounter++).padStart(6, "0")}.png`;
          try {
            await writeFile(join(outDir, file), Buffer.from(ev.data, "base64"));
            frameIndex.push({ file, t_source: stampMs - firstFrameStamp });
          } catch {
            writeErrors++;
          } finally {
            await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
          }
        })();
      });
    }

    // navigate to first scene's entry before starting capture, so frame 0 is content
    const firstScene = recipe.scenes[0];
    if (!firstScene) throw new Error("recipe has no scenes");
    await assertSafeNavigationUrl(firstScene.entry.url, { allowPrivateNetwork });
    const firstResponse = await gotoReady(page, firstScene.entry.url);
    await assertSafeNavigationUrl(firstScene.entry.url, { allowPrivateNetwork, finalUrl: firstResponse?.url() ?? page.url() });
    await sleep(SETTLE_MS); // `load` ≠ ready: let hydration/fonts/paints settle

    if (captureFrames) {
      await cdp.send("Page.startScreencast", {
        format: "png",
        maxWidth: VIEWPORT.width * DPR,
        maxHeight: VIEWPORT.height * DPR,
        everyNthFrame: 1,
      });
      // actions must not start before footage exists (frame-0 race)
      await Promise.race([firstFrameSeen, sleep(3000)]);
      if (firstFrameStamp < 0) console.error("warning: no screencast frame within 3s — page may be fully static");
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
          await assertSafeNavigationUrl(scene.entry.url, { allowPrivateNetwork });
          // suppress capture across the reload so the blank page never lands in
          // the footage (the scene-change flash); resume once it has painted.
          isNavigating = true;
          const response = await gotoReady(page, scene.entry.url);
          await assertSafeNavigationUrl(scene.entry.url, { allowPrivateNetwork, finalUrl: response?.url() ?? page.url() });
          await sleep(SETTLE_MS);
          isNavigating = false;
          // Timestamp canon: when nav finishes early, dwell out
          // the unused allowance in WALL time so pixels and schedule stay in
          // lockstep — advancing only the clock made the footage run ~1s ahead
          // of every logged event after a fast local navigation
          const navEnd = observedNow();
          const target = clock + ENTRY_NAV_ALLOWANCE_MS;
          if (navEnd < target) {
            await sleep(target - navEnd);
            clock = target;
          } else {
            clock = roundToFrame(navEnd);
          }
        }
        for (const a of scene.entry.prelude) await runAction(a);
        for (const a of scene.actions) await runAction(a);
        // Hold the scene's final frame; it is validated and budgeted by the schema.
        if (scene.hold_ms > 0) {
          await sleep(scene.hold_ms);
          clock += scene.hold_ms;
        }
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
    if (captureFrames && cdp) {
      await cdp.send("Page.stopScreencast").catch(() => {});
    }
    await lastWrite.catch(() => {});
    await browser.close();
  }

  if (writeErrors > 0) {
    throw new Error(
      `${writeErrors} frame write(s) failed — take is incomplete, refusing to emit a corrupt index`,
    );
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
  // CDP screencast timestamps can arrive/write with tiny ordering jitter across
  // platforms. The renderer consumes by source timestamp, not filename order,
  // so persist a monotonic index instead of failing later in render.
  frameIndex.sort((a, b) => a.t_source - b.t_source);
  writeFileSync(join(outDir, "frames-index.json"), JSON.stringify(frameIndex));

  return { eventLog, frameCount: frameIndex.length, failedScenes, aborted, outDir };
}
