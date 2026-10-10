/**
 * Page digest + selector inventory — the director's anti-hallucination
 * backbone. The script LLM may ONLY use selectors from this inventory
 * (enforced in script.ts), so a hallucinated selector is impossible by
 * construction: it fails the whitelist check and bounces back for retry.
 */
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { assertSafeNavigationUrl, createRequestGate, gateWebSockets, resolveAndPinHost } from "../security/url-policy.js";
import { installRequestGate, settleGatedRedirect } from "../security/browser-gate.js";
import { redactForPrompt } from "../security/redaction.js";
import { isDestructiveLabel } from "../security/destructive.js";
import { isSameSite } from "../security/site.js";

/**
 * True when a page URL carries a secret (token/key/JWT) in its path or query.
 * A crawled URL is a validation KEY the director must echo back verbatim, so it
 * can't be redacted in the prompt — instead we drop the whole page (never film a
 * page whose URL is itself a credential), so the secret never egresses.
 */
export function pageUrlHasSecret(url: string): boolean {
  return redactForPrompt(url) !== url;
}

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
  /** a text field whose form submits through a destructive control (its
   *  default submit button, or its action URL, matches the policy): it may
   *  be typed into, but a `type` with `submit: true` is refused, because
   *  Enter would press that control */
  submitsDestructive?: boolean;
  /** an <input>'s type attribute (text when absent); lets the crawl tell a
   *  sign-in form (a password field) from the app */
  inputType?: string;
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
  /** effective page background tone — grounds the director's vibe/music
   *  choices even when the model is text-only (no screenshots). Optional so
   *  hand-built digests stay valid; the crawler always sets it. */
  theme?: "dark" | "light";
  /** accent hint: the first visible button's background color, when one has a
   *  real (non-transparent) background. Advisory only. */
  accentColor?: string;
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
 * Escape a raw id for the CSS IDENT position (`#id`). cssEscape above is
 * enough inside quoted attribute selectors, but an id used as `#id` is an
 * identifier: a dot, colon, comma, brackets, or a leading digit produce a
 * wrong or invalid selector, and the `.catch(() => 0)` count probe then
 * swallows the failure — the element vanishes from the inventory silently.
 * Minimal CSS.escape: leading digit as a code-point escape, backslash-escape
 * everything outside [-_a-zA-Z0-9\u00A0-\uFFFF].
 */
export const cssIdent = (s: string): string => {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (i === 0 && ch >= "0" && ch <= "9") out += `\\3${ch} `;
    else if (/[-_a-zA-Z0-9\u00A0-\uFFFF]/.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
};

/** ceiling on distinct :nth-match entries per duplicated base selector — six
 *  rows are plenty to tell a switch-between-items story */
const MAX_SIBLINGS_PER_BASE = 6;

/**
 * Fail-safe destructive-control filter. The director scripts clicks and typing
 * on the LIVE app, so a prompt-injected page (or an unlucky "payoff" beat)
 * could fire a real, irreversible action. Any element whose visible text,
 * aria-label or value matches the shared policy (src/security/destructive.ts)
 * is left out of the inventory entirely, so the script stage can never
 * reference it. `allowDestructive` opts back in.
 */
export { DESTRUCTIVE_RE, isDestructiveLabel } from "../security/destructive.js";

export { isSameSite };

const AUTH_TEXT_RE =
  /\b(?:sign[\s-]*(?:in|up)|log[\s-]*in|login|register|create\s+(?:an\s+|your\s+)?account|forgot|reset\s+password|password|passcode|e-?mail|username|user\s+name|remember\s+me|continue\s+with|single\s+sign|sso|privacy|terms|help|back)\b/i;
const AUTH_HREF_RE = /(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|register|forgot|reset|auth|sso|oauth|account\/(?:new|create))\b/i;

function isAuthItem(i: InventoryItem): boolean {
  if (i.tag === "input" || i.tag === "select") return true;
  return AUTH_TEXT_RE.test(i.text) || (!!i.href && AUTH_HREF_RE.test(i.href));
}

/**
 * Whether a crawl found anything worth paying an LLM for. Returns why not, or
 * undefined when it did. Refused: no interactable element on any page, or
 * every crawled page is a sign-in form (a password field, and nothing but
 * fields and sign-in links). Both mean the app is behind a login, and both
 * are known before any LLM call.
 */
export function assessCrawl(digests: PageDigest[], opts: { hadSession?: boolean } = {}): string | undefined {
  const how = opts.hadSession
    ? "The --storage-state session may have expired or belong to another site; save a fresh one"
    : "To film a signed-in app, save a session (`npx playwright codegen --save-storage=auth.json <app url>`) and pass --storage-state auth.json";
  const pages = digests.map((d) => d.url).join(", ") || "(no page)";
  if (digests.every((d) => d.inventory.length === 0)) {
    return `the crawl found no interactable elements on ${pages}, so there is nothing to film. ${how}.`;
  }
  const loginOnly = digests.every(
    (d) => d.inventory.some((i) => i.inputType === "password") && d.inventory.every(isAuthItem),
  );
  if (loginOnly) {
    return `the crawl found only a sign-in form on ${pages}; supercut cannot film behind a login without a session. ${how}.`;
  }
  return undefined;
}

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
    if (id) selector = `#${cssIdent(id)}`;
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

/** background luminance below this reads as a dark UI. Real dark themes sit
 *  near 0; ambiguous mid-grays fall through to the safer "light" default. */
const DARK_LUMINANCE_MAX = 0.35;

/** a background must cover at least this fraction of the viewport to count as a
 *  dominant surface — below it we're looking at a card/hero, not the ground */
const SURFACE_COVER_MIN = 0.6;
/** cap the element scan so the probe stays cheap on huge DOMs */
const SURFACE_SCAN_LIMIT = 400;

/**
 * Cheap look probe: the DOMINANT visible background → relative luminance →
 * dark/light, plus the first visible button's background as an accent hint.
 * Many React/Next apps leave body/html transparent (or white) and paint the
 * real surface on #root/main/a full-bleed wrapper, so a body→html-only walk
 * misreads them "light". We instead take the background of the LARGEST
 * viewport-covering element, with body/html as the fallback floor. Advisory
 * only — any failure defaults to "light" rather than blocking the crawl.
 */
async function probeTheme(page: Page): Promise<{ theme: "dark" | "light"; accentColor?: string }> {
  try {
    const probe = await page.evaluate(({ darkMax, coverMin, scanLimit }) => {
      const parse = (c: string): [number, number, number, number] | null => {
        const m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
      };
      const vw = window.innerWidth, vh = window.innerHeight;
      const vArea = Math.max(1, vw * vh);
      const coverage = (el: Element): number => {
        const r = el.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        return (w * h) / vArea;
      };
      // dominant ground: largest-covered element with a non-transparent bg.
      // body/html carry a small bias DOWN so a full-bleed painted wrapper wins
      // ties over a transparent/white body (the misread this fix targets).
      let bestRgb: [number, number, number] | null = null;
      let bestScore = -Infinity;
      const consider = (el: Element | null, fallbackBias: number): void => {
        if (!el) return;
        const c = parse(getComputedStyle(el).backgroundColor);
        // Skip anything not fully opaque: a full-viewport modal backdrop
        // (rgba(0,0,0,.5)) can out-cover the page and falsely report "dark" on a
        // light app. A translucent layer is not the page ground — fall through to
        // the largest OPAQUE covering element (body/html floor).
        if (!c || c[3] < 1) return;
        const score = coverage(el) - fallbackBias;
        if (score > bestScore) { bestScore = score; bestRgb = [c[0], c[1], c[2]]; }
      };
      consider(document.body, 0.002);
      consider(document.documentElement, 0.002);
      for (const el of Array.from(document.querySelectorAll("*")).slice(0, scanLimit)) {
        if (coverage(el) >= coverMin) consider(el, 0);
      }
      // WCAG relative luminance — perceptual, so #16161a and #0b0e14 both read dark
      const luminance = ([r, g, b]: [number, number, number]): number => {
        const lin = (n: number): number => {
          const s = n / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const rgb = bestRgb;
      const theme = rgb && luminance(rgb) < darkMax ? "dark" : "light";
      let accent: string | null = null;
      for (const el of Array.from(document.querySelectorAll("button, [role=button], input[type=submit]"))) {
        const box = el.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) continue;
        const c = parse(getComputedStyle(el).backgroundColor);
        if (!c || c[3] === 0) continue;
        accent = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
        break;
      }
      return { theme, accent };
    }, { darkMax: DARK_LUMINANCE_MAX, coverMin: SURFACE_COVER_MIN, scanLimit: SURFACE_SCAN_LIMIT });
    return {
      theme: probe.theme === "dark" ? "dark" : "light",
      ...(probe.accent ? { accentColor: probe.accent } : {}),
    };
  } catch {
    return { theme: "light" };
  }
}

/**
 * Labels that describe what submitting this field's form does: its default
 * submit button (the first submitter in `form.elements`, which includes
 * buttons outside the form joined by `form=`; Enter activates it), and the
 * form's action path read as words. Empty when the field has no form.
 */
async function formSubmitLabels(el: Locator): Promise<string[]> {
  return el
    .evaluate((node) => {
      const form = (node as HTMLInputElement).form;
      if (!form) return [];
      const out: string[] = [];
      for (const c of Array.from(form.elements)) {
        const submitter =
          (c instanceof HTMLButtonElement && c.type === "submit") ||
          (c instanceof HTMLInputElement && (c.type === "submit" || c.type === "image"));
        if (!submitter) continue;
        const h = c as HTMLElement;
        for (const attr of ["aria-label", "value", "title", "alt"]) out.push(h.getAttribute(attr) ?? "");
        out.push(h.innerText || h.textContent || "");
        break;
      }
      const action = form.getAttribute("action");
      if (action) {
        try {
          out.push(new URL(action, location.href).pathname.replace(/[/_.-]+/g, " "));
        } catch {
          /* an unparseable action has nothing to read */
        }
      }
      return out.filter((s) => s.trim() !== "");
    })
    .catch(() => [] as string[]);
}

async function digestPage(page: Page, withScreenshot: boolean, allowDestructive = false): Promise<PageDigest> {
  const title = await page.title();
  const { theme, accentColor } = await probeTheme(page);

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
  // distinct :nth-match entries already inventoried per duplicated base selector
  const siblingCount = new Map<string, number>();
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
    const testid = await el.getAttribute("data-testid").catch(() => null);
    const aria = await el.getAttribute("aria-label").catch(() => null);
    const placeholder = await el.getAttribute("placeholder").catch(() => null);
    const value = await el.getAttribute("value").catch(() => null);
    const href = (await el.getAttribute("href").catch(() => null)) ?? undefined;
    const text = (
      (await el.innerText().catch(() => "")) ||
      (await el.textContent().catch(() => "")) ||
      placeholder || aria || ""
    ).trim().replace(/\s+/g, " ").slice(0, 80);

    // Fail-safe: never put a destructive/irreversible control into the inventory
    // (so the director can't script a click/type on it) unless explicitly opted
    // in. Checks visible text, aria-label, and value (input buttons) on EVERY
    // crawled candidate. There is NO reliable way to prove an element has no
    // click handler from page context — addEventListener bindings are invisible
    // to the DOM and getEventListeners is devtools-only — so any destructive-
    // lexicon hit is excluded outright. Losing a passive row that merely SHARES a
    // name with a verb ("checkout-api") is a small price for never scripting a
    // real Delete/Pay; --allow-destructive re-includes them.
    const labels = [text, aria, value].filter((s): s is string => Boolean(s));
    if (!allowDestructive && labels.some((s) => isDestructiveLabel(s))) {
      // name it by whichever label tripped the filter: an <input type=button>
      // has no text, only a value, and must still be counted in the notice
      excludedDestructive.push(labels[0]!);
      continue;
    }

    // data-testid outranks aria/placeholder/text: it survives live-updating
    // copy (ticking metrics invalidate a :has-text selector between digest and
    // verification) and gives same-testid siblings a shared base that the
    // :nth-match pass below splits into distinct per-row entries.
    let selector: string;
    if (id) selector = `#${cssIdent(id)}`;
    else if (testid) selector = `[data-testid="${cssEscape(testid)}"]`;
    else if (aria) selector = `[aria-label="${cssEscape(aria)}"]`;
    else if (placeholder) selector = `[placeholder="${cssEscape(placeholder)}"]`;
    else if (text) selector = `${tag}:has-text("${cssEscape(text.slice(0, 40))}")`;
    else continue; // nothing stable to target — skip rather than guess

    // verify the selector actually resolves to THIS kind of element, and
    // disambiguate duplicates with :nth-match — every same-base sibling gets
    // its OWN entry (bbox + text), because a dashboard story needs "click row
    // 2, then row 4"; a base whose rows all collapsed to one selector starves
    // the script of anything to switch between
    const base = selector;
    const matches = await page.locator(selector).count().catch(() => 0);
    if (matches === 0) continue;
    if (matches > 1) {
      if (!box) continue; // can't disambiguate a hidden duplicate — skip, don't guess
      // cap per base so one long table can't crowd out the rest of the page
      if ((siblingCount.get(base) ?? 0) >= MAX_SIBLINGS_PER_BASE) continue;
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
    if (matches > 1) siblingCount.set(base, (siblingCount.get(base) ?? 0) + 1);
    // Enter in a field presses its form's default button: a field whose form
    // submits through a destructive control may be typed into, never submitted
    const submitsDestructive =
      !allowDestructive &&
      (tag === "input" || tag === "textarea" || tag === "select") &&
      (await formSubmitLabels(el)).some((s) => isDestructiveLabel(s));
    inventory.push({
      selector, tag, text,
      bbox: box
        ? { x: box.x, y: box.y, w: box.width, h: box.height }
        : { x: 0, y: 0, w: 0, h: 0 },
      ...(href ? { href } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(submitsDestructive ? { submitsDestructive: true } : {}),
      ...(tag === "input" ? { inputType: ((await el.getAttribute("type").catch(() => null)) ?? "text").toLowerCase() } : {}),
    });
  }

  const regions = await collectRegions(page);

  let screenshotB64: string | undefined;
  if (withScreenshot) {
    const shot = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);
    if (shot) screenshotB64 = shot.toString("base64");
  }

  return {
    url: page.url(), title, headings, theme, inventory, regions,
    ...(accentColor ? { accentColor } : {}),
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
    /** path to a Playwright storage state file: the crawl runs signed in.
     *  Only the path is handed to the browser; the contents go nowhere else. */
    storageState?: string;
  } = {},
): Promise<PageDigest[]> {
  const maxPages = opts.maxPages ?? 3;
  const screenshots = opts.screenshots ?? true;
  const allowDestructive = opts.allowDestructive ?? false;
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
    // guard ON: service workers are blocked — a registered worker's fetches
    // are not routed through the context, which would hand the page an
    // ungated network channel
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ...(allowPrivateNetwork ? {} : { serviceWorkers: "block" as const }),
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
    const page = await context.newPage();
    const digests: PageDigest[] = [];
    const visited = new Set<string>();

    // download navigations are aborted so a stray file link can't crash the
    // crawl
    const isDownloadNavigation = (request: { url(): string; isNavigationRequest(): boolean }): boolean => {
      try {
        return request.isNavigationRequest() && NON_HTML_EXT.test(new URL(request.url()).pathname);
      } catch {
        return false;
      }
    };
    const ctx = page.context();
    if (allowPrivateNetwork) {
      await ctx.route("**/*", (route) =>
        isDownloadNavigation(route.request()) ? route.abort() : route.continue(),
      );
    } else {
      // guard ON: EVERY request type — navigation, fetch/XHR, <img>,
      // <script>, <link>, form POST — AND every redirect hop of each is
      // policy-checked before it leaves the browser (see browser-gate.ts for
      // why redirects need the request to be made from Node). A navigation
      // the gate refuses fails page.goto, so the page is skipped below.
      const gate = createRequestGate({ allowPrivateNetwork });
      await installRequestGate(ctx, gate, { veto: isDownloadNavigation });
      // WebSocket upgrades bypass ctx.route — gate them separately
      if (!(await gateWebSockets(ctx, gate))) {
        console.error(
          "warning: this Playwright build lacks routeWebSocket — WebSocket connections are NOT policy-checked",
        );
      }
    }

    // start page first, then source-derived routes (same site only), then
    // link-discovered pages. Seeds ensure functional panels get crawled even
    // when no <a href> points to them.
    const queue = [appUrl, ...(opts.seedUrls ?? []).filter((u) => isSameSite(appUrl, u))];
    let first = true;
    while (queue.length > 0 && digests.length < maxPages) {
      const target = queue.shift()!;
      const isStart = first;
      first = false;
      // Pathname + search: pathname-only collapses query-routed
      // pages (/search?q=a vs ?q=b) and SPA filter/detail views, so the crawler
      // would skip real money-moment pages. Hash is excluded (same document).
      const u = new URL(target);
      const key = u.pathname + u.search;
      if (visited.has(key)) continue;
      visited.add(key);

      // a single bad page (a download, a timeout, a page that settles on
      // another site) is skipped and the crawl keeps going; the start page is
      // the exception (see below)
      try {
        await assertSafeNavigationUrl(target, { allowPrivateNetwork });
        // guard ON: a redirected navigation first lands on the gate's stub,
        // which replaces itself with the target — wait for the real document
        const response = await settleGatedRedirect(
          page,
          await page.goto(target, { timeout: 15_000, waitUntil: "load" }),
          { timeout: 15_000, waitUntil: "load" },
        );
        await assertSafeNavigationUrl(target, { allowPrivateNetwork, finalUrl: response?.url() ?? page.url() });
        await page.waitForTimeout(400); // settle: load ≠ ready
        // re-validate where the page SETTLED: a client-side redirect (JS,
        // meta-refresh) can land somewhere the pre-navigation check never saw
        await assertSafeNavigationUrl(target, { allowPrivateNetwork, finalUrl: page.url() });
      } catch (err) {
        if (digests.length === 0 && queue.length === 0) throw err; // start page must load
        continue;
      }
      // A page that settled on another site (an identity provider's sign-in
      // page, most often) is not the app: filming it would type into a real
      // login form. Same-site moves (http to https, apex to www) are fine.
      if (!isSameSite(target, page.url())) {
        if (isStart) {
          throw new Error(
            `the start page ${appUrl} settled on ${new URL(page.url()).origin}, another site (a sign-in page ` +
              `on an identity provider looks like this). supercut films only the app's own pages. To film a ` +
              `signed-in app, save a session with \`npx playwright codegen --save-storage=auth.json ${appUrl}\` ` +
              `and pass --storage-state auth.json`,
          );
        }
        console.error(`  skipped ${u.pathname}: it settled on ${new URL(page.url()).origin}, another site`);
        continue;
      }
      const digest = await digestPage(page, screenshots, allowDestructive);
      // never film a page whose settled URL is itself a credential — the URL is
      // an un-redactable validation key, so drop the page rather than leak it
      if (pageUrlHasSecret(digest.url)) {
        if (digests.length === 0 && queue.length === 0) {
          throw new Error(
            "the target URL contains a secret in its path or query (a token/key/JWT); " +
              "supercut won't film a page whose URL is itself a credential — point --url at a " +
              "token-free URL (film against a local/staging environment)",
          );
        }
        console.error(
          `  skipped ${new URL(digest.url).pathname} — its URL contains a secret ` +
            `(won't film a page whose URL is a credential)`,
        );
        continue;
      }
      digests.push(digest);

      for (const item of digest.inventory) {
        if (!item.href) continue;
        try {
          const linked = new URL(item.href, digest.url);
          if (isSameSite(appUrl, linked.href) && isCrawlable(linked) && !visited.has(linked.pathname + linked.search)) {
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
