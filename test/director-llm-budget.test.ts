import { afterEach, describe, expect, it } from "vitest";
import {
  BudgetedLlmClient,
  OpenAICompatibleClient,
  TokenBudgetExceededError,
  attemptTimeoutMs,
  escalationCeiling,
  estimateTokens,
  type ChatOptions,
} from "../src/director/llm.js";

/**
 * Run-level LLM budget: the wrapper must meter what the inner client may have
 * billed, not only what a provider chose to report.
 */

type Reply =
  | { kind: "ok"; content: string; usage?: number }
  | { kind: "empty"; finish?: string; usage?: number }
  | { kind: "status"; status: number; body?: string }
  | { kind: "timeout" }
  | { kind: "refused" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function install(replies: Reply[]) {
  const sentMax: number[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    sentMax.push((JSON.parse(init!.body!) as { max_tokens: number }).max_tokens);
    const r = replies[Math.min(sentMax.length - 1, replies.length - 1)]!;
    if (r.kind === "timeout") throw new DOMException("The operation timed out.", "TimeoutError");
    if (r.kind === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (r.kind === "status") return new Response(r.body ?? "", { status: r.status });
    const message = r.kind === "ok" ? { content: r.content } : { content: "", reasoning_content: "thinking" };
    const finish = r.kind === "ok" ? "stop" : (r.finish ?? "length");
    return new Response(
      JSON.stringify({
        choices: [{ message, finish_reason: finish }],
        ...(r.usage !== undefined ? { usage: { total_tokens: r.usage } } : {}),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return sentMax;
}

const inner = () =>
  new OpenAICompatibleClient({
    apiKey: "k",
    model: "m",
    baseUrl: "https://llm.example.com/v1",
    providerLabel: "custom",
    vision: false,
    retryBaseMs: 0,
  });

const call = (llm: BudgetedLlmClient, maxTokens = 8000): Promise<string> =>
  llm.chat({ system: "s", user: [{ type: "text", text: "prompt" }], maxTokens });
const promptTokens = estimateTokens({ system: "s", user: [{ type: "text", text: "prompt" }] } as ChatOptions);

describe("run-level budget metering", () => {
  it("meters a usage-less provider at prompt estimate plus max_tokens, across two calls", async () => {
    const sentMax = install([
      { kind: "empty" }, // call 1, attempt 1: truncated, no usage block
      { kind: "ok", content: "a" }, // call 1, attempt 2 at the raised size
      { kind: "ok", content: "b" }, // call 2
    ]);
    const llm = new BudgetedLlmClient(inner(), 40_000);
    await call(llm);
    expect(sentMax).toEqual([8000, 16000]);
    // the empty attempt and the answering attempt both billed their worst case
    expect(llm.meteredTokens).toBe(promptTokens * 2 + 8000 + 16000);
    await call(llm);
    expect(llm.meteredTokens).toBe(promptTokens * 3 + 8000 + 16000 + 8000);
    // 32k spent: a third 8k call no longer fits the 40k run budget
    await expect(call(llm)).rejects.toBeInstanceOf(TokenBudgetExceededError);
    expect(sentMax).toHaveLength(3);
  });

  it("meters an empty-then-failed call (three usage-less empties would otherwise be free)", async () => {
    install([{ kind: "empty" }]);
    const llm = new BudgetedLlmClient(inner(), 100_000);
    await expect(call(llm)).rejects.toThrow(/empty response/);
    expect(llm.meteredTokens).toBe(promptTokens * 2 + 8000 + 16000);
  });

  it("charges a timed-out attempt at its worst case and tries once more at the accepted size", async () => {
    const sentMax = install([{ kind: "timeout" }]);
    const llm = new BudgetedLlmClient(inner(), 100_000);
    await expect(call(llm)).rejects.toThrow(/timed out/);
    expect(sentMax).toEqual([8000, 8000]);
    expect(llm.meteredTokens).toBe(2 * (promptTokens + 8000));
    expect(llm.breakdown()).toMatch(/analyze \d+/);
  });

  it("does not charge for a connection that never reached the provider", async () => {
    install([{ kind: "refused" }]);
    const llm = new BudgetedLlmClient(inner(), 100_000);
    await expect(call(llm)).rejects.toThrow(/network/);
    expect(llm.meteredTokens).toBe(0);
  });

  it("a timeout after a truncated escalation falls back to the accepted size", async () => {
    const sentMax = install([{ kind: "empty", usage: 8020 }, { kind: "timeout" }, { kind: "ok", content: "x", usage: 100 }]);
    const llm = new BudgetedLlmClient(inner(), 100_000);
    await expect(call(llm)).resolves.toBe("x");
    expect(sentMax).toEqual([8000, 16000, 8000]);
    expect(llm.meteredTokens).toBe(8020 + (promptTokens + 16000) + 100);
  });
});

describe("retry caps", () => {
  it("retries an empty answer at most once, with raised max_tokens", async () => {
    const sentMax = install([{ kind: "empty" }]);
    await expect(inner().chat({ system: "s", user: [{ type: "text", text: "p" }], maxTokens: 8000 })).rejects.toThrow(
      /empty response/,
    );
    expect(sentMax).toEqual([8000, 16000]);
  });

  it("does not raise max_tokens when the empty answer was not a truncation", async () => {
    const sentMax = install([{ kind: "empty", finish: "stop" }, { kind: "ok", content: "y" }]);
    await expect(inner().chat({ system: "s", user: [{ type: "text", text: "p" }], maxTokens: 8000 })).resolves.toBe("y");
    expect(sentMax).toEqual([8000, 8000]);
  });

  it("a 400 that does not blame the output size fails at once instead of burning attempts", async () => {
    const sentMax = install([{ kind: "empty" }, { kind: "status", status: 400, body: "invalid json_schema" }]);
    await expect(inner().chat({ system: "s", user: [{ type: "text", text: "p" }], maxTokens: 8000 })).rejects.toThrow(
      /rejected \(400/,
    );
    expect(sentMax).toEqual([8000, 16000]);
  });

  it("a 400 that blames max_tokens at the escalated size falls back to the accepted size", async () => {
    const sentMax = install([
      { kind: "empty" },
      { kind: "status", status: 400, body: "max_tokens is too large for this model" },
      { kind: "ok", content: "z" },
    ]);
    await expect(inner().chat({ system: "s", user: [{ type: "text", text: "p" }], maxTokens: 8000 })).resolves.toBe("z");
    expect(sentMax).toEqual([8000, 16000, 8000]);
  });
});

describe("attempt timeout", () => {
  it("keeps a 240s floor for small requests and sizes the default request for 30 tok/s", () => {
    expect(attemptTimeoutMs(1000)).toBe(240_000);
    expect(attemptTimeoutMs(8000)).toBeGreaterThanOrEqual(240_000);
    expect(attemptTimeoutMs(8000)).toBeLessThanOrEqual(270_000);
  });

  it("scales with max_tokens so an escalated attempt can finish, up to a 10 minute cap", () => {
    expect(attemptTimeoutMs(16_000)).toBeGreaterThan(240_000);
    expect(attemptTimeoutMs(16_000)).toBeLessThanOrEqual(600_000);
    expect(attemptTimeoutMs(500_000)).toBe(600_000);
  });

  it("never escalates beyond what the longest timeout can deliver", () => {
    expect(escalationCeiling(8000)).toBe(16_000);
    expect(escalationCeiling(32_000)).toBe(32_000); // already past what the timeout delivers: no escalation
    expect(escalationCeiling(12_000)).toBe(18_000);
  });
});
