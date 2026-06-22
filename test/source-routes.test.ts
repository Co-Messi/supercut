import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractAppRoutes, routesToSeedAndNotes } from "../src/director/sourceRoutes.js";

/** Build a fake Next.js monorepo on disk to exercise route derivation. */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "supercut-src-"));
  const web = join(root, "apps", "web", "src", "app");
  mkdirSync(web, { recursive: true });
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
  for (const skip of ["e2e", "fixtures", "stories", "cypress", "__mocks__"]) {
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
    expect(routes.some((r) => /[/\\](e2e|fixtures|stories|cypress|__mocks__)[/\\]/.test(r.file))).toBe(false);
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
