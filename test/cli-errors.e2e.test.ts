import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Mistakes in how the CLI is invoked must end in one short message plus the
 * command's usage line, never a raw Node or Zod stack. None of these cases
 * reach a browser, so they are cheap.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = join(root, "node_modules", ".bin", "tsx");
const cli = join(root, "src", "cli", "index.ts");
const cwd = mkdtempSync(join(tmpdir(), "supercut-cli-errors-"));

afterAll(() => rmSync(cwd, { recursive: true, force: true }));

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(tsx, [cli, ...args], { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const noRawStack = (s: string) => {
  expect(s).not.toMatch(/\n\s+at .*\(/); // node stack frames
  expect(s).not.toMatch(/ZodError|ERR_PARSE_ARGS|\[\s*\{\s*"code"/);
};

describe("CLI usage errors", () => {
  it("an unknown flag prints a short message and the command's usage", async () => {
    const { code, stderr } = await run(["record", "--recipe", "x.json", "--bogus"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown option --bogus/);
    expect(stderr).toMatch(/usage: supercut record/);
    noRawStack(stderr);
  });

  it("a flag missing its value says so", async () => {
    const { code, stderr } = await run(["render", "--take"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/option --take needs a value/);
    expect(stderr).toMatch(/usage: supercut render/);
    noRawStack(stderr);
  });

  it("a missing recipe file is a plain message, not an ENOENT stack", async () => {
    const { code, stderr } = await run(["record", "--recipe", join(cwd, "nope.json")]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/cannot read recipe .*nope\.json: no such file/);
    expect(stderr).toMatch(/usage: supercut record/);
    noRawStack(stderr);
  });

  it("a recipe that is not JSON names the file", async () => {
    const f = join(cwd, "broken.json");
    writeFileSync(f, "{ not json");
    const { code, stderr } = await run(["record", "--recipe", f]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/broken\.json is not valid JSON/);
    noRawStack(stderr);
  });

  it("a schema-invalid recipe lists path: message lines and the usage", async () => {
    const f = join(cwd, "invalid.json");
    writeFileSync(f, JSON.stringify({ version: 0, app_url: "http://127.0.0.1:1", scenes: [{ name: "a" }] }));
    const { code, stderr } = await run(["record", "--recipe", f]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/invalid\.json is not a valid recipe:/);
    expect(stderr).toMatch(/scenes\.0\.\w+: /);
    expect(stderr).toMatch(/usage: supercut record/);
    noRawStack(stderr);
  });

  it("--seed is validated before the recipe file is even read", async () => {
    const { code, stderr } = await run(["record", "--recipe", join(cwd, "nope.json"), "--seed=-3"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/invalid --seed "-3"/);
    expect(stderr).not.toMatch(/cannot read recipe/);
  });

  it("a missing take directory is explained", async () => {
    const { code, stderr } = await run(["render", "--take", join(cwd, "no-take")]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/take directory .* not found/);
    noRawStack(stderr);
  });

  it("generate rejects a bad --seed before reading .env or doing any work", async () => {
    const { code, stderr } = await run(["generate", "--url", "http://127.0.0.1:9/", "--seed", "abc", "--yes"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/invalid --seed "abc"/);
    expect(stderr).toMatch(/usage: supercut generate/);
  });

  it("record against an app that is not listening exits nonzero with a URL and port hint", async () => {
    const f = join(cwd, "dead.json");
    writeFileSync(
      f,
      JSON.stringify({
        version: 0,
        app_url: "http://127.0.0.1:4399",
        music_track: "off",
        scenes: [
          {
            name: "home",
            priority: 1,
            entry: { url: "http://127.0.0.1:4399/", prelude: [] },
            depends_on: [],
            actions: [{ kind: "click", selector: "#x", duration_ms: 1000 }],
            hold_ms: 500,
          },
        ],
      }),
    );
    const { code, stderr } = await run(["record", "--recipe", f, "--out", join(cwd, "dead-take")]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/net::ERR_CONNECTION_REFUSED/);
    expect(stderr).toMatch(/app is running at the recipe's app_url/);
    expect(stderr).not.toMatch(/Call log/);
  }, 90_000);

  it("root --help names the key generate flags and points at generate --help", async () => {
    const { code, stdout } = await run(["--help"]);
    expect(code).toBe(0);
    for (const flag of ["--url", "--repo", "--dry-run", "--yes", "--max-tokens"]) expect(stdout).toContain(flag);
    expect(stdout).toMatch(/supercut generate --help/);
  });
});
