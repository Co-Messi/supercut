/**
 * Provider config — resolves which LLM the director uses from explicit env
 * input (a loaded `.env` file or real env vars). OpenAI-compatible: works with
 * OpenRouter, DeepSeek, or a custom endpoint.
 */
import { existsSync } from "node:fs";
import { OpenAICompatibleClient, type LlmClient } from "./llm.js";

export type ProviderName = "deepseek" | "openrouter" | "custom";

export interface ProviderEnv {
  SUPERCUT_PROVIDER?: string;
  SUPERCUT_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  SUPERCUT_LLM_BASE_URL?: string;
  SUPERCUT_MODEL?: string;
  SUPERCUT_VISION?: string;
}

export interface ProviderOverrides {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  vision?: boolean;
}

export interface ResolvedProvider {
  client: LlmClient;
  provider: ProviderName;
  model: string;
  baseUrl: string;
  vision: boolean;
  summary: string;
}

const DEEPSEEK_BASE = "https://api.deepseek.com";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";

function parseProvider(value: string | undefined): ProviderName | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === "deepseek" || v === "openrouter" || v === "custom") return v;
  throw new Error(`unknown SUPERCUT_PROVIDER "${value}" (expected deepseek, openrouter, or custom)`);
}

function parseVision(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`invalid SUPERCUT_VISION "${value}" (expected true or false)`);
}

export function resolveProvider(
  env: ProviderEnv = process.env,
  overrides: ProviderOverrides = {},
): ResolvedProvider {
  const explicitProvider = overrides.provider ?? parseProvider(env.SUPERCUT_PROVIDER);
  const providerKeys = [
    env.DEEPSEEK_API_KEY ? "deepseek" : "",
    env.OPENROUTER_API_KEY ? "openrouter" : "",
  ].filter(Boolean);

  if (!explicitProvider && providerKeys.length > 1 && !env.SUPERCUT_API_KEY) {
    throw new Error("multiple provider keys found; set SUPERCUT_PROVIDER to deepseek or openrouter");
  }

  let provider: ProviderName;
  if (explicitProvider) provider = explicitProvider;
  else if (env.DEEPSEEK_API_KEY) provider = "deepseek";
  else if (env.OPENROUTER_API_KEY) provider = "openrouter";
  else if (env.SUPERCUT_API_KEY || overrides.baseUrl || env.SUPERCUT_LLM_BASE_URL) provider = "custom";
  else {
    throw new Error(
      "no API key found. Set DEEPSEEK_API_KEY (or OPENROUTER_API_KEY / SUPERCUT_API_KEY) " +
        "in a .env file. See .env.example.",
    );
  }

  const apiKey =
    provider === "deepseek" ? env.DEEPSEEK_API_KEY || env.SUPERCUT_API_KEY || "" :
    provider === "openrouter" ? env.OPENROUTER_API_KEY || env.SUPERCUT_API_KEY || "" :
    env.SUPERCUT_API_KEY || env.DEEPSEEK_API_KEY || env.OPENROUTER_API_KEY || "";
  if (!apiKey) throw new Error(`no API key found for provider ${provider}`);

  const baseUrl = overrides.baseUrl ?? env.SUPERCUT_LLM_BASE_URL ?? (
    provider === "deepseek" ? DEEPSEEK_BASE : provider === "openrouter" ? OPENROUTER_BASE : ""
  );
  if (!baseUrl) throw new Error("SUPERCUT_LLM_BASE_URL is required when SUPERCUT_PROVIDER=custom");

  const model = overrides.model ?? env.SUPERCUT_MODEL ?? (
    provider === "deepseek" ? DEFAULT_DEEPSEEK_MODEL : DEFAULT_OPENROUTER_MODEL
  );

  const envVision = parseVision(env.SUPERCUT_VISION);
  const vision = overrides.vision ?? envVision ?? (provider !== "deepseek");
  if (provider === "deepseek" && vision) {
    throw new Error("vision cannot be enabled for DeepSeek text-only models; use OpenRouter/custom vision model or SUPERCUT_VISION=false");
  }

  const client = new OpenAICompatibleClient({
    apiKey,
    model,
    baseUrl,
    providerLabel: provider,
    vision,
  });

  return {
    client,
    provider,
    model,
    baseUrl,
    vision,
    summary: `${client.label} @ ${baseUrl} · vision ${vision ? "on" : "off (DOM-only)"}`,
  };
}

export interface DotEnvLoadResult {
  path: string;
  loaded: boolean;
  reason?: string;
}

/** Best-effort .env loader (Node 20.12+ / 22). Does not silently pretend success. */
export function loadDotEnv(path = ".env"): DotEnvLoadResult {
  if (!existsSync(path)) return { path, loaded: false, reason: "not found" };
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(path);
    return { path, loaded: true };
  } catch (err) {
    return { path, loaded: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
