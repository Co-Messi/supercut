/**
 * Page digest + selector inventory — the director's anti-hallucination
 * backbone. The script LLM may ONLY use selectors from this inventory
 * (enforced in script.ts), so a hallucinated selector is impossible by
 * construction: it fails the whitelist check and bounces back for retry.
 */
import { chromium, type Browser, type Page } from "playwright";

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

export interface PageDigest {
  url: string;
  title: string;
  headings: string[];
  inventory: InventoryItem[];
  /** viewport screenshot for the analyze stage's vision pass */
  screenshotB64?: string;
}

const cssEscape = (s: string) => s.replace(/["\\]/g, "\\$&");

// links the crawler must NOT navigate to: file downloads (PDF/zip/images/docs),
// and non-http protocols. Navigating to a PDF triggers a download that crashes
// page.goto (found on a real run, 2026-06-12).
const NON_HTML_EXT =
  /\.(pdf|zip|tar|gz|dmg|exe|pkg|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|svg|webp|mp4|mov|webm|mp3|wav|woff2?|ttf)$/i;

function isCrawlable(u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (NON_HTML_EXT.test(u.pathname)) return false;
  return true;
}

async function digestPage(page: Page, withScreenshot: boolean): Promise<PageDigest> {
  const title = await page.title();

  const headings: string[] = [];
  const hs = page.locator("h1, h2, h3");
  const hCount = Math.min(await hs.count(), 10);
  for (let i = 0; i < hCount; i++) {
    const t = (await hs.nth(i).innerText().catch(() => "")).trim().replace(/\s+/g, " ");
    if (t) headings.push(t.slice(0, 120));
  }

  const inventory: InventoryItem[] = [];
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
    const href = (await el.getAttribute("href").catch(() => null)) ?? undefined;
    const text = (
      (await el.innerText().catch(() => "")) ||
      (await el.textContent().catch(() => "")) ||
      placeholder || aria || ""
    ).trim().replace(/\s+/g, " ").slice(0, 80);

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
      // pick the CLOSEST nth-match (PR #2 review: a strict ±2px test can miss
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

  let screenshotB64: string | undefined;
  if (withScreenshot) {
    const shot = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
    if (shot) screenshotB64 = shot.toString("base64");
  }

  return { url: page.url(), title, headings, inventory, ...(screenshotB64 ? { screenshotB64 } : {}) };
}

/**
 * Crawl the live app: digest the start page, then up to `maxPages - 1`
 * same-origin pages discovered from its links.
 */
export async function crawlApp(
  appUrl: string,
  opts: { maxPages?: number; screenshots?: boolean } = {},
): Promise<PageDigest[]> {
  const maxPages = opts.maxPages ?? 3;
  const screenshots = opts.screenshots ?? true;
  const origin = new URL(appUrl).origin;

  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const digests: PageDigest[] = [];
    const visited = new Set<string>();

    // block downloads outright so a stray file link can't hang/crash the crawl
    const ctx = page.context();
    await ctx.route("**/*", async (route) => {
      const u = route.request().url();
      try {
        if (route.request().isNavigationRequest() && NON_HTML_EXT.test(new URL(u).pathname)) {
          return route.abort();
        }
      } catch { /* fall through */ }
      return route.continue();
    });

    const queue = [appUrl];
    while (queue.length > 0 && digests.length < maxPages) {
      const target = queue.shift()!;
      // pathname + search (PR #2 review): pathname-only collapses query-routed
      // pages (/search?q=a vs ?q=b) and SPA filter/detail views, so the crawler
      // would skip real money-moment pages. Hash is excluded (same document).
      const u = new URL(target);
      const key = u.pathname + u.search;
      if (visited.has(key)) continue;
      visited.add(key);

      // a single bad page (download, timeout, redirect off-origin) must not
      // kill the whole crawl — skip it and keep going
      try {
        await page.goto(target, { timeout: 15_000, waitUntil: "load" });
        await page.waitForTimeout(400); // settle: load ≠ ready
      } catch (err) {
        if (digests.length === 0 && queue.length === 0) throw err; // start page must load
        continue;
      }
      const digest = await digestPage(page, screenshots);
      digests.push(digest);

      for (const item of digest.inventory) {
        if (!item.href) continue;
        try {
          const linked = new URL(item.href, target);
          if (linked.origin === origin && isCrawlable(linked) && !visited.has(linked.pathname + linked.search)) {
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
