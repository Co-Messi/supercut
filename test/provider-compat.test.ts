import { afterEach, describe, expect, it } from "vitest";
import { resolveProvider } from "../src/director/config.js";
import { OpenAICompatibleClient } from "../src/director/llm.js";

/**
 * Custom OpenAI-compatible endpoints differ in what they accept. A model that
 * rejects `max_tokens` (OpenAI's reasoning models want
 * `max_completion_tokens`) or `response_format` gets the request again
 * without the offending parameter, and a rejection says what the provider
 * said instead of only its status.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Sent = Record<string, unknown>;
function install(answer: (body: Sent, n: number) => Response): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init!.body!) as Sent;
    sent.push(body);
    return answer(body, sent.length);
  }) as typeof fetch;
  return sent;
}
const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { total_tokens: 10 } }), {
    status: 200, headers: { "content-type": "application/json" },
  });
const bad = (message: string) =>
  new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), { status: 400 });

const client = () =>
  new OpenAICompatibleClient({ apiKey: "k", model: "o4-mini", baseUrl: "https://llm.example.com/v1", providerLabel: "custom", vision: false, retryBaseMs: 0 });
const ask = (c: OpenAICompatibleClient) => c.chat({ system: "s", user: [{ type: "text", text: "hi" }], json: true, maxTokens: 500 });

describe("custom provider parameters", () => {
  it("retries with max_completion_tokens when the model rejects max_tokens, and keeps using it", async () => {
    const sent = install((body) =>
      "max_tokens" in body
        ? bad("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")
        : ok("{}"),
    );
    const c = client();
    await expect(ask(c)).resolves.toBe("{}");
    expect(sent[1]).toMatchObject({ max_completion_tokens: 500 });
    expect(sent[1]).not.toHaveProperty("max_tokens");
    await ask(c);
    expect(sent[2]).not.toHaveProperty("max_tokens"); // learned for the rest of the run
  });

  it("retries without response_format when the endpoint rejects it", async () => {
    const sent = install((body) => ("response_format" in body ? bad("response_format is not supported by this model") : ok("{}")));
    await expect(ask(client())).resolves.toBe("{}");
    expect(sent[1]).not.toHaveProperty("response_format");
  });

  it("a rejection names what the provider said, shortened and with secrets redacted", async () => {
    install(() => bad("Invalid model 'o4-minii' for key sk-abcdefghijklmnopqrstuv"));
    const err = await ask(client()).catch((e: Error) => e);
    expect(String(err)).toContain("Invalid model 'o4-minii'");
    expect(String(err)).not.toContain("sk-abcdefghijklmnopqrstuv");
  });
});

describe("rate limits", () => {
  it("waits as long as a 429's Retry-After asks before trying again", async () => {
    const sent = install((_b, n) =>
      n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } }) : ok("{}"),
    );
    const t0 = Date.now();
    await expect(ask(client())).resolves.toBe("{}");
    expect(sent).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900); // retryBaseMs is 0: only Retry-After waits
  });
});

describe("custom provider vision default", () => {
  it("is off unless SUPERCUT_VISION says the model takes images (a text-only local model would fail mid-run)", () => {
    const base = { SUPERCUT_PROVIDER: "custom", SUPERCUT_API_KEY: "k", SUPERCUT_MODEL: "m", SUPERCUT_LLM_BASE_URL: "https://llm.example.com/v1" };
    expect(resolveProvider(base).vision).toBe(false);
    expect(resolveProvider({ ...base, SUPERCUT_VISION: "true" }).vision).toBe(true);
    expect(resolveProvider({ OPENROUTER_API_KEY: "or" }).vision).toBe(true);
  });
});
