/**
 * LLM access for the director stages — OpenRouter-first (one key, many
 * models; Engineering Decision #4), plain fetch, zero SDK dependencies.
 *
 * Every AI touchpoint in supercut goes through this interface, so tests can
 * inject a stub and the whole generate pipeline runs without any API key.
 */

export type ChatPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string };

export interface ChatOptions {
  system: string;
  user: ChatPart[];
  /** ask the model for a JSON object response */
  json?: boolean;
  maxTokens?: number;
}

export interface LlmClient {
  chat(opts: ChatOptions): Promise<string>;
  readonly label: string;
}

export interface OpenRouterConfig {
  apiKey: string;
  /** override with SUPERCUT_MODEL; needs vision for analyze + QC */
  model?: string;
  baseUrl?: string;
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

export class OpenRouterClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  readonly label: string;

  constructor(cfg: OpenRouterConfig) {
    if (!cfg.apiKey) throw new Error("OpenRouter API key is empty");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model ?? process.env.SUPERCUT_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = cfg.baseUrl ?? "https://openrouter.ai/api/v1";
    this.label = `openrouter:${this.model}`;
  }

  async chat(opts: ChatOptions): Promise<string> {
    const content = opts.user.map((p) =>
      p.type === "text"
        ? { type: "text" as const, text: p.text }
        : { type: "image_url" as const, image_url: { url: p.dataUrl } },
    );
    const body = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content },
      ],
    };

    let lastErr = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        // explicit 4-min timeout so a stalled connection (proxy half-open,
        // slow reasoning model) fails cleanly instead of hanging forever
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            "x-title": "supercut",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(240_000),
        });
      } catch (err) {
        // network-level throw ("fetch failed", timeout, proxy reset) — transient,
        // retry with backoff. Surface the underlying cause for diagnosis.
        const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
        lastErr = `network: ${cause?.code ?? ""} ${cause?.message ?? (err instanceof Error ? err.message : String(err))}`.trim();
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string; reasoning_content?: string } }[];
        };
        const msg = data.choices?.[0]?.message;
        // reasoning models (deepseek-v4) may put the answer in content; fall
        // back to reasoning_content only if content is empty
        const text = msg?.content || msg?.reasoning_content;
        if (!text) throw new Error(`LLM returned an empty response (${this.label})`);
        return text;
      }
      const snippet = (await res.text()).slice(0, 300);
      // auth/config errors fail FAST and clear (fail-fast preflight rule);
      // only rate limits and server errors retry
      if (res.status === 401 || res.status === 403) {
        throw new Error(`LLM auth failed (${res.status}, ${this.label}) — check your API key. ${snippet}`);
      }
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`LLM request rejected (${res.status}, ${this.label}): ${snippet}`);
      }
      lastErr = `${res.status}: ${snippet}`;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    throw new Error(`LLM unavailable after 4 attempts (${this.label}): ${lastErr}`);
  }
}

/**
 * Pull the first JSON object out of a model response — tolerates ```json
 * fences and prose around the object, balanced-brace scan.
 */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  if (start < 0) throw new Error("no JSON object found in LLM response");
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error("unterminated JSON object in LLM response");
}
