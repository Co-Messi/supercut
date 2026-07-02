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

  it("redacts AWS access key IDs", () => {
    for (const key of [["AKIA", "IOSFODNN7EXAMPLE"].join(""), ["ASIA", "JEXAMPLEKEY12345"].join("")]) {
      expect(redactForPrompt(`creds: ${key}`)).not.toContain(key);
    }
    expect(redactForPrompt(["AKIA", "IOSFODNN7EXAMPLE"].join(""))).toContain("[REDACTED_KEY]");
  });

  it("redacts GitHub classic and fine-grained tokens", () => {
    // fixture tokens are split so secret scanners never see a contiguous literal
    const classic = ["ghp", "_16C7e42F292c6912E7710c838347Ae178B4a"].join("");
    const fineGrained = ["github_pat", "_11ABCDEFG0123456789abcdefghijklmnop"].join("");
    const out = redactForPrompt(`push with ${classic} or ${fineGrained}`);
    expect(out).not.toContain(classic);
    expect(out).not.toContain(fineGrained);
    expect(out).toContain("[REDACTED_KEY]");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactForPrompt(`Authorization: Bearer ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("[REDACTED_TOKEN]");
  });

  it("redacts Slack tokens", () => {
    // split literal — see the GitHub-tokens test
    const token = ["xoxb", "-1234567890-abcdefghijklmnop"].join("");
    const out = redactForPrompt(`SLACK ${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED_KEY]");
  });

  it("redacts Stripe secret, restricted, and live publishable keys", () => {
    // split literals — see the GitHub-tokens test
    for (const key of [
      ["sk", "_live_abcdefghijklmnop1234"].join(""),
      ["sk", "_test_abcdefghijklmnop1234"].join(""),
      ["rk", "_live_abcdefghijklmnop1234"].join(""),
      ["pk", "_live_abcdefghijklmnop1234"].join(""),
    ]) {
      const out = redactForPrompt(`stripe ${key}`);
      expect(out, key).not.toContain(key);
      expect(out).toContain("[REDACTED_KEY]");
    }
  });

  it("redacts PEM private key blocks and orphaned BEGIN lines", () => {
    const block =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7\nmore\n-----END RSA PRIVATE KEY-----";
    const blockOut = redactForPrompt(`config:\n${block}\nrest`);
    expect(blockOut).not.toContain("MIIEpAIBAAKCAQEA7");
    expect(blockOut).toContain("[REDACTED_PRIVATE_KEY]");
    // truncated snippet: BEGIN line without a matching END still gets caught
    const loneOut = redactForPrompt("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg");
    expect(loneOut).toContain("[REDACTED_PRIVATE_KEY]");
    expect(loneOut).not.toContain("BEGIN PRIVATE KEY");
  });

  it("redacts only the password in URL credentials, keeping scheme and user", () => {
    const out = redactForPrompt("db: postgres://admin:hunter2@db.internal:5432/app");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("postgres://admin:[REDACTED]@db.internal:5432/app");
  });

  it("does NOT redact normal prose", () => {
    const prose = "Click Get started, then type your name. The meeting is at 10:30 in room 4a.";
    expect(redactForPrompt(prose)).toBe(prose);
  });

  it("does NOT redact UUIDs", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(redactForPrompt(`request id ${uuid}`)).toContain(uuid);
  });

  it("redacts opaque Authorization: Bearer tokens (header form, no :/= separator)", () => {
    // split literal — see the GitHub-tokens test
    const token = ["mF_9z-abc", ".DEF_12345"].join("");
    const out = redactForPrompt(`Authorization: Bearer ${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain("Bearer [REDACTED]");
  });

  it("does NOT redact 'Bearer' in prose", () => {
    const prose = "the Bearer of good news arrived at ten";
    expect(redactForPrompt(prose)).toBe(prose);
  });

  it("does NOT redact ordinary base64 image data URIs", () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
    expect(redactForPrompt(`<img src="${dataUri}">`)).toContain(dataUri);
  });
});
