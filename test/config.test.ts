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

  it("custom provider refuses to fall back to a provider-scoped key (H3)", () => {
    // a leftover DeepSeek key must never be sent as a bearer token to an
    // arbitrary custom base URL — this used to resolve silently
    expect(() =>
      resolved({
        SUPERCUT_PROVIDER: "custom",
        DEEPSEEK_API_KEY: "leftover-deepseek-key",
        SUPERCUT_LLM_BASE_URL: "https://gateway.example/v1",
        SUPERCUT_MODEL: "some-model",
      }),
    ).toThrow(/SUPERCUT_API_KEY is required.*never sent to a custom endpoint/s);
    expect(() =>
      resolved({
        SUPERCUT_PROVIDER: "custom",
        OPENROUTER_API_KEY: "leftover-or-key",
        SUPERCUT_LLM_BASE_URL: "https://gateway.example/v1",
        SUPERCUT_MODEL: "some-model",
      }),
    ).toThrow(/SUPERCUT_API_KEY is required/);
  });

  describe("base-URL override never redirects a provider-scoped key (H-new-3)", () => {
    const foreign = "https://gateway.example/v1";

    it("auto-detected deepseek refuses a foreign SUPERCUT_LLM_BASE_URL", () => {
      expect(() => resolved({ DEEPSEEK_API_KEY: "ds-key", SUPERCUT_LLM_BASE_URL: foreign })).toThrow(
        /SUPERCUT_LLM_BASE_URL.*gateway\.example.*api\.deepseek\.com/s,
      );
    });

    it("explicit deepseek refuses a foreign SUPERCUT_LLM_BASE_URL", () => {
      expect(() =>
        resolved({ SUPERCUT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "ds-key", SUPERCUT_LLM_BASE_URL: foreign }),
      ).toThrow(/api\.deepseek\.com/);
    });

    it("explicit deepseek with SUPERCUT_API_KEY still refuses a foreign base URL", () => {
      expect(() =>
        resolved({ SUPERCUT_PROVIDER: "deepseek", SUPERCUT_API_KEY: "k", SUPERCUT_LLM_BASE_URL: foreign }),
      ).toThrow(/api\.deepseek\.com/);
    });

    it("auto-detected openrouter refuses a foreign SUPERCUT_LLM_BASE_URL", () => {
      expect(() => resolved({ OPENROUTER_API_KEY: "or-key", SUPERCUT_LLM_BASE_URL: foreign })).toThrow(
        /openrouter\.ai/,
      );
    });

    it("explicit openrouter refuses a foreign base URL", () => {
      expect(() =>
        resolved({ SUPERCUT_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-key", SUPERCUT_LLM_BASE_URL: foreign }),
      ).toThrow(/openrouter\.ai/);
    });

    it("the programmatic baseUrl override is held to the same rule", () => {
      expect(() => resolveProvider({ DEEPSEEK_API_KEY: "ds-key" }, { baseUrl: foreign })).toThrow(
        /api\.deepseek\.com/,
      );
    });

    it("a lookalike host that merely contains the provider host is refused", () => {
      expect(() =>
        resolved({ DEEPSEEK_API_KEY: "ds-key", SUPERCUT_LLM_BASE_URL: "https://api.deepseek.com.evil.example/v1" }),
      ).toThrow(/api\.deepseek\.com/);
      expect(() =>
        resolved({ OPENROUTER_API_KEY: "or-key", SUPERCUT_LLM_BASE_URL: "https://evil-openrouter.ai/api/v1" }),
      ).toThrow(/openrouter\.ai/);
    });

    it("the provider's own host (any path) is accepted", () => {
      expect(
        resolved({ DEEPSEEK_API_KEY: "ds-key", SUPERCUT_LLM_BASE_URL: "https://api.deepseek.com/v1" }).baseUrl,
      ).toBe("https://api.deepseek.com/v1");
      expect(
        resolved({ OPENROUTER_API_KEY: "or-key", SUPERCUT_LLM_BASE_URL: "https://openrouter.ai/api/v1" }).baseUrl,
      ).toBe("https://openrouter.ai/api/v1");
    });

    it("the provider's own host over plain http is refused (key would travel in cleartext)", () => {
      expect(() =>
        resolved({ DEEPSEEK_API_KEY: "ds-key", SUPERCUT_LLM_BASE_URL: "http://api.deepseek.com" }),
      ).toThrow(/https/);
    });

    it("custom endpoints require https unless the host is loopback", () => {
      const custom = { SUPERCUT_PROVIDER: "custom", SUPERCUT_API_KEY: "k", SUPERCUT_MODEL: "m" };
      expect(() => resolved({ ...custom, SUPERCUT_LLM_BASE_URL: "http://llm.example.com/v1" })).toThrow(/https/);
      for (const loop of ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1", "http://[::1]:8080/v1"]) {
        expect(resolved({ ...custom, SUPERCUT_LLM_BASE_URL: loop }).baseUrl).toBe(loop);
      }
      expect(resolved({ ...custom, SUPERCUT_LLM_BASE_URL: "https://llm.example.com/v1" }).provider).toBe("custom");
    });

    it("an unparseable or non-http(s) base URL is refused", () => {
      const custom = { SUPERCUT_PROVIDER: "custom", SUPERCUT_API_KEY: "k", SUPERCUT_MODEL: "m" };
      expect(() => resolved({ ...custom, SUPERCUT_LLM_BASE_URL: "not a url" })).toThrow(/SUPERCUT_LLM_BASE_URL/);
      expect(() => resolved({ ...custom, SUPERCUT_LLM_BASE_URL: "ftp://llm.example.com" })).toThrow(/https/);
    });
  });

  it("summary names the env var that supplied the credential", () => {
    const ds = resolved({ DEEPSEEK_API_KEY: "deepseek-key" });
    expect(ds.keySource).toBe("DEEPSEEK_API_KEY");
    expect(ds.summary).toContain("key from DEEPSEEK_API_KEY");

    const custom = resolved({
      SUPERCUT_PROVIDER: "custom",
      SUPERCUT_API_KEY: "custom-key",
      DEEPSEEK_API_KEY: "leftover", // present but must NOT be used
      SUPERCUT_LLM_BASE_URL: "https://gateway.example/v1",
      SUPERCUT_MODEL: "local-model",
    });
    expect(custom.keySource).toBe("SUPERCUT_API_KEY");
    expect(custom.summary).toContain("key from SUPERCUT_API_KEY");
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

  describe("parser edge cases (M-new-4)", () => {
    const ENV_KEYS = [
      "SUPERCUT_TEST_EMPTY", "SUPERCUT_TEST_COMMENT", "SUPERCUT_TEST_HASH_QUOTED", "SUPERCUT_TEST_HASH_GLUED",
      "SUPERCUT_TEST_EXPORTED", "SUPERCUT_TEST_CRLF", "SUPERCUT_TEST_SQ", "DATABASE_URL_SUPERCUT_TEST",
      "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "SUPERCUT_MODEL",
    ];
    const before = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    afterEach(() => {
      for (const [k, v] of before) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    function load(text: string) {
      for (const k of ENV_KEYS) delete process.env[k];
      const dir = mkdtempSync(join(tmpdir(), "supercut-env-edge-"));
      try {
        const path = join(dir, ".env");
        writeFileSync(path, text);
        return loadDotEnv(path);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("an empty value is unset, not an empty string", () => {
      load("SUPERCUT_TEST_EMPTY=\nSUPERCUT_MODEL=\n");
      expect("SUPERCUT_TEST_EMPTY" in process.env).toBe(false);
      expect("SUPERCUT_MODEL" in process.env).toBe(false);
    });

    it("strips an unquoted inline comment but keeps # inside quotes or glued to the value", () => {
      load(
        [
          "SUPERCUT_TEST_COMMENT=sk-abc123   # my deepseek key",
          'SUPERCUT_TEST_HASH_QUOTED="a # b"   # trailing note',
          "SUPERCUT_TEST_HASH_GLUED=abc#def",
          "SUPERCUT_TEST_SQ='single # quoted'",
        ].join("\n"),
      );
      expect(process.env.SUPERCUT_TEST_COMMENT).toBe("sk-abc123");
      expect(process.env.SUPERCUT_TEST_HASH_QUOTED).toBe("a # b");
      expect(process.env.SUPERCUT_TEST_HASH_GLUED).toBe("abc#def");
      expect(process.env.SUPERCUT_TEST_SQ).toBe("single # quoted");
    });

    it("accepts `export KEY=val` and CRLF line endings", () => {
      load("export SUPERCUT_TEST_EXPORTED=yes\r\nSUPERCUT_TEST_CRLF=crlf\r\n");
      expect(process.env.SUPERCUT_TEST_EXPORTED).toBe("yes");
      expect(process.env.SUPERCUT_TEST_CRLF).toBe("crlf");
    });

    it("imports only supercut's own variables, never the app's", () => {
      load("DATABASE_URL_SUPERCUT_TEST=postgres://secret\nDEEPSEEK_API_KEY=ds\nOPENROUTER_API_KEY=or\n");
      expect("DATABASE_URL_SUPERCUT_TEST" in process.env).toBe(false);
      expect(process.env.DEEPSEEK_API_KEY).toBe("ds");
      expect(process.env.OPENROUTER_API_KEY).toBe("or");
    });
  });

  it("empty provider variables fall through to the defaults instead of failing", () => {
    const p = resolved({
      DEEPSEEK_API_KEY: "ds-key",
      SUPERCUT_PROVIDER: "",
      SUPERCUT_MODEL: "",
      SUPERCUT_LLM_BASE_URL: "",
      SUPERCUT_VISION: "",
    });
    expect(p.provider).toBe("deepseek");
    expect(p.model).toBe("deepseek-v4-pro");
    expect(p.baseUrl).toBe("https://api.deepseek.com");
    expect(p.vision).toBe(false);
  });

  it("reports a missing file without pretending success", () => {
    const res = loadDotEnv(join(tmpdir(), "supercut-definitely-missing.env"));
    expect(res.loaded).toBe(false);
    expect(res.reason).toBe("not found");
  });
});
