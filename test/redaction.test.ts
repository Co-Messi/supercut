import { describe, expect, it } from "vitest";
import { redactForPrompt } from "../src/security/redaction.js";

describe("prompt redaction", () => {
  it("redacts common credentials and emails before LLM prompts", () => {
    const redacted = redactForPrompt("email ada@example.com api_key=sk-1234567890abcdef token: secret-value password=hunter2");
    expect(redacted).not.toContain("ada@example.com");
    expect(redacted).not.toContain("sk-1234567890abcdef");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("[REDACTED_EMAIL]");
    expect(redacted).toContain("api_key=[REDACTED]");
  });
});
