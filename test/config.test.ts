import { afterEach, describe, expect, it } from "vitest";
import { resolveProvider, type ProviderEnv } from "../src/director/config.js";

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
});
