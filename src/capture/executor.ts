/**
 * Capture executor — stage 3. Pure code, zero AI.
 *
 *   recipe ──▶ ┌─────────────────────────────────────────────┐
 *              │ for each scene:                              │
 *              │   entry navigation (fixed scheduled allowance)│
 *              │   for each action:                           │
 *              │     cursor path → CDP mouse events           │──▶ frames/*.jpg
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
 * Capture path: CDP screencast JPEG (q92) at 2x DPR, frames streamed straight
 * to disk. JPEG keeps the encode fast enough for a 60fps source, and q92 is
 * visually lossless for UI at this resolution (every output pixel is a ~2x
 * downsample of the source). A frame byte-identical to the previous one is
 * not written again: its frames-index entry names the earlier file.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type CDPSession, type Page, type Response } from "playwright";
import type { EventLog, KnownEvent, Recipe, Scene, Action } from "../schema/index.js";
import { cursorPath, graphemes, makeRng, typingPlan, type CursorPoint } from "./cursor.js";
import { NavigationLog } from "./navigation.js";
import {
  GATED_REDIRECT_HEADER,
  installRequestGate,
  settleGatedRedirect,
  type GatedContext,
} from "../security/browser-gate.js";
import {
  assertSafeNavigationUrl,
  createRequestGate,
  gateWebSockets,
  resolveAndPinHost,
  type RequestGate,
} from "../security/url-policy.js";

const VIEWPORT = { width: 1920, height: 1080 };
const DPR = 2;
const FPS = 60;
const FRAME_MS = 1000 / FPS;
const ACTION_TIMEOUT_MS = 10_000;
/** screencast JPEG quality: q92 keeps 2x-DPR text edges clean after the
 *  renderer's downsample while encoding fast enough for a 60fps source */
const JPEG_QUALITY = 92;
const ENTRY_NAV_ALLOWANCE_MS = 1_000;
/** `load` ≠ app ready (hydration, fonts, late paints) — every navigation gets
 *  a settle pause before the schedule continues */
const SETTLE_MS = 400;
/** every page opens at rest for at least this long before its first action:
 *  the render's establishing shot reads the page wide, and the first punch-in
 *  has time to arrive BEFORE the first click instead of chasing it */
const PRE_ROLL_MS = 1_000;
/** the pointer comes to rest on a target before pressing, and a press is
 *  held like a finger does — a zero-length press/release pair right at the
 *  end of the travel read as robotic */
const PRESS_SETTLE_MS = 100;
const PRESS_HOLD_MS = 70;
/** the beat after select-all and after delete when clearing a field: fixed,
 *  so a prefilled field never shifts the seeded rhythm of what follows */
const CLEAR_BEAT_MS = 120;

/**
 * CDP screencast is change-driven: a static page produces NO compositor
 * commits, so capture collapses to a few fps and the renderer stretches one
 * frame across seconds. This rAF beacon — a 1×1px fixed corner element on its
 * own compositor layer, toggling between two sub-perceptual opacities — forces
 * one commit per display frame. It covers the WHOLE viewport at 1-2e-4
 * opacity: a 1px corner beacon stopped registering damage in some page states
 * (a hovered, transformed row plus a timer re-setting identical text dropped
 * the source to the timer's 20Hz), while full-viewport damage always
 * captures. 2e-4 alpha moves no 8-bit channel by even half a level, so the
 * frames are pixel-identical to the page; pointer-events:none + fixed
 * positioning means it can never interfere with hit-testing or layout.
 * Injected as an init script so it survives full navigations; the rAF loop
 * itself survives SPA route changes.
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
        el.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;" +
          "pointer-events:none;z-index:2147483647;background:#000;opacity:0.0001;" +
          "will-change:opacity;contain:strict";
        root.appendChild(el);
      }
    }
    if (el) {
      flip = !flip;
      el.style.opacity = flip ? "0.0002" : "0.0001";
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
  /** Allow localhost/RFC1918/link-local navigation. Defaults to FALSE: the
   *  library fails closed and callers opt in. Every caller in this repo
   *  (generate(), the CLI) passes the value explicitly — the CLI allows by
   *  default and --block-private-network opts the guard in — so the default
   *  exists only for external embedders, and for them the safe direction is
   *  closed (matching crawlApp()'s default). With the guard on, the recipe's
   *  URLs are policy-checked, the target hosts are DNS resolve-and-pinned,
   *  and every in-flight request is gated. */
  allowPrivateNetwork?: boolean;
}

export interface RecordResult {
  eventLog: EventLog;
  frameCount: number;
  /** frames captured per second of take time (frame + event span). ~60 on a
   *  healthy beacon-era capture; near zero when the screencast starved. */
  avgSourceFps: number;
  failedScenes: string[];
  /** why each failed scene failed, by scene name (a dependency cascade
   *  names the scene it depended on) */
  sceneErrors: Record<string, string>;
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

/** a scene entry answered with an HTTP error is not the app: most often the
 *  app is not running at that URL, or another server holds the port */
function entryPageError(url: string, response: Response | null): string | undefined {
  const status = response?.status() ?? 0;
  if (status < 400) return undefined;
  return `entry page ${url} returned ${status}; is your app running there, and is something else using that port?`;
}

/** same document URL (normalized; a differing fragment still counts as a
 *  different entry, so the recipe's explicit navigation is honoured) */
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

function stripFragment(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.href;
  } catch {
    return u;
  }
}

/** origin + path: what an SPA route change changes (query and hash do not) */
function pathOf(u: string): string {
  try {
    const url = new URL(u);
    return url.origin + url.pathname;
  } catch {
    return u;
  }
}

// Navigate robustly. Waiting for "load" hangs on apps that pull heavy subresources
// from a CDN (e.g. the Pandora demo's d3 bundle) or hold an open connection — the
// 10s budget blew on a page whose `load` only fired at ~12s, even though the DOM
// was interactive almost immediately. So: resolve on "domcontentloaded" (DOM parsed
// + scripts available), then give the full `load` a best-effort grace window but
// never fail on it. SETTLE_MS after this lets first paints land. Returns the nav
// response so callers can re-check the final URL against the SSRF policy.
async function gotoReady(page: Page, url: string) {
  // guard ON: a redirected navigation first lands on the gate's stub, which
  // replaces itself with the target — wait for the real document
  const response = await settleGatedRedirect(
    page,
    await page.goto(url, { timeout: ACTION_TIMEOUT_MS, waitUntil: "domcontentloaded" }),
    { timeout: ACTION_TIMEOUT_MS, waitUntil: "domcontentloaded" },
  );
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

  // guard ON: resolve-and-pin every recipe host so the browser connects to the
  // exact IPs the policy vetted — a DNS re-resolve mid-run can't swap in a
  // private one (same defense the crawler applies).
  // Note: this re-resolves hosts that assertRecipeNavigationPolicy above
  // already resolved — a second lookup and a small TOCTOU window between the
  // two. Deliberate: the assert is a pure yes/no policy check, the pin is the
  // one whose answer the browser actually connects to, and collapsing them
  // would couple the policy module to Chromium launch-arg formatting.
  const launchArgs: string[] = [];
  if (!allowPrivateNetwork) {
    const rules: string[] = [];
    const seenHosts = new Set<string>();
    const recipeUrls: string[] = [];
    for (const scene of recipe.scenes) {
      recipeUrls.push(scene.entry.url);
      for (const action of [...scene.entry.prelude, ...scene.actions]) {
        if (action.kind === "goto" && action.url) recipeUrls.push(action.url);
      }
    }
    for (const u of recipeUrls) {
      const host = new URL(u).hostname;
      if (seenHosts.has(host)) continue;
      seenHosts.add(host);
      const pinned = await resolveAndPinHost(u, { allowPrivateNetwork });
      if (pinned) rules.push(pinned.hostResolverRule);
    }
    if (rules.length > 0) launchArgs.push(`--host-resolver-rules=${rules.join(",")}`);
  }

  // launch is the only setup outside try/finally; everything else (newPage,
  // CDP session) lives inside so a setup failure can't leak the browser
  const browser = await chromium.launch({ headless: true, args: launchArgs });

  const events: KnownEvent[] = [];
  const pathPoints: [number, number, number][] = []; // [t, x, y] global cursor track
  const frameIndex: FrameIndexEntry[] = [];
  let firstFrameStamp = -1;
  let frameCounter = 0;
  /** the last frame written to disk: an identical next frame reuses its file */
  let lastFrame: { hash: string; file: string } | undefined;
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
  /** guard ON only: the policy gate, and what it refused */
  let gate: RequestGate | undefined;
  let gated: GatedContext | undefined;
  let blockedSeen = 0;

  /**
   * Guard ON: after each action, refuse to keep filming if the action led the
   * page somewhere the policy forbids — a click or submit whose navigation
   * (or any redirect hop of it) the gate blocked leaves an error page, and a
   * page that settled on a non-http(s) or private URL is not the product.
   * Throwing fails the scene through the normal scene-failure path.
   */
  async function assertPagePolicy(): Promise<void> {
    if (allowPrivateNetwork) return;
    const blocked = gated?.blockedNavigations ?? [];
    if (blocked.length > blockedSeen) {
      const url = blocked[blocked.length - 1];
      blockedSeen = blocked.length;
      throw new Error(`navigation to ${url} was blocked by the private-network policy`);
    }
    const current = page.url();
    if (gate && current !== "about:blank" && !(await gate.allows(current))) {
      throw new Error(`the page left the allowed network: ${current}`);
    }
  }

  /** capture timeline started (events may be stamped) */
  let capturing = false;
  /** the page may hold state a fresh load would not: something was clicked,
   *  typed or navigated since the last entry load, or a scene failed partway.
   *  Hover, scroll and wait leave it clean. */
  let pageDirty = false;

  /** schedule clock (paces slots + budget); wall anchor shared with frame t_source */
  let clock = 0;
  let wallStart = 0;
  const cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height - 100 }; // parked off-content
  const failedScenes: string[] = [];
  const sceneErrors: Record<string, string> = {};
  let aborted = false;

  /** record a failed scene and say why; true when the take stops (the
   *  opening scene failed, or more than half the scenes are lost) */
  function failScene(name: string, reason: string, opening: boolean): boolean {
    failedScenes.push(name);
    sceneErrors[name] = reason;
    const lost = `${failedScenes.length}/${recipe.scenes.length} scenes lost`;
    if (opening || failedScenes.length > recipe.scenes.length / 2) {
      aborted = true;
      console.error(`abort: scene "${name}" failed (${reason}); ${lost}`);
      return true;
    }
    console.error(`scene "${name}" failed (${reason}); continuing, ${lost}`);
    return false;
  }

  const observedNow = () => Date.now() - wallStart;
  /** monotonic stamp: event `t` rides the observed clock; sleep/rounding jitter
   *  of a few ms must never produce an out-of-order timeline */
  let lastStampT = 0;
  const stamp = (t: number): number => (lastStampT = Math.max(lastStampT, t));

  /** guard ON: URLs (fragment stripped) the request gate answered with its
   *  redirect stub; the stub and the document replacing it are one change */
  const gatedStubs = new Set<string>();
  /**
   * Every page change while filming is logged: a scene entry as its `scene`
   * event (its whole window, settle included, is suppressed below), anything
   * else (a clicked link, a submit, a goto, a page redirecting itself, an
   * SPA route change) as a `navigation` event.
   */
  const navLog = new NavigationLog({
    events,
    stamp,
    raiseFloor: (t) => { lastStampT = Math.max(lastStampT, t); },
    isGatedStub: (url) => gatedStubs.has(stripFragment(url)),
  });

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
    if (!alreadyInView) {
      // an eased page scroll that centres the target, filmed as motion — an
      // instant scrollIntoView reads as a jump cut in the middle of a shot
      await loc
        .evaluate(async (el) => {
          const r = el.getBoundingClientRect();
          const root = document.scrollingElement ?? document.documentElement;
          const startY = window.scrollY;
          const maxY = Math.max(0, root.scrollHeight - window.innerHeight);
          const targetY = Math.max(0, Math.min(maxY, startY + r.top + r.height / 2 - window.innerHeight / 2));
          const dist = targetY - startY;
          if (Math.abs(dist) < 1) return;
          const dur = Math.min(900, Math.max(350, Math.abs(dist) * 0.5));
          const ease = (q: number) => (q < 0.5 ? 4 * q * q * q : 1 - (-2 * q + 2) ** 3 / 2);
          await new Promise<void>((done) => {
            const t0 = performance.now();
            const step = (now: number) => {
              const q = Math.min(1, (now - t0) / dur);
              // "instant": a page-level `scroll-behavior: smooth` must not
              // turn every step into its own competing animation
              window.scrollTo({ left: window.scrollX, top: startY + dist * ease(q), behavior: "instant" });
              if (q < 1) requestAnimationFrame(step);
              else done();
            };
            requestAnimationFrame(step);
          });
        })
        .catch(() => {});
    }
    // backstop (a target inside a nested scroll container the page scroll
    // cannot reach): a no-op when the eased scroll already revealed it
    await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    // settle ONLY when a scroll actually happened — an unconditional sleep adds
    // wall-time to every action, tipping in-view actions into the overrun path
    // and breaking the scheduled-timeline determinism contract on fixtures
    if (!alreadyInView) await sleep(150);
    const box = await loc.boundingBox();
    if (!box) throw new Error(`selector "${selector}" has no bounding box`);
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  }

  /** the focused element (through open shadow roots) is a text field or an
   *  editable region that already holds text */
  async function focusedFieldHasText(): Promise<boolean> {
    return page
      .evaluate(() => {
        let el: Element | null = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.length > 0;
        return el instanceof HTMLElement && el.isContentEditable && (el.textContent ?? "").length > 0;
      })
      .catch(() => false);
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
    // this action's own event: the latest interaction event (a navigation the
    // action triggered may have been logged after it)
    let ev: KnownEvent | undefined;
    for (let i = events.length - 1; i >= 0 && !ev; i--) {
      const e = events[i]!;
      if (e.type === "click" || e.type === "type" || e.type === "hover") ev = e;
      else if (e.type !== "navigation") break;
    }
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
    if (a.kind === "click" || a.kind === "type" || a.kind === "goto") pageDirty = true;

    switch (a.kind) {
      case "goto": {
        if (!a.url) throw new Error("goto action requires url");
        await assertSafeNavigationUrl(a.url, { allowPrivateNetwork });
        // a mid-scene goto is filmed (no frame suppression), so its commit is
        // logged as a navigation like any other page change
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
        if (a.kind === "click" || a.kind === "type") await sleep(PRESS_SETTLE_MS);
        const dispatchT = observedNow();

        if (a.kind === "click" || a.kind === "type") {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1,
          });
          await sleep(PRESS_HOLD_MS);
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
          const keys = graphemes(text);
          const remaining = Math.max(200, a.duration_ms - (observedNow() - scheduledT));
          // human rhythm: a beat after the focusing click, log-normal gaps
          // around ~100ms (longer after spaces/punctuation, never under 45ms),
          // a beat before Enter. A slot too short for this overruns and the
          // schedule shifts (timestamp canon) — never a pasted-in string.
          const rhythm = typingPlan(text, remaining, rng);
          await sleep(rhythm.beforeFirstKey);
          // the action types `text` into the field, not after what was there:
          // select-all then delete, as real keys, so the app sees an edit
          if (await focusedFieldHasText()) {
            await page.keyboard.press("ControlOrMeta+a");
            await sleep(CLEAR_BEAT_MS);
            await page.keyboard.press("Backspace");
            await sleep(CLEAR_BEAT_MS);
          }
          // real key events (keydown, keypress, input, keyup) per grapheme, so
          // keyup-driven autocomplete, masks and hotkeys react as they do to a
          // person. keyboard.type presses a single character the layout has
          // and inserts it otherwise; a multi-code-point grapheme (an emoji
          // sequence, a combining mark) goes in as one insert.
          for (const [i, g] of keys.entries()) {
            if ([...g].length === 1) await page.keyboard.type(g);
            else await page.keyboard.insertText(g);
            if (i < keys.length - 1) await sleep(rhythm.keyDelays[i]!);
          }
          events.push({
            t: stamp(observedNow()), observed_t: observedNow(), type: "type",
            bbox: [box.x, box.y, box.w, box.h], selector: a.selector,
            textLen: keys.length,
          });
          if (a.submit) {
            // Many query inputs only reveal their payoff on submit (a form's
            // submit handler / an Enter keydown). Typing alone leaves the app in
            // its idle state — the video would show a filled box and no result.
            await sleep(rhythm.beforeEnter);
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
    // guard ON: service workers are blocked — a registered worker's fetches
    // are not routed through the context, which would hand the page an
    // ungated network channel
    page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: DPR,
      ...(allowPrivateNetwork ? {} : { serviceWorkers: "block" as const }),
    });
    // guard ON: gate EVERY in-flight request (clicked links, Enter submits,
    // subresources) and every redirect hop of each — assertSafeNavigationUrl
    // only covers entry/goto URLs known from the recipe, but a click on an
    // a[href] or a submit navigates with no pre-check. Installed ONLY when the
    // guard is engaged: route interception funnels every request through
    // Node, and the default local-app path must not pay that tax during a
    // 60fps capture.
    if (!allowPrivateNetwork) {
      gate = createRequestGate({ allowPrivateNetwork });
      gated = await installRequestGate(page.context(), gate);
      // WebSocket upgrades bypass ctx.route — gate them separately
      if (!(await gateWebSockets(page.context(), gate))) {
        console.error(
          "warning: this Playwright build lacks routeWebSocket — WebSocket connections are NOT policy-checked",
        );
      }
    }
    if (captureFrames) await page.addInitScript(REPAINT_BEACON_SCRIPT);
    await page.addInitScript(MUTATION_OBSERVER_SCRIPT);
    cdp = await page.context().newCDPSession(page);

    // page changes come from the browser's own commit events, which say
    // whether a new document committed (Page.frameNavigated) or the URL
    // changed within the document (Page.navigatedWithinDocument). A request
    // that never commits (204, download, abort) produces neither, so it can
    // leave nothing behind. A scene entry is suppressed for its whole window:
    // its `scene` event is the page change.
    if (!allowPrivateNetwork) {
      page.on("response", (res) => {
        if (res.headers()[GATED_REDIRECT_HEADER] !== undefined) gatedStubs.add(stripFragment(res.url()));
      });
    }
    await cdp.send("Page.enable");
    let mainFrameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
    let mainUrl = "";
    const logging = () => capturing && !isNavigating;
    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (frame.parentId) return;
      mainFrameId = frame.id;
      mainUrl = frame.url;
      if (logging()) navLog.commit("document", observedNow(), frame.url);
    });
    cdp.on("Page.navigatedWithinDocument", ({ frameId, url }) => {
      if (frameId !== mainFrameId) return;
      const from = mainUrl;
      mainUrl = url;
      // a hash jump or a query-only pushState (a filter, a tab) is the same
      // page; only a new path is a route change
      if (logging() && pathOf(from) !== pathOf(url)) navLog.commit("spa", observedNow(), url);
    });

    if (captureFrames) {
      // ack-AFTER-write: Chromium won't send the next frame until we ack, so
      // awaiting the disk write before acking gives true backpressure (one
      // write in flight) and a failed write can never be silently indexed
      const handleFrame = async (
        ev: { data: string; sessionId: number; metadata: { timestamp?: number } },
        dropping: boolean,
      ): Promise<void> => {
        // drop blank frames captured mid-navigation (the scene-change flash)
        if (dropping) {
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
        try {
          const bytes = Buffer.from(ev.data, "base64");
          const hash = createHash("sha1").update(bytes).digest("base64");
          // the beacon forces a commit every display frame, so most frames of
          // a still page are byte-identical: write each distinct picture once
          // and point the repeated index entries at that file
          let file = lastFrame?.hash === hash ? lastFrame.file : undefined;
          if (!file) {
            file = `frames/${String(frameCounter++).padStart(6, "0")}.jpg`;
            await writeFile(join(outDir, file), bytes);
            lastFrame = { hash, file };
          }
          // clamp: delivery jitter can hand us a frame stamped a hair BEFORE
          // the first-processed frame; a negative t_source would sort to
          // entry 0 and fail render-plan validation
          frameIndex.push({ file, t_source: Math.max(0, stampMs - firstFrameStamp) });
          if (wallStart > 0) navLog.frame(stampMs - wallStart, hash);
        } catch {
          writeErrors++;
        } finally {
          await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
        }
      };
      cdp.on("Page.screencastFrame", (ev) => {
        // CHAIN, never replace: if Chromium ever has >1 unacked frame in
        // flight, replacing lastWrite would let the finalize await miss an
        // earlier in-flight write and drop its frame from the index. The
        // isNavigating flag is sampled at event time (its capture semantics),
        // and per-frame failures never poison the chain (writeErrors counts).
        const dropping = isNavigating;
        lastWrite = lastWrite.then(() => handleFrame(ev, dropping)).catch(() => {});
      });
    }

    // navigate to first scene's entry before starting capture, so frame 0 is content
    const firstScene = recipe.scenes[0];
    if (!firstScene) throw new Error("recipe has no scenes");
    await assertSafeNavigationUrl(firstScene.entry.url, { allowPrivateNetwork });
    const firstResponse = await gotoReady(page, firstScene.entry.url);
    await assertSafeNavigationUrl(firstScene.entry.url, { allowPrivateNetwork, finalUrl: firstResponse?.url() ?? page.url() });
    // an error page is not worth filming: the opening scene fails and the
    // take ends before the screencast starts
    const firstEntryError = entryPageError(firstScene.entry.url, firstResponse);
    if (firstEntryError) failScene(firstScene.name, firstEntryError, true);
    else await sleep(SETTLE_MS); // `load` ≠ ready: let hydration/fonts/paints settle

    if (captureFrames && !aborted) {
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: JPEG_QUALITY,
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

    capturing = !aborted;
    // pre-roll: the opening page at rest before anything moves
    if (capturing) {
      const wait = PRE_ROLL_MS - observedNow();
      if (wait > 0) await sleep(wait);
      clock = stamp(Math.max(PRE_ROLL_MS, ceilToFrame(observedNow())));
    }

    for (let i = 0; i < recipe.scenes.length && !aborted; i++) {
      const scene: Scene = recipe.scenes[i]!;

      // dependency cascade: parent failed → this scene dies with it
      const failedParent = scene.depends_on.find((d) => failedScenes.includes(d));
      if (failedParent !== undefined) {
        if (failScene(scene.name, `depends on failed scene "${failedParent}"`, false)) break;
        continue;
      }

      events.push({ t: stamp(clock), observed_t: observedNow(), type: "scene", name: scene.name, priority: scene.priority });
      // a block that already failed an earlier scene must not fail this one
      blockedSeen = gated?.blockedNavigations.length ?? 0;

      try {
        if (i > 0) {
          await assertSafeNavigationUrl(scene.entry.url, { allowPrivateNetwork });
          // every scene is written as if it opens on a freshly loaded entry
          // page. When the browser already shows that exact page and nothing
          // since its load changed state (hover, scroll and wait only), the
          // reload is skipped: it would only add a freeze and a flash of the
          // same page. Typed text, a selection, an open modal, or a failed
          // scene's leftovers all force the reload.
          const alreadyThere = !pageDirty && sameUrl(page.url(), scene.entry.url);
          if (!alreadyThere) {
            // suppress capture across the reload so the blank page never lands in
            // the footage (the scene-change flash); resume once it has painted.
            // The same window suppresses navigation logging: every commit in it
            // is this scene's entry, which its `scene` event already marks.
            // MUST reset in finally: if gotoReady/assert throws, leaving this true
            // would make the screencast handler drop EVERY subsequent frame and
            // freeze the rest of the video on the previous scene.
            isNavigating = true;
            try {
              const response = await gotoReady(page, scene.entry.url);
              await assertSafeNavigationUrl(scene.entry.url, { allowPrivateNetwork, finalUrl: response?.url() ?? page.url() });
              const entryError = entryPageError(scene.entry.url, response);
              if (entryError) throw new Error(entryError);
              await sleep(SETTLE_MS);
              pageDirty = false;
            } finally {
              isNavigating = false;
            }
          }
          // Timestamp canon: when nav finishes early, dwell out the unused
          // allowance in WALL time so pixels and schedule stay in lockstep —
          // advancing only the clock made the footage run ~1s ahead of every
          // logged event after a fast local navigation. The new page (its
          // first captured frame is at navEnd) also gets its pre-roll.
          const navEnd = observedNow();
          const target = Math.max(clock + ENTRY_NAV_ALLOWANCE_MS, navEnd + PRE_ROLL_MS);
          await sleep(target - navEnd);
          clock = stamp(ceilToFrame(target));
        }
        for (const a of [...scene.entry.prelude, ...scene.actions]) {
          await runAction(a);
          await assertPagePolicy();
        }
        // Hold the scene's final frame; it is validated and budgeted by the schema.
        if (scene.hold_ms > 0) {
          await sleep(scene.hold_ms);
          clock = stamp(clock + scene.hold_ms);
          await assertPagePolicy();
        }
      } catch (err) {
        pageDirty = true;
        if (failScene(scene.name, err instanceof Error ? err.message : String(err), i === 0)) break;
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
    // clock declaration (schema): event `t` shares the frame t_source timeline.
    // The render stage keys its skew/health gates off this marker — never off
    // the capture's frame rate — so a starved take can't pass as "legacy".
    t_source_unified: true,
    // navigation declaration (schema): every page change while filming is a
    // `scene` event (scene entries) or a `navigation` event (everything
    // else), so the renderer may read an unexplained frame gap as a stall
    navigation_logged: true,
    failed_scenes: [...failedScenes],
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

  // capture-health telemetry: frames per second of take time. The span uses
  // BOTH clocks (last frame t_source and last event t) so a capture that
  // stalled early — few frames, but a long event timeline — reads as sparse
  // instead of hiding behind its own short frame span.
  let maxEventT = 0;
  for (const e of events) maxEventT = Math.max(maxEventT, e.t);
  const lastFrameT = frameIndex.length ? frameIndex[frameIndex.length - 1]!.t_source : 0;
  const spanMs = Math.max(lastFrameT, maxEventT);
  const avgSourceFps = spanMs > 0 ? (frameIndex.length / spanMs) * 1000 : 0;

  return { eventLog, frameCount: frameIndex.length, avgSourceFps, failedScenes, sceneErrors, aborted, outDir };
}
