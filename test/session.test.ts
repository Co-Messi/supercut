import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assertStorageStateFile } from "../src/capture/session.js";
import { dryRunFollowUpCommand } from "../src/director/generate.js";
import { assessCrawl, isSameSite, type PageDigest } from "../src/director/inventory.js";

const dir = mkdtempSync(join(tmpdir(), "supercut-session-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("isSameSite: where a start page may settle", () => {
  it.each([
    ["http://localhost:3000/", "http://localhost:3000/dashboard"],
    ["http://example.com/", "https://example.com/"], // http to https upgrade
    ["http://example.com/", "https://www.example.com/home"], // upgrade plus apex to www
    ["https://example.com/", "https://www.example.com/"], // apex to www
    ["https://www.example.com/", "https://example.com/"], // www to apex
  ])("%s may settle on %s", (from, to) => {
    expect(isSameSite(from, to)).toBe(true);
  });

  it.each([
    ["https://app.example.com/", "https://login.example-idp.com/authorize"],
    ["https://example.com/", "http://example.com/"], // downgrade
    ["http://127.0.0.1:3000/", "http://127.0.0.1:4000/login"], // another port is another app
    ["http://localhost:3000/", "http://127.0.0.1:3000/"],
    ["https://app.example.com/", "https://example.com/"], // a subdomain is not www
  ])("%s may not settle on %s", (from, to) => {
    expect(isSameSite(from, to)).toBe(false);
  });
});

const page = (url: string, inventory: PageDigest["inventory"]): PageDigest => ({
  url, title: "t", headings: [], inventory, regions: [],
});
const item = (selector: string, tag: string, text: string, extra: Partial<PageDigest["inventory"][number]> = {}) => ({
  selector, tag, text, bbox: { x: 0, y: 0, w: 100, h: 30 }, ...extra,
});

describe("assessCrawl: nothing worth paying an LLM for", () => {
  it("refuses a crawl with no interactable elements, pointing at --storage-state", () => {
    expect(assessCrawl([page("http://x/", [])])).toMatch(/no interactable elements.*--storage-state/s);
  });

  it("refuses a crawl that found only a sign-in form", () => {
    const login = page("http://x/login", [
      item("#email", "input", "you@company.com", { inputType: "email" }),
      item("#password", "input", "Password", { inputType: "password" }),
      item("#submit", "button", "Sign in"),
      item("a:has-text(\"Forgot password?\")", "a", "Forgot password?", { href: "/forgot" }),
      item("a:has-text(\"Create an account\")", "a", "Create an account", { href: "/signup" }),
    ]);
    expect(assessCrawl([login])).toMatch(/sign-in form.*--storage-state/s);
  });

  it("accepts an app page, even next to a sign-in page", () => {
    const app = page("http://x/", [item("#search", "input", "Search metrics", { inputType: "text" }), item("#open", "button", "Open report")]);
    expect(assessCrawl([app])).toBeUndefined();
    const login = page("http://x/login", [item("#password", "input", "Password", { inputType: "password" }), item("#go", "button", "Log in")]);
    expect(assessCrawl([app, login])).toBeUndefined();
  });

  it("says the session may have expired when one was given", () => {
    expect(assessCrawl([page("http://x/", [])], { hadSession: true })).toMatch(/expired/);
  });
});

describe("--storage-state file", () => {
  it("accepts a Playwright storage state and returns its absolute path", () => {
    const p = join(dir, "auth.json");
    writeFileSync(p, JSON.stringify({ cookies: [{ name: "sid", value: "s3cr3t-cookie-value", domain: "127.0.0.1", path: "/" }], origins: [] }));
    expect(assertStorageStateFile(p)).toBe(p);
  });

  it("rejects a missing file, bad JSON, or the wrong shape, without echoing the contents", () => {
    expect(() => assertStorageStateFile(join(dir, "nope.json"))).toThrow(/no such file/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "s3cr3t-cookie-value not json");
    expect(() => assertStorageStateFile(bad)).toThrow(/not valid JSON/);
    try {
      assertStorageStateFile(bad);
    } catch (err) {
      expect(String(err)).not.toContain("s3cr3t");
    }
    const shape = join(dir, "shape.json");
    writeFileSync(shape, JSON.stringify({ token: "s3cr3t-cookie-value" }));
    expect(() => assertStorageStateFile(shape)).toThrow(/cookies/);
  });
});

describe("the printed follow-up command keeps the session", () => {
  it("carries --storage-state into the suggested record command", () => {
    expect(dryRunFollowUpCommand("out/gen", { storageState: "auth state.json" })).toBe(
      "supercut record --recipe out/gen/recipe.json --storage-state 'auth state.json'",
    );
  });
});
