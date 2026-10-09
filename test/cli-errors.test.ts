import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeArgsError, describeError, describeRecordError, formatZodError, recordOutcome } from "../src/cli/errors.js";
import { parseArgs } from "node:util";

describe("CLI error text", () => {
  it("turns node's parseArgs failures into plain sentences", () => {
    const fail = (args: string[]) => {
      try {
        parseArgs({ args, options: { out: { type: "string" } }, allowPositionals: true });
      } catch (err) {
        return describeArgsError(err);
      }
      throw new Error("expected parseArgs to throw");
    };
    expect(fail(["--bogus"])).toBe("unknown option --bogus");
    expect(fail(["--out"])).toBe("option --out needs a value");
  });

  it("formats Zod issues as path: message lines, capped", () => {
    const schema = z.object({ a: z.object({ b: z.string() }), list: z.array(z.number()) });
    const res = schema.safeParse({ a: {}, list: ["x", "y", "z", "q", "r", "s", "t", "u", "v"] });
    if (res.success) throw new Error("expected failure");
    const text = formatZodError(res.error);
    expect(text).toContain("a.b: Required");
    expect(text).toContain("list.0:");
    expect(text).toMatch(/\.\.\.and \d+ more/);
    expect(text).not.toContain("ZodError");
  });

  it("describeError hides stack traces", () => {
    const res = z.string().safeParse(1);
    if (res.success) throw new Error("expected failure");
    expect(describeError(res.error)).toMatch(/^invalid input:/);
    expect(describeError(new Error("boom"))).toBe("boom");
  });
});

describe("record navigation errors", () => {
  it("reduces a Playwright net error to its first line plus a hint", () => {
    const err = new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://x/\nCall log:\n  - navigating');
    const out = describeRecordError(err) as Error;
    expect(out.message).toContain("net::ERR_CONNECTION_REFUSED");
    expect(out.message).not.toContain("Call log");
    expect(out.message).toMatch(/port/);
  });

  it("leaves other errors untouched", () => {
    const err = new Error("something else");
    expect(describeRecordError(err)).toBe(err);
  });
});

describe("record outcome", () => {
  it("is success with no output when every scene was filmed", () => {
    expect(recordOutcome({ failedScenes: [], aborted: false })).toEqual({ code: 0, lines: [] });
  });

  it("exits nonzero when any scene failed, naming them and hinting at the URL and port", () => {
    const { code, lines } = recordOutcome({ failedScenes: ["signup", "checkout"], aborted: false });
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("signup, checkout");
    expect(text).toMatch(/app URL/);
    expect(text).toMatch(/port/);
    expect(text).toMatch(/take was still written/);
  });

  it("names each failed scene's reason and hints at the selector, not the port, when a selector failed", () => {
    const { code, lines } = recordOutcome({
      failedScenes: ["sign-up"],
      aborted: true,
      sceneErrors: {
        "sign-up": "locator.waitFor: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('#email').first() to be visible",
      },
    });
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("sign-up: locator.waitFor: Timeout 10000ms exceeded.");
    expect(text).not.toContain("Call log");
    expect(text).toMatch(/selector/);
    expect(text).toMatch(/visible/);
    expect(text).not.toMatch(/port/);
  });

  it("keeps the URL and port hint when an entry page or the connection failed", () => {
    for (const reason of [
      "entry page http://127.0.0.1:4319/x returned 404; is your app running there, and is something else using that port?",
      "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4319/",
    ]) {
      const text = recordOutcome({ failedScenes: ["a"], aborted: false, sceneErrors: { a: reason } }).lines.join("\n");
      expect(text).toMatch(/app URL/);
      expect(text).toMatch(/port/);
    }
  });

  it("a dependent scene names the scene it depended on and adds no hint of its own", () => {
    const text = recordOutcome({
      failedScenes: ["a", "b"],
      aborted: false,
      sceneErrors: { a: "locator.click: Timeout 10000ms exceeded.", b: 'depends on failed scene "a"' },
    }).lines.join("\n");
    expect(text).toContain('b: depends on failed scene "a"');
    expect(text).not.toMatch(/port/);
  });

  it("an aborted recording is a failure even with no scene named", () => {
    expect(recordOutcome({ failedScenes: [], aborted: true }).code).toBe(1);
  });
});
