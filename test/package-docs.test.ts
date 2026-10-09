import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRecipe } from "../src/schema/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("agent skill and plugin packaging", () => {
  const skill = read(".claude/skills/supercut/SKILL.md");

  it("the skill's example recipe passes the real parser", () => {
    const blocks = [...skill.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(() => parseRecipe(JSON.parse(b))).not.toThrow();
  });

  it("the skill has frontmatter naming itself", () => {
    expect(skill).toMatch(/^---\nname: supercut\ndescription: .+\n---/);
  });

  it("the skill states the safety rules", () => {
    expect(skill).toMatch(/staging or local dev/i);
    expect(skill).toMatch(/destructive controls/i);
  });

  it("the skill's render command passes the recipe's music track (render never reads the recipe)", () => {
    const render = [...skill.matchAll(/^npx @co-messi\/supercut render .*$/gm)].map((m) => m[0]);
    expect(render.length).toBeGreaterThan(0);
    for (const cmd of render) expect(cmd).toMatch(/--music \S+/);
  });

  it("the skill's length rule uses the schema's real overheads", async () => {
    const { SCENE_CHANGE_MS, TAKE_HEAD_MS, TAKE_TAIL_MS } = await import("../src/schema/index.js");
    const { FOCUS_DWELL_MS, SETTLE_TAIL_MS } = await import("../src/render/plan.js");
    expect(skill).toContain(`plus ${TAKE_HEAD_MS} ms, plus ${SCENE_CHANGE_MS} ms per scene after the first`);
    expect(skill).toContain(`${TAKE_TAIL_MS} to ${FOCUS_DWELL_MS + SETTLE_TAIL_MS} ms`);
  });

  it("the skill lists exactly the bundled music tracks", async () => {
    const { MUSIC_TRACKS } = await import("../src/director/analyze.js");
    for (const t of MUSIC_TRACKS) expect(skill).toContain(`"${t}"`);
  });

  it("plugin.json and marketplace.json agree and point at an existing skills dir", () => {
    const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as { name: string; version: string; skills: string };
    const market = JSON.parse(read(".claude-plugin/marketplace.json")) as {
      name: string;
      plugins: { name: string; source: string; version?: string }[];
    };
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(market.name).toBe("supercut");
    expect(market.plugins[0]!.name).toBe(plugin.name);
    expect(market.plugins[0]!.source).toBe("./");
    expect(plugin.version).toBe(pkg.version);
    expect(market.plugins[0]!.version).toBe(pkg.version);
    expect(existsSync(`${root}${plugin.skills.replace(/^\.\//, "")}supercut/SKILL.md`)).toBe(true);
  });
});

describe("prose style", () => {
  it.each(["README.md", "SECURITY.md", "CHANGELOG.md", "AGENTS.md", ".claude/skills/supercut/SKILL.md"])(
    "%s has no em or en dashes",
    (file) => {
      expect(read(file)).not.toMatch(/[–—]/);
    },
  );
});
