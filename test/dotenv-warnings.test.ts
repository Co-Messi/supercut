import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dotEnvWarnings, loadDotEnv } from "../src/director/config.js";

/**
 * `generate` reads `.env` from the current directory, which is usually the
 * app being filmed, and a cloned repo can ship one. A .env that redirects the
 * LLM endpoint or lifts the token ceiling gets a loud warning naming the file
 * and the variable; nothing in it is ever printed.
 */

const KEYS = ["SUPERCUT_PROVIDER", "SUPERCUT_LLM_BASE_URL", "SUPERCUT_API_KEY", "SUPERCUT_MAX_TOKENS", "SUPERCUT_MODEL"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadDotEnv reports what it set", () => {
  it("lists the variables the file supplied, not ones the environment already had", () => {
    const dir = mkdtempSync(join(tmpdir(), "supercut-env-"));
    try {
      for (const k of KEYS) delete process.env[k];
      process.env.SUPERCUT_MODEL = "from-shell";
      writeFileSync(join(dir, ".env"), "SUPERCUT_LLM_BASE_URL=https://evil.example/v1\nSUPERCUT_MODEL=from-file\n");
      const res = loadDotEnv(join(dir, ".env"));
      expect(res.applied).toEqual(["SUPERCUT_LLM_BASE_URL"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dotEnvWarnings", () => {
  it("warns when an implicit .env redirects the endpoint or lifts the ceiling", () => {
    const env = { SUPERCUT_PROVIDER: "custom", SUPERCUT_LLM_BASE_URL: "https://evil.example/v1", SUPERCUT_API_KEY: "k-123", SUPERCUT_MAX_TOKENS: "off" };
    const lines = dotEnvWarnings(".env", Object.keys(env), env, { explicit: false });
    const text = lines.join("\n");
    expect(text).toMatch(/\.env.*SUPERCUT_LLM_BASE_URL/);
    expect(text).toContain("evil.example");
    expect(text).toMatch(/SUPERCUT_MAX_TOKENS/);
    expect(text).toMatch(/--env-file/);
    expect(text).not.toContain("k-123"); // never print a value that is a secret
  });

  it("says nothing for a file the user named with --env-file, or one that only sets a key and model", () => {
    const env = { SUPERCUT_LLM_BASE_URL: "https://mine.example/v1" };
    expect(dotEnvWarnings("ci.env", Object.keys(env), env, { explicit: true })).toEqual([]);
    expect(dotEnvWarnings(".env", ["DEEPSEEK_API_KEY", "SUPERCUT_MODEL"], { SUPERCUT_MODEL: "m" }, { explicit: false })).toEqual([]);
  });
});
