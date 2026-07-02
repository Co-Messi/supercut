/**
 * Page digest + selector inventory — the director's anti-hallucination
 * backbone. The script LLM may ONLY use selectors from this inventory
 * (enforced in script.ts), so a hallucinated selector is impossible by
 * construction: it fails the whitelist check and bounces back for retry.
 */
import { chromium, type Browser, type Page } from "playwright";
import { assertSafeNavigationUrl, navigationRequestAllowed, resolveAndPinHost } from "../security/url-policy.js";

export interface InventoryItem {
  /** Playwright-compatible selector, verified to resolve on the page */
  selector: string;
  tag: string;
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
  href?: string;
  /** present in DOM but not visible yet (modal, reveal-on-click form) —
   *  usable ONLY after an earlier action in the same scene reveals it */
  hidden?: boolean;
}

/** A large, stable container the camera can FRAME to show a result (a graph,
 *  a results list, a detail panel). Not part of the interactable whitelist —
 *  these are camera targets (focus_selector), not click targets. The payoff of
 *  most apps appears INSIDE one of these after an action, so framing it is how
 *  the video holds on the result instead of the input box that produced it. */
export interface RegionItem {
  selector: string;
  tag: string;
  text: string;
  bbox: { x: number; y: number; w: number; h: number };
}

export interface PageDigest {
  url: string;
  title: string;
  headings: string[];
  inventory: InventoryItem[];
  /** framable result/content regions (focus_selector candidates) */
  regions: RegionItem[];
  /** labels of destructive controls excluded from the inventory (fail-safe) —
   *  surfaced so the exclusion is LOUD, never silent. Empty/absent when none. */
  excludedDestructive?: string[];
  /** viewport screenshot for the analyze stage's vision pass */
  screenshotB64?: string;
}

const cssEscape = (s: string) => s.replace(/["\\]/g, "\\$&");

/**
 * Fail-safe-by-default destructive-action lexicon. The director scripts clicks
 * and typing on the LIVE app, so a prompt-injected page (or just an unlucky
 * "payoff" beat) could fire a real, irreversible action. We exclude any element
 * whose visible text / aria-label / value matches this from the inventory
 * entirely — so the LLM never even SEES a destructive control and structurally
 * cannot reference one (the script stage may only use inventory selectors).
 * Opt back in with `allowDestructive`. Word-boundary anchored so legitimate
 * non-destructive actions (Sign in, Submit, Add, Save, Open, View, Create,
 * Next, Continue) do NOT match.
 *
 * HONESTY: this filter is BEST-EFFORT and English-only. It matches visible
 * text / aria-label / value strings — it cannot catch icon-only controls,
 * non-English labels, or custom wording. Never rely on it as the only guard:
 * film against a disposable/staging environment, not production data.
 */
// Lexicon criterion: match a verb when firing it by accident on a live app is
// costly (loses data/state/access, moves money, goes public) even if some
// apps use it reversibly — false-drop is loud (logged with an opt-in flag),
// false-fire is a real mutation. We still do NOT match the hero-action words
// that carry most demos (send, save, submit, search, publish-adjacent create):
// silently dropping a chat app's "Send" would gut the video.
export const DESTRUCTIVE_RE =
  /\b(delete|remove|reset|deactivate|disable|archive|erase|wipe|destroy|unsubscribe|close\s+account|cancel\s+(subscription|account|plan)|pay|purchase|buy\s+now|checkout|place\s+order|withdraw|confirm\s+(payment|order)|revoke|publish|transfer\s+(funds|money|ownership|account|domain)|regenerate|suspend|terminate|downgrade)\b/i;

// links the crawler must NOT navigate to: file downloads (PDF/zip/images/docs),
// and non-http protocols. Navigating to a PDF triggers a download that crashes
// page.goto.
const NON_HTML_EXT =
  /\.(pdf|zip|tar|gz|dmg|exe|pkg|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|svg|webp|mp4|mov|webm|mp3|wav|woff2?|ttf)$/i;

function isCrawlable(u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (NON_HTML_EXT.test(u.pathname)) return false;
  return true;
}

/**
 * Collect framable result/content regions: large, visible containers (a chart
 * area, a results list, the main panel) the camera can hold on to show a
 * payoff. These are NOT click targets — they widen the director's camera
 * vocabulary so a scene can frame the RESULT, not the input that produced it.
 */
async function collectRegions(page: Page): Promise<RegionItem[]> {
  // id'd containers come first (stable selector); then structural landmarks and
  // visual surfaces (svg/canvas) where charts/maps/graphs render.
  const els = page.locator(
    "main, [role=main], [role=region], section[id], [id] > svg, svg[id], canvas, " +
      "div[id]",
  );
  const count = Math.min(await els.count(), 40);
  const out: RegionItem[] = [];
  const seen = new Set<string>();
  // a region must be a meaningful share of the viewport to be worth framing
  const MIN_AREA = 1280 * 800 * 0.12;
  for (let i = 0; i < count; i++) {
    const el = els.nth(i);
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width * box.height < MIN_AREA) continue;
    const tag = (await el.evaluate((n) => n.tagName).catch(() => "")).toLowerCase();
    if (!tag) continue;
    const id = await el.getAttribute("id").catch(() => null);
    const role = await el.getAttribute("role").catch(() => null);
    let selector: string;
    if (id) selector = `#${id}`;
    else if (tag === "main") selector = "main";
    else if (role) selector = `[role="${cssEscape(role)}"]`;
    else continue; // no stable handle — skip
    if (seen.has(selector)) continue;
    // must resolve uniquely so the camera frames the right box at capture time
    const matches = await page.locator(selector).count().catch(() => 0);
    if (matches !== 1) continue;
    seen.add(selector);
    const text = (await el.innerText().catch(() => "")).trim().replace(/\s+/g, " ").slice(0, 60);
    out.push({ selector, tag, text, bbox: { x: box.x, y: box.y, w: box.width, h: box.height } });
  }
  // biggest first — the dominant content area is usually the intended payoff
  return out.sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h).slice(0, 6);
}

async function digestPage(page: Page, withScreenshot: boolean, allowDestructive = false): Promise<PageDigest> {
  const title = await page.title();

  const headings: string[] = [];
  const hs = page.locator("h1, h2, h3");
  const hCount = Math.min(await hs.count(), 10);
  for (let i = 0; i < hCount; i++) {
    const t = (await hs.nth(i).innerText().catch(() => "")).trim().replace(/\s+/g, " ");
    if (t) headings.push(t.slice(0, 120));
  }

  const inventory: InventoryItem[] = [];
  const excludedDestructive: string[] = [];
  const seen = new Set<string>();
  const els = page.locator(
    "a[href], button, input, textarea, select, [role=button], [role=tab], " +
      // clickable-without-semantics patterns real apps are full of:
      "[role=menuitem], [role=link], [onclick], li[id], tr[id], [data-testid]",
  );
  const count = Math.min(await els.count(), 60);
  for (let i = 0; i < count; i++) {
    const el = els.nth(i);
    const box = await el.boundingBox().catch(() => null);
    // hidden elements (reveal-on-click forms, modals) stay in the inventory,
    // flagged — the capture executor waits for visibility at action time, so
    // a prior revealing action makes them targetable
    const hidden = !box || box.width < 4 || box.height < 4;

    const tag = (await el.evaluate((n) => n.tagName).catch(() => "")).toLowerCase();
    if (!tag) continue;
    const id = await el.getAttribute("id").catch(() => null);
    const aria = await el.getAttribute("aria-label").catch(() => null);
    const placeholder = await el.getAttribute("placeholder").catch(() => null);
    const value = await el.getAttribute("value").catch(() => null);
    const href = (await el.getAttribute("href").catch(() => null)) ?? undefined;
    const text = (
      (await el.innerText().catch(() => "")) ||
      (await el.textContent().catch(() => "")) ||
      placeholder || aria || ""
    ).trim().replace(/\s+/g, " ").slice(0, 80);

    // fail-safe: never put a destructive/irreversible control into the inventory
    // (so the director can't script a click/type on it) unless explicitly opted
    // in. Checks visible text, aria-label, and value (input buttons).
    if (!allowDestructive && [text, aria, value].some((s) => s && DESTRUCTIVE_RE.test(s))) {
      if (text) excludedDestructive.push(text);
      continue;
    }

    let selector: string;
    if (id) selector = `#${id}`;
    else if (aria) selector = `[aria-label="${cssEscape(aria)}"]`;
    else if (placeholder) selector = `[placeholder="${cssEscape(placeholder)}"]`;
    else if (text) selector = `${tag}:has-text("${cssEscape(text.slice(0, 40))}")`;
    else continue; // nothing stable to target — skip rather than guess

    // verify the selector actually resolves to THIS kind of element, and
    // disambiguate duplicates with :nth-match
    const matches = await page.locator(selector).count().catch(() => 0);
    if (matches === 0) continue;
    if (matches > 1) {
      if (!box) continue; // can't disambiguate a hidden duplicate — skip, don't guess
      // Pick the closest nth-match; a strict ±2px test can miss
      // on sub-pixel rendering and silently fall back to nth=1 = wrong element).
      // Cap the accepted distance so we never inventory a wildly-off element.
      const MAX_OFFSET_PX = 20;
      let bestNth = -1;
      let bestDist = Infinity;
      for (let k = 1; k <= matches; k++) {
        const b = await page.locator(`:nth-match(${selector}, ${k})`).boundingBox().catch(() => null);
        if (!b) continue;
        const d = Math.hypot(b.x - box.x, b.y - box.y);
        if (d < bestDist) { bestDist = d; bestNth = k; }
      }
      if (bestNth < 0 || bestDist > MAX_OFFSET_PX) continue; // no confident match — skip
      selector = `:nth-match(${selector}, ${bestNth})`;
    }

    if (seen.has(selector)) continue;
    seen.add(selector);
    inventory.push({
      selector, tag, text,
      bbox: box
        ? { x: box.x, y: box.y, w: box.width, h: box.height }
        : { x: 0, y: 0, w: 0, h: 0 },
      ...(href ? { href } : {}),
      ...(hidden ? { hidden: true } : {}),
    });
  }

  const regions = await collectRegions(page);

  let screenshotB64: string | undefined;
  if (withScreenshot) {
    const shot = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
    if (shot) screenshotB64 = shot.toString("base64");
  }

  return {
    url: page.url(), title, headings, inventory, regions,
    ...(excludedDestructive.length ? { excludedDestructive } : {}),
    ...(screenshotB64 ? { screenshotB64 } : {}),
  };
}

/**
 * Crawl the live app: digest the start page, then up to `maxPages - 1`
 * same-origin pages discovered from its links.
 */
export async function crawlApp(
  appUrl: string,
  opts: {
    maxPages?: number;
    screenshots?: boolean;
    allowPrivateNetwork?: boolean;
    /** source-derived routes to crawl FIRST (so real panels enter the
     *  inventory even when no link points to them) — see sourceRoutes.ts */
    seedUrls?: string[];
    /** opt-in: include destructive/irreversible controls (Delete, Pay, …) in
     *  the inventory. OFF by default — fail-safe so the director can't script a
     *  real harmful action on the live app. */
    allowDestructive?: boolean;
  } = {},
): Promise<PageDigest[]> {
  const maxPages = opts.maxPages ?? 3;
  const screenshots = opts.screenshots ?? true;
  const allowDestructive = opts.allowDestructive ?? false;
  const origin = new URL(appUrl).origin;
  const allowPrivateNetwork = opts.allowPrivateNetwork ?? false;
  await assertSafeNavigationUrl(appUrl, { allowPrivateNetwork });

  // guard ON: resolve-and-pin the target host so the browser connects to the
  // exact IP the policy vetted — a DNS re-resolve can't swap in a private one
  const launchArgs: string[] = [];
  if (!allowPrivateNetwork) {
    const pinned = await resolveAndPinHost(appUrl, { allowPrivateNetwork });
    if (pinned) launchArgs.push(`--host-resolver-rules=${pinned.hostResolverRule}`);
  }

  const browser: Browser = await chromium.launch({ headless: true, args: launchArgs });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const digests: PageDigest[] = [];
    const visited = new Set<string>();

    // block downloads outright so a stray file link can't hang/crash the crawl
    const ctx = page.context();
    await ctx.route("**/*", async (route) => {
      const u = route.request().url();
      try {
        if (route.request().isNavigationRequest()) {
          // guard ON: validate every navigation BEFORE the request leaves the
          // browser. The post-settle checks below only run AFTER Chromium has
          // already fetched a 302/meta/JS redirect target — this gate is what
          // stops the request to a private host from happening at all.
          if (!allowPrivateNetwork && !(await navigationRequestAllowed(u, { allowPrivateNetwork }))) {
            return route.abort();
          }
          if (NON_HTML_EXT.test(new URL(u).pathname)) {
            return route.abort();
          }
        }
      } catch { /* fall through */ }
      return route.continue();
    });

    // start page first, then source-derived routes (same-origin only), then
    // link-discovered pages. Seeds ensure functional panels get crawled even
    // when no <a href> points to them.
    const queue = [appUrl, ...(opts.seedUrls ?? []).filter((u) => {
      try { return new URL(u).origin === origin; } catch { return false; }
    })];
    while (queue.length > 0 && digests.length < maxPages) {
      const target = queue.shift()!;
      // Pathname + search: pathname-only collapses query-routed
      // pages (/search?q=a vs ?q=b) and SPA filter/detail views, so the crawler
      // would skip real money-moment pages. Hash is excluded (same document).
      const u = new URL(target);
      const key = u.pathname + u.search;
      if (visited.has(key)) continue;
      visited.add(key);

      // a single bad page (download, timeout, redirect off-origin) must not
      // kill the whole crawl — skip it and keep going
      try {
        await assertSafeNavigationUrl(target, { allowPrivateNetwork });
        const response = await page.goto(target, { timeout: 15_000, waitUntil: "load" });
        await assertSafeNavigationUrl(target, { allowPrivateNetwork, finalUrl: response?.url() ?? page.url() });
        await page.waitForTimeout(400); // settle: load ≠ ready
        // re-validate where the page SETTLED: a client-side redirect (JS,
        // meta-refresh) can land somewhere the pre-navigation check never saw
        await assertSafeNavigationUrl(target, { allowPrivateNetwork, finalUrl: page.url() });
      } catch (err) {
        if (digests.length === 0 && queue.length === 0) throw err; // start page must load
        continue;
      }
      const digest = await digestPage(page, screenshots, allowDestructive);
      digests.push(digest);

      for (const item of digest.inventory) {
        if (!item.href) continue;
        try {
          const linked = new URL(item.href, target);
          if (linked.origin === origin && isCrawlable(linked) && !visited.has(linked.pathname + linked.search)) {
            await assertSafeNavigationUrl(linked.href, { allowPrivateNetwork });
            queue.push(linked.href);
          }
        } catch {
          /* invalid href — skip */
        }
      }
    }
    return digests;
  } finally {
    await browser.close();
  }
}
