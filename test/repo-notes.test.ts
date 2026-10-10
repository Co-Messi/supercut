import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { repoNotes } from "../src/director/generate.js";
import { redactForPrompt } from "../src/security/redaction.js";

/**
 * --repo notes (README.md or package.json) go into the analyze prompt. A
 * malicious repo can make README.md a symlink to ~/.aws/credentials, so a
 * symlink is never read, exactly as the source walk already refuses them.
 */

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const dir = mkdtempSync(join(tmpdir(), "supercut-notes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("repoNotes", () => {
  it("never follows a symlinked README into a file outside the repo", () => {
    const outside = join(dir, "credentials");
    writeFileSync(outside, `[default]\naws_secret_access_key = ${SECRET}\n`);
    const repo = mkdtempSync(join(dir, "evil-"));
    symlinkSync(outside, join(repo, "README.md"));
    expect(repoNotes(repo) ?? "").not.toContain(SECRET);
  });

  it("still reads a regular README", () => {
    const repo = mkdtempSync(join(dir, "good-"));
    writeFileSync(join(repo, "README.md"), "# Lumon\nMetrics for teams.");
    expect(repoNotes(repo)).toContain("Metrics for teams.");
  });
});

describe("secret assignments with a prefixed key name", () => {
  it("redacts aws_secret_access_key and friends, where \\b never fires after an underscore", () => {
    for (const line of [
      `aws_secret_access_key = ${SECRET}`,
      `AWS_SECRET_ACCESS_KEY=${SECRET}`,
      `stripe_api_key: ${SECRET}`,
      `db_password=${SECRET}`,
      `github_token = ${SECRET}`,
    ]) {
      expect(redactForPrompt(line), line).not.toContain(SECRET);
    }
    expect(redactForPrompt("the token bucket refills")).toBe("the token bucket refills");
  });
});
