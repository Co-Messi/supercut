/** Conservative prompt redaction for common secrets and direct identifiers. */
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|token|password|secret|bearer)\s*[:=]\s*([^\s,;"']+)/gi;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const LONG_HEX = /\b[a-f0-9]{32,}\b/gi;

export function redactForPrompt(text: string): string {
  return text
    .replace(EMAIL, "[REDACTED_EMAIL]")
    .replace(OPENAI_STYLE_KEY, "[REDACTED_KEY]")
    .replace(LONG_HEX, "[REDACTED_TOKEN]")
    .replace(SECRET_ASSIGNMENT, (_m, key: string) => `${key}=[REDACTED]`);
}
