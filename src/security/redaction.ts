/** Conservative prompt redaction for common secrets and direct identifiers.
 *  Patterns run specific → generic so a provider-shaped token is consumed by
 *  its own well-anchored rule before a broad rule (hex run, key=value) can
 *  eat part of it. Best-effort TEXT-only: it cannot cover screenshots. */

// PEM private keys: full block first, then any orphaned BEGIN line (truncated
// snippets in README/source excerpts still leak the header + key start).
const PEM_PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PEM_PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
// URL credentials: keep scheme + user (useful context), drop only the password
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):([^@/\s]+)@/gi;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g;
const GITHUB_FINE_GRAINED_TOKEN = /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;
const STRIPE_SECRET_KEY = /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g;
const STRIPE_LIVE_PUBLISHABLE_KEY = /\bpk_live_[A-Za-z0-9]{16,}\b/g;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const LONG_HEX = /\b[a-f0-9]{32,}\b/gi;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|token|password|secret|bearer)\s*[:=]\s*([^\s,;"']+)/gi;

export function redactForPrompt(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY_BLOCK, "[REDACTED_PRIVATE_KEY]")
    .replace(PEM_PRIVATE_KEY_BEGIN, "[REDACTED_PRIVATE_KEY]")
    .replace(URL_CREDENTIALS, "$1:[REDACTED]@")
    .replace(AWS_ACCESS_KEY_ID, "[REDACTED_KEY]")
    .replace(GITHUB_FINE_GRAINED_TOKEN, "[REDACTED_KEY]")
    .replace(GITHUB_TOKEN, "[REDACTED_KEY]")
    .replace(JWT, "[REDACTED_TOKEN]")
    .replace(SLACK_TOKEN, "[REDACTED_KEY]")
    .replace(STRIPE_SECRET_KEY, "[REDACTED_KEY]")
    .replace(STRIPE_LIVE_PUBLISHABLE_KEY, "[REDACTED_KEY]")
    .replace(EMAIL, "[REDACTED_EMAIL]")
    .replace(OPENAI_STYLE_KEY, "[REDACTED_KEY]")
    .replace(LONG_HEX, "[REDACTED_TOKEN]")
    .replace(SECRET_ASSIGNMENT, (_m, key: string) => `${key}=[REDACTED]`);
}
