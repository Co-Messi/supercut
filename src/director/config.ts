/**
 * Provider config — resolves which LLM the director uses from the
 * environment (a `.env` file or real env vars). OpenAI-compatible: works with
 * OpenRouter, DeepSeek, or any compatible endpoint.
 *
 *   SUPERCUT_API_KEY        the key (or OPENROUTER_API_KEY / DEEPSEEK_API_KEY)
 *   SUPERCUT_LLM_BASE_URL   endpoint (auto-set for DeepSeek)
 *   SUPERCUT_MODEL          model id
 *   SUPERCUT_VISION         "true"/"false" — force vision on/off
 *
 * Vision capability matters: the analyze + QC stages can use screenshots, but
 * text-only models (e.g. deepseek-chat) can't. When vision is off the director
 * reads the DOM/inventory instead, and the vision-QC pass is skipped.
 */
import { OpenRouterClient, type LlmClient } from "./llm.js";

export interface ResolvedProvider {
  client: LlmClient;
  vision: boolean;
  summary: string;
}

const DEEPSEEK_BASE = "https://api.deepseek.com";

export function resolveProvider(): ResolvedProvider {
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const orKey = process.env.OPENROUTER_API_KEY;
  const genericKey = process.env.SUPERCUT_API_KEY;
  const apiKey = genericKey || deepseekKey || orKey || "";
  if (!apiKey) {
    throw new Error(
      "no API key found. Set DEEPSEEK_API_KEY (or OPENROUTER_API_KEY / SUPERCUT_API_KEY) " +
        "in a .env file at the repo root. See .env.example.",
    );
  }

  // explicit base url wins; otherwise infer DeepSeek from which key was set
  const usingDeepseek = !!deepseekKey && !orKey && !process.env.SUPERCUT_LLM_BASE_URL;
  const baseUrl = process.env.SUPERCUT_LLM_BASE_URL || (usingDeepseek ? DEEPSEEK_BASE : undefined);

  // deepseek-v4-pro: smarter understanding for the ~3 director calls/video.
  // Swap to deepseek-v4-flash via SUPERCUT_MODEL for cheaper/faster. Both are
  // text-only (V4 native vision not shipped as of 2026-06), so vision stays off.
  const model =
    process.env.SUPERCUT_MODEL || (usingDeepseek ? "deepseek-v4-pro" : undefined);

  // vision: explicit override, else off for DeepSeek/text-only, on otherwise
  const visionEnv = process.env.SUPERCUT_VISION?.toLowerCase();
  const vision =
    visionEnv === "true" ? true : visionEnv === "false" ? false : !usingDeepseek;

  const client = new OpenRouterClient({
    apiKey,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  });

  return {
    client,
    vision,
    summary: `${client.label} @ ${baseUrl ?? "openrouter"} · vision ${vision ? "on" : "off (DOM-only)"}`,
  };
}

/** Best-effort .env loader (Node 20.12+ / 22). No-op if absent. */
export function loadDotEnv(path = ".env"): void {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(path);
  } catch {
    /* no .env, or older Node — rely on real env vars */
  }
}
