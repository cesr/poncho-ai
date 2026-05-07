import { describe, expect, it } from "vitest";
import { InMemoryEngine } from "../src/storage/memory-engine.js";
import {
  loadVfsSkillMetadata,
  mergeSkills,
  parseSkillFrontmatter,
  type SkillMetadata,
} from "../src/skill-context.js";

const enc = new TextEncoder();

const writeSkill = async (
  engine: InMemoryEngine,
  tenantId: string,
  dir: string,
  body: string,
) => {
  await engine.vfs.writeFile(tenantId, `/skills/${dir}/SKILL.md`, enc.encode(body));
};

const validSkill = (name: string, description = "test skill"): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.`;

describe("loadVfsSkillMetadata", () => {
  it("returns empty when /skills directory does not exist", async () => {
    const engine = new InMemoryEngine("agent");
    await engine.initialize();
    const skills = await loadVfsSkillMetadata(engine, "tenant-a");
    expect(skills).toEqual([]);
  });

  it("loads skills from /skills/<dir>/SKILL.md and tags them with vfs source", async () => {
    const engine = new InMemoryEngine("agent");
    await engine.initialize();
    await writeSkill(engine, "t1", "alpha", validSkill("alpha", "Alpha skill"));
    await writeSkill(engine, "t1", "beta", validSkill("beta", "Beta skill"));

    const skills = await loadVfsSkillMetadata(engine, "t1");
    expect(skills).toHaveLength(2);
    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get("alpha")?.source).toEqual({ kind: "vfs", tenantId: "t1" });
    expect(byName.get("alpha")?.skillDir).toBe("/skills/alpha");
    expect(byName.get("alpha")?.skillPath).toBe("/skills/alpha/SKILL.md");
    expect(byName.get("beta")?.description).toBe("Beta skill");
  });

  it("scopes by tenantId — t1 doesn't see t2's skills", async () => {
    const engine = new InMemoryEngine("agent");
    await engine.initialize();
    await writeSkill(engine, "t1", "only-t1", validSkill("only-t1"));
    await writeSkill(engine, "t2", "only-t2", validSkill("only-t2"));

    const t1 = await loadVfsSkillMetadata(engine, "t1");
    const t2 = await loadVfsSkillMetadata(engine, "t2");
    expect(t1.map((s) => s.name)).toEqual(["only-t1"]);
    expect(t2.map((s) => s.name)).toEqual(["only-t2"]);
  });

  it("warn-and-skips a malformed SKILL.md instead of throwing", async () => {
    const engine = new InMemoryEngine("agent");
    await engine.initialize();
    await writeSkill(engine, "t1", "good", validSkill("good"));
    // Invalid MCP pattern in allowed-tools triggers parser throw
    await writeSkill(
      engine,
      "t1",
      "bad",
      `---\nname: bad\ndescription: bad\nallowed-tools:\n  - "mcp:not a valid pattern with spaces"\n---\nbody`,
    );

    const skills = await loadVfsSkillMetadata(engine, "t1");
    expect(skills.map((s) => s.name)).toEqual(["good"]);
  });

  it("dedupes within a tenant when two dirs declare the same name (first wins)", async () => {
    const engine = new InMemoryEngine("agent");
    await engine.initialize();
    await writeSkill(engine, "t1", "a-dir", validSkill("samename", "first"));
    await writeSkill(engine, "t1", "z-dir", validSkill("samename", "second"));

    const skills = await loadVfsSkillMetadata(engine, "t1");
    expect(skills).toHaveLength(1);
    // readdir returns alphabetically; a-dir comes first
    expect(skills[0].description).toBe("first");
    expect(skills[0].skillDir).toBe("/skills/a-dir");
  });

  it("skips directories with no SKILL.md", async () => {
    const engine = new InMemoryEngine("agent");
    await engine.initialize();
    await engine.vfs.mkdir("t1", "/skills/empty", true);
    await writeSkill(engine, "t1", "real", validSkill("real"));

    const skills = await loadVfsSkillMetadata(engine, "t1");
    expect(skills.map((s) => s.name)).toEqual(["real"]);
  });
});

describe("mergeSkills", () => {
  const repoSkill = (name: string): SkillMetadata => ({
    name,
    description: `repo ${name}`,
    allowedTools: { mcp: [], scripts: [] },
    approvalRequired: { mcp: [], scripts: [] },
    source: { kind: "repo" },
    skillDir: `/repo/${name}`,
    skillPath: `/repo/${name}/SKILL.md`,
  });
  const vfsSkill = (name: string): SkillMetadata => ({
    name,
    description: `vfs ${name}`,
    allowedTools: { mcp: [], scripts: [] },
    approvalRequired: { mcp: [], scripts: [] },
    source: { kind: "vfs", tenantId: "t1" },
    skillDir: `/skills/${name}`,
    skillPath: `/skills/${name}/SKILL.md`,
  });

  it("repo wins on name collision and onCollision is invoked once for the dropped vfs skill", () => {
    const dropped: string[] = [];
    const merged = mergeSkills(
      [repoSkill("foo"), repoSkill("bar")],
      [vfsSkill("foo"), vfsSkill("baz")],
      (s) => dropped.push(s.name),
    );
    expect(merged.map((s) => s.name)).toEqual(["foo", "bar", "baz"]);
    expect(merged.find((s) => s.name === "foo")?.source.kind).toBe("repo");
    expect(merged.find((s) => s.name === "baz")?.source.kind).toBe("vfs");
    expect(dropped).toEqual(["foo"]);
  });

  it("works without an onCollision callback", () => {
    const merged = mergeSkills([repoSkill("foo")], [vfsSkill("foo"), vfsSkill("bar")]);
    expect(merged.map((s) => s.name)).toEqual(["foo", "bar"]);
  });
});

describe("parseSkillFrontmatter (export)", () => {
  it("parses a minimal SKILL.md", () => {
    const parsed = parseSkillFrontmatter("---\nname: x\ndescription: d\n---\nBody");
    expect(parsed?.name).toBe("x");
    expect(parsed?.description).toBe("d");
  });

  it("returns undefined when frontmatter is absent", () => {
    const parsed = parseSkillFrontmatter("just a body, no frontmatter");
    expect(parsed).toBeUndefined();
  });
});
