/**
 * LLM access for the director stages — OpenAI-compatible, plain fetch, zero
 * SDK dependencies. Works with OpenRouter, DeepSeek, or a custom compatible
 * endpoint selected in config.ts.
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
  /** running total of tokens billed across this client's calls, when the
   *  provider reports usage. Optional: stubs and providers that omit usage
   *  leave it undefined (callers report "usage: unavailable"). */
  readonly tokensUsed?: number | undefined;
}

export interface OpenAICompatibleConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  providerLabel: string;
  /** whether this provider/model accepts image parts */
  vision: boolean;
}

export class OpenAICompatibleClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly vision: boolean;
  readonly label: string;
  /** best-effort token accounting: sum of provider-reported usage across calls.
   *  Stays undefined until the FIRST response that carries a usage block, so a
   *  provider that never reports usage leaves it undefined (→ "unavailable"). */
  private _tokensUsed: number | undefined = undefined;
  get tokensUsed(): number | undefined {
    return this._tokensUsed;
  }

  constructor(cfg: OpenAICompatibleConfig) {
    if (!cfg.apiKey) throw new Error(`${cfg.providerLabel} API key is empty`);
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.vision = cfg.vision;
    this.label = `${cfg.providerLabel}:${this.model}`;
  }

  async chat(opts: ChatOptions): Promise<string> {
    if (!this.vision && opts.user.some((p) => p.type === "image")) {
      throw new Error(`${this.label} is text-only; refusing to send image parts`);
    }

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
        const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
        lastErr = `network: ${cause?.code ?? ""} ${cause?.message ?? (err instanceof Error ? err.message : String(err))}`.trim();
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (res.ok) {
        const data = (await res.json()) as {
          choices?: { message?: { content?: string; reasoning_content?: string } }[];
          usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
        };
        // best-effort cost telemetry: prefer total_tokens, else sum prompt+completion
        const u = data.usage;
        const billed =
          u?.total_tokens ??
          (u?.prompt_tokens !== undefined || u?.completion_tokens !== undefined
            ? (u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0)
            : undefined);
        if (billed !== undefined) this._tokensUsed = (this._tokensUsed ?? 0) + billed;
        const msg = data.choices?.[0]?.message;
        const text = msg?.content || msg?.reasoning_content;
        if (!text) throw new Error(`LLM returned an empty response (${this.label})`);
        return text;
      }
      const snippet = (await res.text()).slice(0, 300);
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

/** Backwards-compatible export name for older internal imports. */
export const OpenRouterClient = OpenAICompatibleClient;
export type OpenRouterConfig = OpenAICompatibleConfig;

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
