import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../src/harness.js";
import { loadSkillMetadata } from "../src/skill-context.js";

describe("agent harness", () => {
  it("registers default filesystem tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-default-tools-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: default-tools-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Default Tools Agent
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const names = harness.listTools().map((tool) => tool.name);

    expect(names).toContain("list_directory");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
  });

  it("disables write_file by default in production environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-prod-tools-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: prod-tools-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Prod Tools Agent
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir, environment: "production" });
    await harness.initialize();
    const names = harness.listTools().map((tool) => tool.name);

    expect(names).toContain("list_directory");
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
  });

  it("allows disabling built-in tools via poncho.config.js", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-disable-default-tools-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: disable-default-tools-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Disable Default Tools Agent
`,
      "utf8",
    );
    await writeFile(
      join(dir, "poncho.config.js"),
      `export default {
  tools: {
    defaults: {
      read_file: false
    }
  }
};
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir, environment: "production" });
    await harness.initialize();
    const names = harness.listTools().map((tool) => tool.name);
    expect(names).toContain("list_directory");
    expect(names).not.toContain("read_file");
  });

  it("supports per-environment tool overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-env-tool-overrides-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: env-tool-overrides-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Env Tool Overrides Agent
`,
      "utf8",
    );
    await writeFile(
      join(dir, "poncho.config.js"),
      `export default {
  tools: {
    defaults: {
      read_file: false
    },
    byEnvironment: {
      development: {
        read_file: true
      },
      production: {
        write_file: false
      }
    }
  }
};
`,
      "utf8",
    );

    const developmentHarness = new AgentHarness({ workingDir: dir, environment: "development" });
    await developmentHarness.initialize();
    const developmentTools = developmentHarness.listTools().map((tool) => tool.name);
    expect(developmentTools).toContain("read_file");
    expect(developmentTools).toContain("write_file");

    const productionHarness = new AgentHarness({ workingDir: dir, environment: "production" });
    await productionHarness.initialize();
    const productionTools = productionHarness.listTools().map((tool) => tool.name);
    expect(productionTools).not.toContain("read_file");
    expect(productionTools).not.toContain("write_file");
  });

  it("does not auto-register exported tool objects from skill scripts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-no-auto-tool-register-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: no-auto-tool-register-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# No Auto Tool Register Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "summarize", "scripts"), { recursive: true });
    await writeFile(
      join(dir, "skills", "summarize", "SKILL.md"),
      `---
name: summarize
description: Summarize text
---

# Summarize Skill
`,
      "utf8",
    );
    await writeFile(
      join(dir, "skills", "summarize", "scripts", "summarize.ts"),
      `import { defineTool } from "@poncho-ai/sdk";

export default defineTool({
  name: "summarize_text",
  description: "Summarize input text",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string" }
    },
    required: ["content"]
  },
  async handler(input) {
    return { summary: String(input.content).slice(0, 20) };
  }
});
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const names = harness.listTools().map((tool) => tool.name);

    expect(names).not.toContain("summarize_text");
    expect(names).toContain("run_skill_script");
  });

  it("refreshes skill metadata and tools in development mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-skill-refresh-dev-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: skill-refresh-dev-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Skill Refresh Dev Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "alpha"), { recursive: true });
    await writeFile(
      join(dir, "skills", "alpha", "SKILL.md"),
      `---
name: alpha
description: Alpha skill
---

# Alpha
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir, environment: "development" });
    await harness.initialize();
    const activateBefore = harness.listTools().find((tool) => tool.name === "activate_skill");
    expect(activateBefore).toBeDefined();
    const unknownBefore = await activateBefore!.handler({ name: "beta" }, {} as any);
    expect(unknownBefore).toMatchObject({
      error: expect.stringContaining('Unknown skill: "beta"'),
    });

    await mkdir(join(dir, "skills", "beta"), { recursive: true });
    await writeFile(
      join(dir, "skills", "beta", "SKILL.md"),
      `---
name: beta
description: Beta skill
---

# Beta
`,
      "utf8",
    );
    await (harness as any).refreshSkillsIfChanged();

    const activateAfter = harness.listTools().find((tool) => tool.name === "activate_skill");
    expect(activateAfter).toBeDefined();
    const activated = await activateAfter!.handler({ name: "beta" }, {} as any);
    expect(activated).toMatchObject({ skill: "beta" });
  });

  it("prunes removed active skills after refresh in development mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-skill-refresh-prune-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: skill-refresh-prune-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Skill Refresh Prune Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "obsolete"), { recursive: true });
    await writeFile(
      join(dir, "skills", "obsolete", "SKILL.md"),
      `---
name: obsolete
description: Obsolete skill
---

# Obsolete
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir, environment: "development" });
    await harness.initialize();
    const activate = harness.listTools().find((tool) => tool.name === "activate_skill");
    const listActive = harness.listTools().find((tool) => tool.name === "list_active_skills");
    expect(activate).toBeDefined();
    expect(listActive).toBeDefined();
    await activate!.handler({ name: "obsolete" }, {} as any);
    expect(await listActive!.handler({}, {} as any)).toEqual({ activeSkills: ["obsolete"] });

    await rm(join(dir, "skills", "obsolete"), { recursive: true, force: true });
    await (harness as any).refreshSkillsIfChanged();
    expect(await listActive!.handler({}, {} as any)).toEqual({ activeSkills: [] });

    const activateAfter = harness.listTools().find((tool) => tool.name === "activate_skill");
    const afterRemoval = await activateAfter!.handler({ name: "obsolete" }, {} as any);
    expect(afterRemoval).toMatchObject({
      error: expect.stringContaining('Unknown skill: "obsolete"'),
    });
  });

  it("does not refresh skills outside development mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-skill-refresh-prod-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: skill-refresh-prod-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Skill Refresh Prod Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "alpha"), { recursive: true });
    await writeFile(
      join(dir, "skills", "alpha", "SKILL.md"),
      `---
name: alpha
description: Alpha skill
---

# Alpha
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir, environment: "production" });
    await harness.initialize();
    await mkdir(join(dir, "skills", "beta"), { recursive: true });
    await writeFile(
      join(dir, "skills", "beta", "SKILL.md"),
      `---
name: beta
description: Beta skill
---

# Beta
`,
      "utf8",
    );

    await (harness as any).refreshSkillsIfChanged();
    const activate = harness.listTools().find((tool) => tool.name === "activate_skill");
    expect(activate).toBeDefined();
    const unknown = await activate!.handler({ name: "beta" }, {} as any);
    expect(unknown).toMatchObject({
      error: expect.stringContaining('Unknown skill: "beta"'),
    });
  });

  it("clears active skills when skill metadata changes in development mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-skill-refresh-clear-active-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: skill-refresh-clear-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Skill Refresh Clear Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "alpha"), { recursive: true });
    await writeFile(
      join(dir, "skills", "alpha", "SKILL.md"),
      `---
name: alpha
description: Alpha skill
---

# Alpha
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir, environment: "development" });
    await harness.initialize();
    const activate = harness.listTools().find((tool) => tool.name === "activate_skill");
    const listActive = harness.listTools().find((tool) => tool.name === "list_active_skills");
    expect(activate).toBeDefined();
    expect(listActive).toBeDefined();

    await activate!.handler({ name: "alpha" }, {} as any);
    expect(await listActive!.handler({}, {} as any)).toEqual({ activeSkills: ["alpha"] });

    await writeFile(
      join(dir, "skills", "alpha", "SKILL.md"),
      `---
name: alpha
description: Alpha skill updated
---

# Alpha Updated
`,
      "utf8",
    );
    await (harness as any).refreshSkillsIfChanged();
    expect(await listActive!.handler({}, {} as any)).toEqual({ activeSkills: [] });
  });

  it("lists skill scripts through list_skill_scripts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-skill-script-list-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: skill-script-list-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Skill Script List Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "math", "scripts", "nested"), { recursive: true });
    await writeFile(
      join(dir, "skills", "math", "SKILL.md"),
      `---
name: math
description: Simple math scripts
---

# Math Skill
`,
      "utf8",
    );
    await writeFile(
      join(dir, "skills", "math", "scripts", "add.ts"),
      "export default async function run() { return { ok: true }; }\n",
      "utf8",
    );
    await writeFile(
      join(dir, "skills", "math", "scripts", "nested", "multiply.js"),
      "export async function run() { return { ok: true }; }\n",
      "utf8",
    );
    await writeFile(
      join(dir, "skills", "math", "fetch-page.ts"),
      "export default async function run() { return { ok: true, root: true }; }\n",
      "utf8",
    );
    await writeFile(
      join(dir, "skills", "math", "scripts", "README.md"),
      "# not executable\n",
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const listScripts = harness.listTools().find((tool) => tool.name === "list_skill_scripts");

    expect(listScripts).toBeDefined();
    const result = await listScripts!.handler({ skill: "math" });
    expect(result).toEqual({
      skill: "math",
      scripts: ["./fetch-page.ts", "scripts/add.ts", "scripts/nested/multiply.js"],
    });
  });

  it("runs JavaScript/TypeScript skill scripts through run_skill_script", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-skill-script-runner-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: skill-script-runner-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Skill Script Runner Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "math", "scripts"), { recursive: true });
    await writeFile(
      join(dir, "skills", "math", "SKILL.md"),
      `---
name: math
description: Simple math scripts
---

# Math Skill
`,
      "utf8",
    );
    await writeFile(
      join(dir, "skills", "math", "scripts", "add.ts"),
      `export default async function run(input) {
  const a = Number(input?.a ?? 0);
  const b = Number(input?.b ?? 0);
  return { sum: a + b };
}
`,
      "utf8",
    );
    await writeFile(
      join(dir, "skills", "math", "fetch-page.ts"),
      `export default async function run() {
  return { kind: "root-script" };
}
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const runner = harness.listTools().find((tool) => tool.name === "run_skill_script");

    expect(runner).toBeDefined();
    const result = await runner!.handler({
      skill: "math",
      script: "scripts/add.ts",
      input: { a: 2, b: 3 },
    });
    expect(result).toEqual({
      skill: "math",
      script: "./scripts/add.ts",
      output: { sum: 5 },
    });
    const rootResult = await runner!.handler({
      skill: "math",
      script: "./fetch-page.ts",
    });
    expect(rootResult).toEqual({
      skill: "math",
      script: "./fetch-page.ts",
      output: { kind: "root-script" },
    });
  });

  it("runs AGENT-scope scripts from root scripts directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-root-script-run-"));
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(
      join(dir, "scripts", "ping.ts"),
      "export default async function run() { return { pong: true }; }\n",
      "utf8",
    );
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: root-run-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Root Run Agent
`,
      "utf8",
    );
    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const runner = harness.listTools().find((tool) => tool.name === "run_skill_script");
    expect(runner).toBeDefined();
    const result = await runner!.handler({ script: "scripts/ping.ts" });
    expect(result).toEqual({
      skill: null,
      script: "./scripts/ping.ts",
      output: { pong: true },
    });
  });

  it("blocks path traversal in run_skill_script", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-skill-script-path-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: skill-script-path-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Skill Script Path Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "safe", "scripts"), { recursive: true });
    await writeFile(
      join(dir, "skills", "safe", "SKILL.md"),
      `---
name: safe
description: Safe skill
---

# Safe Skill
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const runner = harness.listTools().find((tool) => tool.name === "run_skill_script");
    expect(runner).toBeDefined();
    const result = await runner!.handler({
      skill: "safe",
      script: "../outside.ts",
    });
    expect(result).toMatchObject({
      error: expect.stringContaining("must be relative and within the allowed directory"),
    });
  });

  it("requires allowed-tools entries for non-standard script directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-script-allowed-tools-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: script-policy-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Script Policy Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "math", "scripts"), { recursive: true });
    await mkdir(join(dir, "skills", "math", "tools"), { recursive: true });
    await writeFile(
      join(dir, "skills", "math", "SKILL.md"),
      `---
name: math
description: Math scripts
allowed-tools:
  - ./tools/multiply.ts
---

# Math
`,
      "utf8",
    );
    await writeFile(
      join(dir, "skills", "math", "scripts", "add.ts"),
      "export default async function run() { return { ok: true }; }\n",
      "utf8",
    );
    await writeFile(
      join(dir, "skills", "math", "tools", "multiply.ts"),
      "export default async function run() { return { ok: true, kind: 'tools' }; }\n",
      "utf8",
    );
    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const listScripts = harness.listTools().find((tool) => tool.name === "list_skill_scripts");
    const runScript = harness.listTools().find((tool) => tool.name === "run_skill_script");
    expect(listScripts).toBeDefined();
    expect(runScript).toBeDefined();
    const listed = await listScripts!.handler({ skill: "math" });
    expect(listed).toEqual({
      skill: "math",
      scripts: ["scripts/add.ts", "tools/multiply.ts"],
    });
    const result = await runScript!.handler({ skill: "math", script: "scripts/add.ts" });
    expect(result).toMatchObject({ output: { ok: true } });
    const toolsResult = await runScript!.handler({
      skill: "math",
      script: "./tools/multiply.ts",
    });
    expect(toolsResult).toMatchObject({ output: { ok: true, kind: "tools" } });
  });



  it("parses spec-style allowed-tools from SKILL.md frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-allowed-tools-"));
    await mkdir(join(dir, "skills", "summarize"), { recursive: true });
    await writeFile(
      join(dir, "skills", "summarize", "SKILL.md"),
      `---
name: summarize
description: Summarize text
allowed-tools:
  - mcp:linear/list_issues
  - mcp:linear/get_issue
---

# Summarize
`,
      "utf8",
    );

    const metadata = await loadSkillMetadata(dir);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.name).toBe("summarize");
    expect(metadata[0]?.allowedTools.mcp).toEqual(["linear/list_issues", "linear/get_issue"]);
    expect(metadata[0]?.allowedTools.scripts).toEqual([]);
    expect(metadata[0]?.approvalRequired.mcp).toEqual([]);
    expect(metadata[0]?.approvalRequired.scripts).toEqual([]);
  });

  it("parses approval-required patterns from SKILL.md frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-approval-required-"));
    await mkdir(join(dir, "skills", "triage"), { recursive: true });
    await writeFile(
      join(dir, "skills", "triage", "SKILL.md"),
      `---
name: triage
description: Triage
allowed-tools:
  - mcp:github/list_issues
  - mcp:github/create_issue
  - ./tools/open-pr.ts
approval-required:
  - mcp:github/create_issue
  - ./scripts/review.ts
  - ./tools/open-pr.ts
---

# Triage
`,
      "utf8",
    );
    const metadata = await loadSkillMetadata(dir);
    expect(metadata[0]?.approvalRequired.mcp).toEqual(["github/create_issue"]);
    expect(metadata[0]?.approvalRequired.scripts).toEqual([
      "./scripts/review.ts",
      "./tools/open-pr.ts",
    ]);
  });

  it("fails when SKILL.md includes invalid non-slash tool patterns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-invalid-tools-"));
    await mkdir(join(dir, "skills", "legacy"), { recursive: true });
    await writeFile(
      join(dir, "skills", "legacy", "SKILL.md"),
      `---
name: legacy
description: Legacy skill
allowed-tools:
  - mcp:legacy_tool
---

# Legacy
`,
      "utf8",
    );

    await expect(loadSkillMetadata(dir)).rejects.toThrow(
      /Invalid MCP tool pattern/,
    );
  });

  it("registers MCP tools dynamically for stacked active skills and supports deactivation", async () => {
    process.env.LINEAR_TOKEN = "token-123";
    const mcpServer = createServer(async (req, res) => {
      if (req.method === "DELETE") {
        res.statusCode = 200;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = body.trim().length > 0 ? (JSON.parse(body) as any) : {};
      if (payload.method === "initialize") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Mcp-Session-Id", "sess");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "remote", version: "1.0.0" },
            },
          }),
        );
        return;
      }
      if (payload.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (payload.method === "tools/list") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              tools: [
                { name: "a", inputSchema: { type: "object", properties: {} } },
                { name: "b", inputSchema: { type: "object", properties: {} } },
              ],
            },
          }),
        );
        return;
      }
      if (payload.method === "tools/call") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { result: { ok: true } },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveOpen) => mcpServer.listen(0, () => resolveOpen()));
    const address = mcpServer.address();
    if (!address || typeof address === "string") throw new Error("Unexpected address");
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-stacked-activation-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: stacked-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Stacked Agent
`,
      "utf8",
    );
    await writeFile(
      join(dir, "poncho.config.js"),
      `export default {
  mcp: [
    {
      name: "remote",
      url: "http://127.0.0.1:${address.port}/mcp",
      auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" }
    }
  ]
};
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "skill-a"), { recursive: true });
    await mkdir(join(dir, "skills", "skill-b"), { recursive: true });
    await writeFile(
      join(dir, "skills", "skill-a", "SKILL.md"),
      `---
name: skill-a
description: A
allowed-tools:
  - mcp:remote/a
---
# A
`,
      "utf8",
    );
    await writeFile(
      join(dir, "skills", "skill-b", "SKILL.md"),
      `---
name: skill-b
description: B
allowed-tools:
  - mcp:remote/b
---
# B
`,
      "utf8",
    );
    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    expect(harness.listTools().map((tool) => tool.name)).not.toContain("remote/a");
    expect(harness.listTools().map((tool) => tool.name)).not.toContain("remote/b");
    const activate = harness.listTools().find((tool) => tool.name === "activate_skill");
    const deactivate = harness.listTools().find((tool) => tool.name === "deactivate_skill");
    expect(activate).toBeDefined();
    expect(deactivate).toBeDefined();
    await activate!.handler({ name: "skill-a" }, {} as any);
    expect(harness.listTools().map((tool) => tool.name)).toContain("remote/a");
    expect(harness.listTools().map((tool) => tool.name)).not.toContain("remote/b");
    await activate!.handler({ name: "skill-b" }, {} as any);
    const afterStack = harness.listTools().map((tool) => tool.name);
    expect(afterStack).toContain("remote/a");
    expect(afterStack).toContain("remote/b");
    await deactivate!.handler({ name: "skill-a" }, {} as any);
    const afterDeactivate = harness.listTools().map((tool) => tool.name);
    expect(afterDeactivate).not.toContain("remote/a");
    expect(afterDeactivate).toContain("remote/b");
    await harness.shutdown();
    await new Promise<void>((resolveClose) => mcpServer.close(() => resolveClose()));
  });

  it("allows in-flight MCP calls to finish after skill deactivation", async () => {
    process.env.LINEAR_TOKEN = "token-123";
    const mcpServer = createServer(async (req, res) => {
      if (req.method === "DELETE") {
        res.statusCode = 200;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = body.trim().length > 0 ? (JSON.parse(body) as any) : {};
      if (payload.method === "initialize") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Mcp-Session-Id", "sess");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "remote", version: "1.0.0" },
            },
          }),
        );
        return;
      }
      if (payload.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return;
      }
      if (payload.method === "tools/list") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { tools: [{ name: "slow", inputSchema: { type: "object", properties: {} } }] },
          }),
        );
        return;
      }
      if (payload.method === "tools/call") {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { result: { done: true } } }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveOpen) => mcpServer.listen(0, () => resolveOpen()));
    const address = mcpServer.address();
    if (!address || typeof address === "string") throw new Error("Unexpected address");
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-inflight-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: inflight-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Inflight
`,
      "utf8",
    );
    await writeFile(
      join(dir, "poncho.config.js"),
      `export default {
  mcp: [
    {
      name: "remote",
      url: "http://127.0.0.1:${address.port}/mcp",
      auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" }
    }
  ]
};
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "skill-slow"), { recursive: true });
    await writeFile(
      join(dir, "skills", "skill-slow", "SKILL.md"),
      `---
name: skill-slow
description: Slow
allowed-tools:
  - mcp:remote/slow
---
# Slow
`,
      "utf8",
    );
    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const activate = harness.listTools().find((tool) => tool.name === "activate_skill");
    const deactivate = harness.listTools().find((tool) => tool.name === "deactivate_skill");
    await activate!.handler({ name: "skill-slow" }, {} as any);
    const slowTool = harness.listTools().find((tool) => tool.name === "remote/slow");
    expect(slowTool).toBeDefined();
    const inFlight = slowTool!.handler({}, {} as any);
    await deactivate!.handler({ name: "skill-slow" }, {} as any);
    const output = await inFlight;
    expect(output).toEqual({ done: true });
    await harness.shutdown();
    await new Promise<void>((resolveClose) => mcpServer.close(() => resolveClose()));
  });

});
