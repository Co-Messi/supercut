/**
 * Source-code comprehension, read the app's routes and page components to
 * understand what the product actually IS, then seed the crawl with those
 * routes so the director can drive INTO real panels (not just the landing).
 *
 * Why this exists: the crawler only sees the app's *initial* DOM, so the
 * director never discovers functional pages reachable by buttons/SPA nav and
 * tours the surface ("stayed on the home page, didn't go into the panel"). The
 * code is the ground truth of what every screen shows, reading it is cheaper
 * and deeper than vision, and it tells us which routes exist so we can crawl
 * them and get their real selectors into the inventory.
 *
 * Reads Next.js only: the app router (`app/**\/page.*`) and the pages router
 * (`pages/**\/*.*`) under a directory that has a `next.config.*` or a
 * package.json depending on `next`. Any other framework yields no routes
 * (an Angular `src/app` or a Vite `src/pages` folder is not a router), and
 * the crawl follows links only.
 */
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface SourceRoute {
  /** URL path, e.g. "/dashboard" (route groups stripped, dynamic kept verbatim) */
  route: string;
  /** absolute file path of the page component */
  file: string;
  /** true for dynamic routes like /items/[id], NOT seeded into the crawl (no
   *  concrete value), but still listed in the product summary */
  dynamic: boolean;
  /** extracted human-visible text (headings, labels, copy) for the LLM summary */
  summary: string;
}

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "out", ".turbo",
  "coverage", ".vercel", ".cache", "__tests__", "test", "tests",
  // test/spec/fixture/story dirs hold fake pages and sample data, never
  // real product routes, so keep them out of the crawl seeds and LLM prompt.
  "e2e", "__mocks__", "stories", ".storybook", "cypress", "playwright", "fixtures", "spec", "specs",
]);
/** an app-router page: the only file that makes a segment a route */
const APP_PAGE_FILE = /^page\.(tsx|jsx|ts|js|mdx)$/;
/** a pages-router page module (declaration files excluded) */
const PAGES_FILE = /^(?!.*\.d\.ts$).*\.(tsx|jsx|ts|js|mdx)$/;
/** a Next.js config file at an app root */
const NEXT_CONFIG = /^next\.config\.(js|mjs|cjs|ts|mts)$/;

/** file-count budget for the repo walk: --repo ./ on a large monorepo must not
 *  become an unbounded directory enumeration on the hot path of a command the
 *  user expects to start in seconds. 10k files is far beyond any app tree that
 *  actually carries page components; past it we stop and say so. */
const MAX_WALK_FILES = 10_000;
/** absolute ceiling on directory entries VISITED. With --app, files outside
 *  the selected app cost nothing against the file budget (see extractAppRoutes)
 *  this second bound keeps the traversal itself finite on a pathological
 *  repo instead of re-opening the unbounded-enumeration hole the file budget
 *  closed. */
const MAX_WALK_VISITED = 200_000;

interface WalkState {
  files: string[];
  visited: number;
  truncated: boolean;
}

function walk(
  dir: string,
  state: WalkState,
  depth: number,
  maxFiles: number,
  include: (file: string) => boolean,
): void {
  if (depth > 10) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return;
  }
  // deterministic traversal: readdir order is filesystem-dependent (hashed on
  // ext4, near-alphabetical on APFS), so WHICH routes survive the budgets
  // would vary by machine. Sorted entries make the walk reproducible.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (state.files.length >= maxFiles || state.visited >= MAX_WALK_VISITED) {
      state.truncated = true;
      return;
    }
    state.visited++;
    // skip symlinks entirely (never recurse into or read them): a `--repo`
    // symlink to ~/.ssh, /etc, etc. would otherwise be walked and its file
    // contents shipped into the LLM prompt via extractSummary.
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walk(join(dir, e.name), state, depth + 1, maxFiles, include);
      if (state.truncated) return;
    } else {
      const file = join(dir, e.name);
      // The include predicate (--app scoping) runs INSIDE the walk: a file
      // outside the selected app is neither kept nor charged against the file
      // budget. Filtering after the walk would let a monorepo's OTHER apps
      // exhaust the budget before the requested app was reached, so --app web
      // would return no routes while the truncation warning recommends --app.
      if (include(file)) state.files.push(file);
    }
  }
}

/** app-router: the segments between the router dir and `page.*` make the
 *  route. A `(group)` and a parallel `@slot` add no URL segment; an
 *  intercepting segment (`(.)x`, `(..)x`, `(...)x`) renders another route,
 *  and a `_private` folder opts out of routing, so both yield no route. The
 *  route is dynamic if any segment is `[param]`. */
function appRouterRoute(segs: string[]): { route: string; dynamic: boolean } | null {
  if (segs.some((s) => /^\(\.{1,3}\)/.test(s) || s.startsWith("_"))) return null;
  const routeSegs = segs.filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
  const route = "/" + routeSegs.join("/");
  const dynamic = routeSegs.some((s) => s.includes("[") || s.includes("]"));
  return { route: route === "/" ? "/" : route.replace(/\/$/, ""), dynamic };
}

/** pages-router: the path under the router dir minus the extension; index
 *  maps to its parent. `_app`, `_document`, `_error`, error pages and API
 *  routes are not pages. */
function pagesRouterRoute(segs: string[]): { route: string; dynamic: boolean } | null {
  const out = [...segs];
  const last = out[out.length - 1]!.replace(/\.(tsx|jsx|ts|js|mdx)$/, "");
  if (out.some((s) => s.startsWith("_")) || out[0] === "api" || last === "404" || last === "500") return null;
  out[out.length - 1] = last;
  if (last === "index") out.pop();
  const route = "/" + out.join("/");
  const dynamic = out.some((s) => s.includes("[") || s.includes("]"));
  return { route: route === "/" ? "/" : route.replace(/\/$/, ""), dynamic };
}

/** true when this package.json names Next.js as a dependency */
function hasNextDependency(file: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as { dependencies?: object; devDependencies?: object };
    return Object.hasOwn(pkg.dependencies ?? {}, "next") || Object.hasOwn(pkg.devDependencies ?? {}, "next");
  } catch {
    return false;
  }
}

/**
 * The Next.js app roots for this walk: every directory holding a
 * `next.config.*` or a package.json that depends on `next`, among the walked
 * files and in the repo path itself or its nearest parents (a --repo pointed
 * inside an app). Only these roots' router dirs are read as routes, so an
 * Angular `src/app` or a Vite `src/pages` folder never is.
 */
function nextRoots(repoPath: string, files: string[]): string[] {
  const roots = new Set<string>();
  for (const f of files) {
    const base = basename(f);
    if (NEXT_CONFIG.test(base) || (base === "package.json" && hasNextDependency(f))) roots.add(dirname(f));
  }
  let dir = resolve(repoPath);
  for (let i = 0; i < 4; i++) {
    const markers = (() => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    })();
    if (markers.some((m) => NEXT_CONFIG.test(m)) || (markers.includes("package.json") && hasNextDependency(join(dir, "package.json")))) {
      roots.add(dir);
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return [...roots];
}

/** the route a file defines under one of the Next roots, if any */
function routeOf(file: string, roots: string[]): { route: string; dynamic: boolean } | null {
  const abs = resolve(file);
  for (const root of roots) {
    for (const [router, kind] of [["app", "app"], [join("src", "app"), "app"], ["pages", "pages"], [join("src", "pages"), "pages"]] as const) {
      const prefix = join(root, router) + sep;
      if (!abs.startsWith(prefix)) continue;
      const segs = abs.slice(prefix.length).split(sep);
      const base = segs[segs.length - 1]!;
      if (kind === "app") {
        if (!APP_PAGE_FILE.test(base)) return null;
        return appRouterRoute(segs.slice(0, -1));
      }
      if (!PAGES_FILE.test(base)) return null;
      return pagesRouterRoute(segs);
    }
  }
  return null;
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
  /** walk budget (files enumerated before filtering); default 10000 */
  maxFiles?: number;
}

/**
 * Walk the repo (or app dir), find page components, derive routes + summaries.
 * Returns [] for unsupported frameworks (caller proceeds link-only).
 */
export function extractAppRoutes(repoPath: string, opts: ExtractOptions = {}): SourceRoute[] {
  const maxRoutes = opts.maxRoutes ?? 30;
  const maxFiles = opts.maxFiles ?? MAX_WALK_FILES;
  // --app scoping happens inside the walk (see walk) so files from other apps
  // never spend the budget the requested app needs.
  const appName = opts.appName;
  const include = appName ? (f: string) => f.split(sep).includes(appName) : () => true;
  const state: WalkState = { files: [], visited: 0, truncated: false };
  walk(repoPath, state, 0, maxFiles, include);
  if (state.truncated) {
    console.error(
      `[source] --repo walk stopped early (kept ${state.files.length} file(s)` +
        (appName ? ` matching --app ${appName}` : "") +
        `, visited ${state.visited} entries), routes beyond that are not seen. ` +
        `Point --repo at the app directory to scope the scan.`,
    );
  }
  // routes are read only from Next.js apps; any other framework yields none
  // and the crawl follows links
  const roots = nextRoots(repoPath, state.files);
  if (roots.length === 0) return [];

  const byRoute = new Map<string, SourceRoute>();
  for (const file of state.files) {
    const derived = routeOf(file, roots);
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
    lines.push(`  ${r.route}${r.dynamic ? " (dynamic)" : ""}${r.summary ? `, ${r.summary}` : ""}`);
  }
  const notes =
    `APP ROUTES (from source, these are the real pages this product has):\n` +
    lines.join("\n");
  return { seedUrls, notes };
}
