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
 * Timestamp canon: the schedule clock still paces slots and budget, but event
 * and cursor `t` are stamped on the OBSERVED clock at actual dispatch time —
 * anchored to the first screencast frame's CDP timestamp, i.e. the SAME
 * timeline as frame `t_source`. When reality overruns a slot, the remainder of
 * the schedule shifts by whole frames and the shifted times are canonical
 * (design doc, stage 3). On a local fixture the structure and geometry are
 * byte-identical across runs; `t` carries only wall-clock jitter of a few ms.
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

/**
 * CDP screencast is change-driven: a static page produces NO compositor
 * commits, so capture collapses to a few fps and the renderer stretches one
 * frame across seconds. This rAF beacon — a 1×1px fixed corner element on its
 * own compositor layer, toggling between two sub-perceptual opacities — forces
 * one commit per display frame. 1/255 alpha on one pixel is invisible in the
 * PNGs and below any encoder threshold; pointer-events:none + no layout means
 * it can never interfere with the page. Injected as an init script so it
 * survives full navigations; the rAF loop itself survives SPA route changes.
 */
const REPAINT_BEACON_ID = "__supercut_repaint_beacon__";
const REPAINT_BEACON_SCRIPT = `(() => {
  if (window.__supercutBeacon) return;
  window.__supercutBeacon = true;
  let el = null;
  let flip = false;
  const tick = () => {
    if (!el || !el.isConnected) {
      const root = document.body || document.documentElement;
      if (root) {
        el = document.createElement("div");
        el.id = ${JSON.stringify(REPAINT_BEACON_ID)};
        el.setAttribute("aria-hidden", "true");
        el.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;" +
          "pointer-events:none;z-index:2147483647;background:#000;opacity:0.004;" +
          "will-change:opacity;contain:strict";
        root.appendChild(el);
      }
    }
    if (el) {
      flip = !flip;
      el.style.opacity = flip ? "0.008" : "0.004";
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

/** how long after a click/type the page gets to reveal its result before the
 *  changed-region union is read (bounded by the action's slot) */
const MUTATION_WINDOW_MS = 1200;
/** a changed-region union smaller than this fraction of the viewport is not a
 *  payoff worth framing (a toast, a counter tick) */
const MUTATION_MIN_AREA_FRAC = 0.02;
/** attribute/text churn on elements smaller than this is noise, not a result */
const MUTATION_MIN_CHURN_AREA_PX = 1024;

/**
 * Changed-region tracker: records elements mutated/added after an action so
 * the capture stage can frame the RESULT by default, even when the script
 * named no focus_selector. Injected as an init script (survives navigations);
 * armed per action from Node. The repaint beacon excludes itself by id.
 */
const MUTATION_OBSERVER_SCRIPT = `(() => {
  if (window.__supercutMutations) return;
  const beaconId = ${JSON.stringify(REPAINT_BEACON_ID)};
  let tracked = null;
  const observer = new MutationObserver((records) => {
    if (!tracked) return;
    for (const r of records) {
      if (r.type === "childList") {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1) tracked.added.add(n);
          else if (n.parentElement) tracked.mutated.add(n.parentElement);
        }
      } else {
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (el) tracked.mutated.add(el);
      }
    }
  });
  window.__supercutMutations = {
    arm() {
      tracked = { added: new Set(), mutated: new Set() };
      observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
    },
    collect(minChurnArea) {
      if (!tracked) return null;
      const t = tracked;
      tracked = null;
      observer.disconnect();
      const vw = window.innerWidth, vh = window.innerHeight;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const consider = (el, churnOnly) => {
        if (!el.isConnected || el.id === beaconId) return;
        // visibility is evaluated NOW, at collection end — a transient overlay
        // (toast/popup already removed or mid fade-out, including via an
        // ancestor's opacity/display) must never become the framed result
        if (typeof el.checkVisibility === "function" &&
            !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) return;
        const r = el.getBoundingClientRect();
        const w = Math.min(r.right, vw) - Math.max(r.left, 0);
        const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        if (w <= 0 || h <= 0) return;
        if (churnOnly && w * h < minChurnArea) return;
        x0 = Math.min(x0, Math.max(r.left, 0));
        y0 = Math.min(y0, Math.max(r.top, 0));
        x1 = Math.max(x1, Math.min(r.right, vw));
        y1 = Math.max(y1, Math.min(r.bottom, vh));
      };
      for (const el of t.added) consider(el, false);
      for (const el of t.mutated) if (!t.added.has(el)) consider(el, true);
      if (x1 <= x0 || y1 <= y0) return null;
      return [x0, y0, x1 - x0, y1 - y0];
    },
  };
})();`;

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

/** overrun shifts round UP to the frame grid: rounding down could place the
 *  shifted clock before an event already stamped at observed time */
function ceilToFrame(ms: number): number {
  return Math.ceil(ms / FRAME_MS) * FRAME_MS;
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

  /** schedule clock (paces slots + budget); wall anchor shared with frame t_source */
  let clock = 0;
  let wallStart = 0;
  const cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height - 100 }; // parked off-content
  const failedScenes: string[] = [];
  let aborted = false;

  const observedNow = () => Date.now() - wallStart;
  /** monotonic stamp: event `t` rides the observed clock; sleep/rounding jitter
   *  of a few ms must never produce an out-of-order timeline */
  let lastStampT = 0;
  const stamp = (t: number): number => (lastStampT = Math.max(lastStampT, t));

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

  type MutationsApi = {
    __supercutMutations?: {
      arm: () => void;
      collect: (minChurnArea: number) => [number, number, number, number] | null;
    };
  };

  async function armMutationObserver(): Promise<boolean> {
    return page
      .evaluate(() => {
        const m = (window as unknown as MutationsApi).__supercutMutations;
        if (!m) return false;
        m.arm();
        return true;
      })
      .catch(() => false);
  }

  async function collectMutationBbox(): Promise<[number, number, number, number] | null> {
    return page
      .evaluate(
        (minChurnArea) =>
          (window as unknown as MutationsApi).__supercutMutations?.collect(minChurnArea) ?? null,
        MUTATION_MIN_CHURN_AREA_PX,
      )
      .catch(() => null);
  }

  /**
   * Attach the camera's result target to the event just emitted, by priority:
   *   1. QC's patched zoom bbox (a verdict from real footage — always wins)
   *   2. the script's focus_selector, resolved post-action
   *   3. the changed-region union observed after the action (frame the result
   *      by default — no LLM cooperation required)
   * Every miss falls through; focus_source records which path won.
   */
  async function resolveFocus(
    a: Action,
    widget: [number, number, number, number],
    armed: boolean,
    slotEnd: number,
  ): Promise<void> {
    const ev = events[events.length - 1];
    if (!ev || (ev.type !== "click" && ev.type !== "type" && ev.type !== "hover")) return;
    if (a.zoom) {
      ev.focus_bbox = a.zoom;
      ev.focus_source = "qc";
      return;
    }
    let settled = 0;
    if (a.focus_selector) {
      await sleep(SETTLE_MS);
      settled = SETTLE_MS;
      const fb = await page.locator(a.focus_selector).first().boundingBox().catch(() => null);
      if (fb && fb.width > 4 && fb.height > 4) {
        ev.focus_bbox = [fb.x, fb.y, fb.width, fb.height];
        ev.focus_source = "llm";
        return;
      }
    }
    if (!armed) return;
    // let the reaction land, inside the slot (the dwell absorbs this wait)
    const wait = Math.min(MUTATION_WINDOW_MS - settled, slotEnd - observedNow());
    if (wait > 0) await sleep(wait);
    const union = await collectMutationBbox();
    if (!union) return;
    const [ux, uy, uw, uh] = union;
    if (uw * uh < VIEWPORT.width * VIEWPORT.height * MUTATION_MIN_AREA_FRAC) return;
    // ~the widget itself → the interaction bbox already frames it
    const [wx, wy, ww, wh] = widget;
    const pad = 8;
    const insideWidget =
      ux >= wx - pad && uy >= wy - pad && ux + uw <= wx + ww + pad && uy + uh <= wy + wh + pad;
    if (insideWidget) return;
    ev.focus_bbox = [ux, uy, uw, uh];
    ev.focus_source = "mutation";
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
        // targetBox burns unbounded wall time (waitFor + scroll + settle) —
        // rebase the action's timeline to observed NOW so cursor + events sit
        // where the footage actually shows the page reacting, not where the
        // schedule hoped it would.
        const startT = Math.max(scheduledT, observedNow());
        const target = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
        const travelBudget = Math.max(250, a.duration_ms * 0.7);
        const points = cursorPath({
          from: { ...cursor }, to: target, targetWidth: box.w,
          maxDurationMs: travelBudget, rng,
        });
        await moveCursor(points, startT);
        const armed = a.kind !== "hover" && !a.zoom ? await armMutationObserver() : false;
        const pathEndT = startT + (points[points.length - 1]?.t ?? 0);
        const dispatchT = observedNow();

        if (a.kind === "click" || a.kind === "type") {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1,
          });
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1,
          });
          events.push({
            t: stamp(Math.max(pathEndT, dispatchT)), observed_t: dispatchT, type: "click",
            bbox: [box.x, box.y, box.w, box.h], selector: a.selector,
            point: [target.x, target.y],
          });
        } else {
          events.push({
            t: stamp(Math.max(pathEndT, dispatchT)), observed_t: dispatchT, type: "hover",
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
            t: stamp(observedNow()), observed_t: observedNow(), type: "type",
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
        await resolveFocus(a, [box.x, box.y, box.w, box.h], armed, slotEnd);
        break;
      }
      case "scroll": {
        const from: [number, number] = [cursor.x, cursor.y];
        const totalDy = 600;
        // fine-grained eased scroll at ~60Hz across the whole slot: coarse
        // 50px wheel pops read as content jumps in the footage; many small
        // ease-in-out deltas capture as continuous motion.
        const steps = Math.max(2, Math.round(a.duration_ms / FRAME_MS));
        const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
        const t0 = Date.now();
        let sent = 0;
        for (let i = 1; i <= steps; i++) {
          const targetDy = Math.round(totalDy * ease(i / steps));
          const dy = targetDy - sent;
          if (dy !== 0) {
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseWheel", x: cursor.x, y: cursor.y,
              deltaX: 0, deltaY: dy,
            });
            sent = targetDy;
          }
          const wait = (i / steps) * a.duration_ms - (Date.now() - t0);
          if (wait > 4) await sleep(wait);
        }
        events.push({
          t: stamp(Math.max(scheduledT, observedNow() - a.duration_ms)), observed_t: observedNow(), type: "scroll",
          from, to: [cursor.x, cursor.y + totalDy],
        });
        break;
      }
    }

    // dwell out the remainder of the slot, then advance the schedule clock;
    // on overrun, shift the schedule by whole frames (timestamp canon)
    const observedEnd = observedNow();
    if (observedEnd < slotEnd) {
      await sleep(slotEnd - observedEnd);
      clock = stamp(slotEnd);
    } else {
      clock = stamp(ceilToFrame(observedEnd));
    }
  }

  try {
    page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DPR });
    if (captureFrames) await page.addInitScript(REPAINT_BEACON_SCRIPT);
    await page.addInitScript(MUTATION_OBSERVER_SCRIPT);
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
          // a frame without a CDP timestamp cannot be placed on the timeline —
          // indexing it at 0 would poison t_source with an epoch-sized negative
          const stampMs = (ev.metadata.timestamp ?? 0) * 1000;
          if (!(stampMs > 0)) {
            await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
            return;
          }
          if (firstFrameStamp < 0) {
            firstFrameStamp = stampMs;
            signalFirstFrame();
          }
          const file = `frames/${String(frameCounter++).padStart(6, "0")}.png`;
          try {
            await writeFile(join(outDir, file), Buffer.from(ev.data, "base64"));
            // clamp: delivery jitter can hand us a frame stamped a hair BEFORE
            // the first-processed frame; a negative t_source would sort to
            // entry 0 and fail render-plan validation
            frameIndex.push({ file, t_source: Math.max(0, stampMs - firstFrameStamp) });
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
    // one timeline for everything: frame t_source is (CDP timestamp − first
    // frame's CDP timestamp), so anchoring the observed clock to that same
    // epoch stamp puts events and cursor on the frame timeline exactly. CDP
    // timestamps are wall epoch; guard against a pathological clock-domain
    // mismatch with a plain Date.now() fallback.
    wallStart =
      firstFrameStamp > 0 && Math.abs(Date.now() - firstFrameStamp) < 10_000
        ? firstFrameStamp
        : Date.now();

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

      events.push({ t: stamp(clock), observed_t: observedNow(), type: "scene", name: scene.name, priority: scene.priority });

      try {
        if (i > 0) {
          await assertSafeNavigationUrl(scene.entry.url, { allowPrivateNetwork });
          // suppress capture across the reload so the blank page never lands in
          // the footage (the scene-change flash); resume once it has painted.
          // MUST reset in finally: if gotoReady/assert throws, leaving this true
          // would make the screencast handler drop EVERY subsequent frame and
          // freeze the rest of the video on the previous scene.
          isNavigating = true;
          try {
            const response = await gotoReady(page, scene.entry.url);
            await assertSafeNavigationUrl(scene.entry.url, { allowPrivateNetwork, finalUrl: response?.url() ?? page.url() });
            await sleep(SETTLE_MS);
          } finally {
            isNavigating = false;
          }
          // Timestamp canon: when nav finishes early, dwell out
          // the unused allowance in WALL time so pixels and schedule stay in
          // lockstep — advancing only the clock made the footage run ~1s ahead
          // of every logged event after a fast local navigation
          const navEnd = observedNow();
          const target = clock + ENTRY_NAV_ALLOWANCE_MS;
          if (navEnd < target) {
            await sleep(target - navEnd);
            clock = stamp(target);
          } else {
            clock = stamp(ceilToFrame(navEnd));
          }
        }
        for (const a of scene.entry.prelude) await runAction(a);
        for (const a of scene.actions) await runAction(a);
        // Hold the scene's final frame; it is validated and budgeted by the schema.
        if (scene.hold_ms > 0) {
          await sleep(scene.hold_ms);
          clock = stamp(clock + scene.hold_ms);
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
