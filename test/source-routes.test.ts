import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrawlQueue } from "../src/director/inventory.js";
import { extractAppRoutes, routesToSeedAndNotes } from "../src/director/sourceRoutes.js";

/** Build a fake Next.js monorepo on disk to exercise route derivation. */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "supercut-src-"));
  const web = join(root, "apps", "web", "src", "app");
  mkdirSync(web, { recursive: true });
  // routes are read only from a Next.js app: its package.json says so
  const nextPkg = JSON.stringify({ dependencies: { next: "15.0.0" } });
  writeFileSync(join(root, "apps", "web", "package.json"), nextPkg);
  mkdirSync(join(root, "apps", "admin"), { recursive: true });
  writeFileSync(join(root, "apps", "admin", "package.json"), nextPkg);
  const mk = (dir: string, body: string) => {
    mkdirSync(join(web, dir), { recursive: true });
    writeFileSync(join(web, dir, "page.tsx"), body);
  };
  writeFileSync(join(web, "page.tsx"), `export default () => <h1>Welcome home</h1>;`);
  mk("dashboard", `export default () => <div><h1>Monday Brief</h1><button>Open report</button></div>;`);
  mk("locations", `export default () => <h1>The roster of locations</h1>;`);
  mk("(marketing)/pricing", `export default () => <h1>Pricing plans</h1>;`); // route group → stripped
  mk("items/[id]", `export default () => <h1>Item detail</h1>;`); // dynamic
  // noise that must be ignored
  mkdirSync(join(root, "apps", "web", "node_modules", "pkg", "app", "evil"), { recursive: true });
  writeFileSync(join(root, "apps", "web", "node_modules", "pkg", "app", "evil", "page.tsx"), `<h1>nope</h1>`);
  // a second app to test monorepo scoping
  const other = join(root, "apps", "admin", "src", "app");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "page.tsx"), `<h1>Admin</h1>`);
  // A5: test/spec/fixture/story pages live under the app tree but must NOT be
  // ingested as real routes. Plant a page in each excluded dir.
  for (const skip of ["e2e", "fixtures", "stories", "cypress", "__mocks__", "spec"]) {
    mkdirSync(join(web, skip, "secret"), { recursive: true });
    writeFileSync(join(web, skip, "secret", "page.tsx"), `<h1>FIXTURE-${skip}</h1>`);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("extractAppRoutes", () => {
  it("derives app-router routes, strips route groups, flags dynamic, skips node_modules", () => {
    const routes = extractAppRoutes(join(root, "apps", "web"));
    const map = new Map(routes.map((r) => [r.route, r]));
    expect([...map.keys()].sort()).toEqual(["/", "/dashboard", "/items/[id]", "/locations", "/pricing"]);
    expect(map.get("/items/[id]")!.dynamic).toBe(true);
    expect(map.get("/dashboard")!.dynamic).toBe(false);
    // never crawl node_modules
    expect(routes.some((r) => r.file.includes("node_modules"))).toBe(false);
  });

  it("skips test/spec/fixture/story dirs so sample pages aren't ingested (A5)", () => {
    const routes = extractAppRoutes(join(root, "apps", "web"));
    // no route should originate from an excluded dir
    expect(routes.some((r) => /[/\\](e2e|fixtures|stories|cypress|__mocks__|spec)[/\\]/.test(r.file))).toBe(false);
    // and the planted /secret route from those dirs never surfaces
    expect(routes.some((r) => r.route.includes("secret"))).toBe(false);
  });

  it("extracts a human summary from the page source", () => {
    const routes = extractAppRoutes(join(root, "apps", "web"));
    const dash = routes.find((r) => r.route === "/dashboard")!;
    expect(dash.summary).toContain("Monday Brief");
  });

  it("scopes to one app in a monorepo via appName", () => {
    const webOnly = extractAppRoutes(root, { appName: "web" });
    expect(webOnly.some((r) => r.file.includes(`${"admin"}`))).toBe(false);
    expect(webOnly.some((r) => r.route === "/dashboard")).toBe(true);
  });

  it("routesToSeedAndNotes seeds concrete routes only (no dynamic), same-origin", () => {
    const routes = extractAppRoutes(join(root, "apps", "web"));
    const { seedUrls, notes } = routesToSeedAndNotes(routes, "http://127.0.0.1:3100");
    expect(seedUrls).toContain("http://127.0.0.1:3100/dashboard");
    expect(seedUrls.some((u) => u.includes("[id]"))).toBe(false); // dynamic not seeded
    expect(notes).toContain("/items/[id] (dynamic)"); // but still described
    expect(notes).toContain("/dashboard");
  });

  it("returns [] for a non-framework directory (caller falls back to link-only)", () => {
    const empty = mkdtempSync(join(tmpdir(), "supercut-empty-"));
    writeFileSync(join(empty, "readme.md"), "just docs");
    expect(extractAppRoutes(empty)).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("framework detection", () => {
  /** a temp tree from { "relative/path": contents } */
  function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "supercut-fw-"));
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    return dir;
  }
  const page = "export default () => <h1>A page</h1>;";

  it.each([
    ["Remix", { "package.json": JSON.stringify({ dependencies: { "@remix-run/react": "2.0.0" } }), "app/root.tsx": page, "app/routes/index.tsx": page, "app/routes/dashboard.tsx": page }],
    ["Angular", { "package.json": JSON.stringify({ dependencies: { "@angular/core": "17.0.0" } }), "angular.json": "{}", "src/app/store/index.ts": "export {}", "src/app/app.component.ts": "export {}" }],
    ["Vite with React Router", { "package.json": JSON.stringify({ dependencies: { vite: "5.0.0", "react-router-dom": "6.0.0" } }), "src/pages/Dashboard.tsx": page, "src/pages/index.tsx": page }],
  ])("a %s app yields no routes (the crawl follows links instead)", (_name, files) => {
    const dir = tree(files);
    try {
      expect(extractAppRoutes(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a Next app found by next.config alone: parallel slots dropped, intercepts and private folders skipped, index is not a page", () => {
    const dir = tree({
      "next.config.mjs": "export default {}",
      "app/page.tsx": page,
      "app/dashboard/page.tsx": page,
      "app/dashboard/@stats/page.tsx": page, // a slot of /dashboard, not a URL segment
      "app/@modal/(.)photo/page.tsx": page, // intercepts /photo: not its own page
      "app/photo/page.tsx": page,
      "app/_internal/page.tsx": page, // private folder: no route
      "app/settings/index.ts": "export {}", // not a page in the app router
      "components/pages/Card.tsx": page, // a folder named pages that is not the router
    });
    try {
      expect(extractAppRoutes(dir).map((r) => r.route).sort()).toEqual(["/", "/dashboard", "/photo"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a Next pages-router app found by its package.json", () => {
    const dir = tree({
      "package.json": JSON.stringify({ dependencies: { next: "14.2.0" } }),
      "pages/index.tsx": page,
      "pages/reports.tsx": page,
      "pages/_app.tsx": page,
      "pages/api/hello.ts": "export {}",
    });
    try {
      expect(extractAppRoutes(dir).map((r) => r.route).sort()).toEqual(["/", "/reports"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("crawl order", () => {
  it("interleaves source seeds with link-discovered pages after the start page", () => {
    const q = new CrawlQueue("http://x/", ["http://x/s1", "http://x/s2", "http://x/s3"]);
    const seen = [q.next()];
    q.pushLink("http://x/l1");
    q.pushLink("http://x/l2");
    while (q.size > 0) seen.push(q.next());
    expect(seen).toEqual(["http://x/", "http://x/l1", "http://x/s1", "http://x/l2", "http://x/s2", "http://x/s3"]);
  });
});

describe("walk budget", () => {
  it("stops enumerating at maxFiles instead of walking a monorepo unbounded", () => {
    // the fixture tree holds well over 3 files; a budget of 3 must bound the
    // enumeration (and therefore the routes derived from it)
    const routes = extractAppRoutes(root, { maxFiles: 3 });
    expect(routes.length).toBeLessThanOrEqual(3);
    // and the default budget still finds everything the other tests rely on
    const full = extractAppRoutes(root);
    expect(full.length).toBeGreaterThan(routes.length);
  });

  it("--app scoping is applied before the budget is spent, not after", () => {
    // monorepo where a sibling app holds 3x the file budget and sorts BEFORE
    // the requested app (traversal is sorted, so it is enumerated first).
    // Budget spent repo-wide used to exhaust on the junk app and return no
    // routes for --app web — while the truncation warning recommended --app
    // as the remedy. Scoped-in-walk, junk files cost nothing.
    const mono = mkdtempSync(join(tmpdir(), "supercut-mono-"));
    const junk = join(mono, "apps", "aaa-junk");
    mkdirSync(junk, { recursive: true });
    for (let i = 0; i < 30; i++) writeFileSync(join(junk, `f${String(i).padStart(2, "0")}.ts`), "// junk");
    const webApp = join(mono, "apps", "web", "app");
    mkdirSync(webApp, { recursive: true });
    writeFileSync(join(mono, "apps", "web", "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }));
    writeFileSync(join(webApp, "page.tsx"), `export default () => <h1>Web home</h1>;`);
    try {
      const routes = extractAppRoutes(mono, { appName: "web", maxFiles: 10 });
      expect(routes.map((r) => r.route)).toEqual(["/"]);
      expect(routes[0]!.file).toContain(join("apps", "web"));
    } finally {
      rmSync(mono, { recursive: true, force: true });
    }
  });
});
