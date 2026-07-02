import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv, resolveProvider, type ProviderEnv } from "../src/director/config.js";

function resolved(env: ProviderEnv) {
  return resolveProvider(env);
}

describe("provider resolution", () => {
  const oldEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...oldEnv };
  });

  it("resolves DeepSeek explicitly even when a custom DeepSeek base URL is set", () => {
    const p = resolved({
      DEEPSEEK_API_KEY: "deepseek-key",
      SUPERCUT_LLM_BASE_URL: "https://api.deepseek.com",
    });

    expect(p.provider).toBe("deepseek");
    expect(p.vision).toBe(false);
    expect(p.model).toBe("deepseek-v4-pro");
    expect(p.summary).toContain("deepseek:deepseek-v4-pro @ https://api.deepseek.com");
  });

  it("fails loudly when provider-specific keys are mixed without an explicit provider", () => {
    expect(() => resolved({ DEEPSEEK_API_KEY: "deepseek", OPENROUTER_API_KEY: "or" })).toThrow(
      /multiple provider keys/i,
    );
  });

  it("still fails on mixed keys when SUPERCUT_API_KEY is also set (no silent DeepSeek win)", () => {
    expect(() =>
      resolved({
        DEEPSEEK_API_KEY: "deepseek",
        OPENROUTER_API_KEY: "or",
        SUPERCUT_API_KEY: "custom-key",
      }),
    ).toThrow(/multiple provider keys/i);
  });

  it("lets SUPERCUT_PROVIDER disambiguate mixed keys", () => {
    const p = resolved({
      SUPERCUT_PROVIDER: "openrouter",
      DEEPSEEK_API_KEY: "deepseek",
      OPENROUTER_API_KEY: "or",
      SUPERCUT_MODEL: "anthropic/claude-sonnet-4.6",
    });

    expect(p.provider).toBe("openrouter");
    expect(p.vision).toBe(true);
    expect(p.model).toBe("anthropic/claude-sonnet-4.6");
  });

  it("rejects forcing vision on for DeepSeek text-only models", () => {
    expect(() => resolved({ DEEPSEEK_API_KEY: "deepseek", SUPERCUT_VISION: "true" })).toThrow(/vision.*deepseek/i);
  });

  it("does not mutate process.env when an explicit model override is passed", () => {
    process.env.SUPERCUT_MODEL = "original";
    const p = resolveProvider({ DEEPSEEK_API_KEY: "deepseek" }, { model: "deepseek-v4-flash" });
    expect(p.model).toBe("deepseek-v4-flash");
    expect(process.env.SUPERCUT_MODEL).toBe("original");
  });

  it("requires an explicit model for custom OpenAI-compatible endpoints", () => {
    expect(() =>
      resolved({
        SUPERCUT_PROVIDER: "custom",
        SUPERCUT_API_KEY: "custom-key",
        SUPERCUT_LLM_BASE_URL: "https://llm.example.com/v1",
      }),
    ).toThrow(/SUPERCUT_MODEL.*custom/i);

    const p = resolved({
      SUPERCUT_PROVIDER: "custom",
      SUPERCUT_API_KEY: "custom-key",
      SUPERCUT_LLM_BASE_URL: "https://llm.example.com/v1",
      SUPERCUT_MODEL: "local-model",
    });
    expect(p.model).toBe("local-model");
  });
});

describe(".env loading", () => {
  const KEYS = ["SUPERCUT_TEST_EXISTING", "SUPERCUT_TEST_NEW"] as const;
  const saved = KEYS.map((k) => [k, process.env[k]] as const);
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("loads new keys but NEVER overrides an existing real environment variable", () => {
    const dir = mkdtempSync(join(tmpdir(), "supercut-env-"));
    try {
      const path = join(dir, ".env");
      writeFileSync(
        path,
        "# comment\nSUPERCUT_TEST_EXISTING=from-file\nSUPERCUT_TEST_NEW=\"from file\"\n",
      );
      process.env.SUPERCUT_TEST_EXISTING = "from-env";
      delete process.env.SUPERCUT_TEST_NEW;

      const res = loadDotEnv(path);
      expect(res.loaded).toBe(true);
      expect(process.env.SUPERCUT_TEST_EXISTING).toBe("from-env"); // real env wins
      expect(process.env.SUPERCUT_TEST_NEW).toBe("from file"); // quotes stripped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing file without pretending success", () => {
    const res = loadDotEnv(join(tmpdir(), "supercut-definitely-missing.env"));
    expect(res.loaded).toBe(false);
    expect(res.reason).toBe("not found");
  });
});
