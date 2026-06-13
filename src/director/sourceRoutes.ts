/**
 * Source-code comprehension — read the app's routes and page components to
 * understand what the product actually IS, then seed the crawl with those
 * routes so the director can drive INTO real panels (not just the landing).
 *
 * Why this exists: the crawler only sees the app's *initial* DOM, so the
 * director never discovers functional pages reachable by buttons/SPA nav and
 * tours the surface ("stayed on the home page, didn't go into the panel"). The
 * code is the ground truth of what every screen shows — reading it is cheaper
 * and deeper than vision, and it tells us which routes exist so we can crawl
 * them and get their real selectors into the inventory.
 *
 * Supports Next.js app-router (`app/**\/page.{tsx,jsx,ts,js}`) and pages-router
 * (`pages/**\/*.{tsx,jsx}`) first; other frameworks degrade to "no routes
 * found" and the crawl proceeds link-only as before.
 */
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";

export interface SourceRoute {
  /** URL path, e.g. "/dashboard" (route groups stripped, dynamic kept verbatim) */
  route: string;
  /** absolute file path of the page component */
  file: string;
  /** true for dynamic routes like /items/[id] — NOT seeded into the crawl (no
   *  concrete value), but still listed in the product summary */
  dynamic: boolean;
  /** extracted human-visible text (headings, labels, copy) for the LLM summary */
  summary: string;
}

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "out", ".turbo",
  "coverage", ".vercel", ".cache", "__tests__", "test", "tests",
]);
const PAGE_FILE = /^(page|index)\.(tsx|jsx|ts|js)$/;
const PAGES_FILE = /\.(tsx|jsx)$/;

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 10) return out;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(join(dir, e.name), out, depth + 1);
    } else {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** app-router: path segments after `app/` → route. `(group)` stripped, route
 *  is dynamic if any segment is `[param]`. */
function appRouterRoute(file: string): { route: string; dynamic: boolean } | null {
  const parts = file.split(sep);
  // find the LAST "app" segment (handles src/app and apps/x/app)
  let appIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === "app") { appIdx = i; break; }
  }
  if (appIdx < 0) return null;
  const segs = parts.slice(appIdx + 1, parts.length - 1); // exclude app/ and the page file
  const routeSegs = segs.filter((s) => !(s.startsWith("(") && s.endsWith(")"))); // drop route groups
  const route = "/" + routeSegs.join("/");
  const dynamic = routeSegs.some((s) => s.includes("[") || s.includes("]"));
  return { route: route === "/" ? "/" : route.replace(/\/$/, ""), dynamic };
}

/** pages-router: path after `pages/` minus extension; index → parent. */
function pagesRouterRoute(file: string): { route: string; dynamic: boolean } | null {
  const parts = file.split(sep);
  let pagesIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === "pages") { pagesIdx = i; break; }
  }
  if (pagesIdx < 0) return null;
  const segs = parts.slice(pagesIdx + 1);
  const last = segs[segs.length - 1]!;
  if (last.startsWith("_")) return null; // _app, _document
  if (segs.includes("api")) return null; // API routes, not pages
  segs[segs.length - 1] = last.replace(PAGES_FILE, "");
  if (segs[segs.length - 1] === "index") segs.pop();
  const route = "/" + segs.join("/");
  const dynamic = segs.some((s) => s.includes("[") || s.includes("]"));
  return { route: route === "/" ? "/" : route.replace(/\/$/, ""), dynamic };
}

/** Pull human-visible text out of a page component: JSX text + string literals,
 *  deduped, capped. Heuristic but enough to tell the LLM what the page is. */
function extractSummary(file: string): string {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const phrases = new Set<string>();
  // JSX text between > and < (no braces/tags)
  for (const m of src.matchAll(/>\s*([A-Z][^<>{}\n]{3,60})\s*</g)) {
    phrases.add(m[1]!.trim());
  }
  // quoted strings that look like labels/copy (have a space or title-case)
  for (const m of src.matchAll(/["'`]([A-Z][A-Za-z0-9 ,.'!?&/-]{4,60})["'`]/g)) {
    const s = m[1]!.trim();
    if (/\s/.test(s) || /^[A-Z]/.test(s)) phrases.add(s);
  }
  return [...phrases].slice(0, 12).join(" · ").slice(0, 400);
}

export interface ExtractOptions {
  /** scope to one app in a monorepo: only files whose path includes this segment */
  appName?: string;
  maxRoutes?: number;
}

/**
 * Walk the repo (or app dir), find page components, derive routes + summaries.
 * Returns [] for unsupported frameworks (caller proceeds link-only).
 */
export function extractAppRoutes(repoPath: string, opts: ExtractOptions = {}): SourceRoute[] {
  const maxRoutes = opts.maxRoutes ?? 30;
  const files = walk(repoPath).filter((f) => {
    if (opts.appName && !f.split(sep).includes(opts.appName)) return false;
    const base = f.split(sep).pop()!;
    const inPages = f.split(sep).includes("pages");
    return PAGE_FILE.test(base) || (inPages && PAGES_FILE.test(base));
  });

  const byRoute = new Map<string, SourceRoute>();
  for (const file of files) {
    const base = file.split(sep).pop()!;
    const derived = PAGE_FILE.test(base) && file.split(sep).includes("app")
      ? appRouterRoute(file)
      : pagesRouterRoute(file);
    if (!derived) continue;
    if (byRoute.has(derived.route)) continue; // first wins (handles dup layouts)
    byRoute.set(derived.route, {
      route: derived.route,
      file,
      dynamic: derived.dynamic,
      summary: extractSummary(file),
    });
  }

  // home route first, then shallow-to-deep, capped
  return [...byRoute.values()]
    .sort((a, b) => a.route.split("/").length - b.route.split("/").length || a.route.localeCompare(b.route))
    .slice(0, maxRoutes);
}

/** Build seed URLs (concrete routes only) + a compact product-source summary
 *  for the analyze prompt. */
export function routesToSeedAndNotes(
  routes: SourceRoute[],
  baseUrl: string,
): { seedUrls: string[]; notes: string } {
  const origin = new URL(baseUrl).origin;
  const seedUrls: string[] = [];
  const lines: string[] = [];
  for (const r of routes) {
    if (!r.dynamic) {
      try {
        seedUrls.push(new URL(r.route, origin).href);
      } catch {
        /* skip */
      }
    }
    lines.push(`  ${r.route}${r.dynamic ? " (dynamic)" : ""}${r.summary ? ` — ${r.summary}` : ""}`);
  }
  const notes =
    `APP ROUTES (from source — these are the real pages this product has):\n` +
    lines.join("\n");
  return { seedUrls, notes };
}
