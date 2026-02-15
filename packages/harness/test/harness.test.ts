import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, Message } from "@poncho-ai/sdk";
import { defineTool } from "@poncho-ai/sdk";
import { AgentHarness } from "../src/harness.js";
import { loadSkillMetadata } from "../src/skill-context.js";

// Helper: Create minimal valid agent directory
async function createTestAgent(options: {
  name?: string;
  maxSteps?: number;
  timeout?: number;
  body?: string;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "poncho-test-agent-"));
  const frontmatter = `---
name: ${options.name ?? "test-agent"}
model:
  provider: anthropic
  name: claude-opus-4-5
${options.maxSteps ? `limits:\n  maxSteps: ${options.maxSteps}` : ""}
${options.timeout ? `limits:\n  timeout: ${options.timeout}` : ""}
---

${options.body ?? "# Test Agent"}
`;
  await writeFile(join(dir, "AGENT.md"), frontmatter, "utf8");
  return dir;
}

// Helper: Collect specific event types from event array
function collectEvents<T extends AgentEvent["type"]>(
  events: AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

// Helper: Create message array for testing window trimming
function createMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `Message ${i + 1}`,
    metadata: { id: `msg-${i}`, timestamp: Date.now() + i },
  }));
}

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

  it("injects SKILL.md context into system prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-skill-context-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: skill-context-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Skill Context Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "summarize"), { recursive: true });
    await writeFile(
      join(dir, "skills", "summarize", "SKILL.md"),
      `---
name: summarize
description: Summarize long text into concise output
tools:
  mcp:
    - linear/list_issues
---

# Summarize Skill

When users ask for summarization, prefer calling summarize_text.
`,
      "utf8",
    );

    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();

    const mockedGenerate = vi.fn().mockResolvedValueOnce({
      text: "done",
      toolCalls: [],
      usage: { input: 5, output: 5 },
      rawContent: [],
    });

    (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
      generate: mockedGenerate,
    };

    for await (const _event of harness.run({ task: "summarize this text" })) {
      // consume events
    }

    const firstCall = mockedGenerate.mock.calls[0]?.[0] as
      | { systemPrompt?: string; tools?: Array<{ name: string }> }
      | undefined;
    // Skill metadata injected as XML <available_skills> block
    expect(firstCall?.systemPrompt).toContain("<available_skills");
    expect(firstCall?.systemPrompt).toContain("<name>summarize</name>");
    expect(firstCall?.systemPrompt).toContain("Summarize long text into concise output");
    // activate_skill tool should be registered
    const toolNames = firstCall?.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("activate_skill");
    expect(toolNames).toContain("read_skill_resource");
    expect(toolNames).toContain("list_skill_scripts");
    expect(toolNames).toContain("run_skill_script");
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
      scripts: ["scripts/add.ts", "scripts/nested/multiply.js"],
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

    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const runner = harness.listTools().find((tool) => tool.name === "run_skill_script");

    expect(runner).toBeDefined();
    const result = await runner!.handler({
      skill: "math",
      script: "add.ts",
      input: { a: 2, b: 3 },
    });
    expect(result).toEqual({
      skill: "math",
      script: "add.ts",
      output: { sum: 5 },
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
      error: expect.stringContaining("must be relative and within the skill directory"),
    });
  });

  it("enforces scripts denylist policy from config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-script-policy-"));
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
    await writeFile(
      join(dir, "poncho.config.js"),
      `export default {
  scripts: {
    mode: "denylist",
    exclude: ["math/scripts/add.ts"]
  }
};
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "math", "scripts"), { recursive: true });
    await writeFile(
      join(dir, "skills", "math", "SKILL.md"),
      `---
name: math
description: Math scripts
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
    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const listScripts = harness.listTools().find((tool) => tool.name === "list_skill_scripts");
    const runScript = harness.listTools().find((tool) => tool.name === "run_skill_script");
    expect(listScripts).toBeDefined();
    expect(runScript).toBeDefined();
    const listed = await listScripts!.handler({ skill: "math" });
    expect(listed).toEqual({ skill: "math", scripts: [] });
    const result = await runScript!.handler({ skill: "math", script: "add.ts" });
    expect(result).toMatchObject({
      error: expect.stringContaining("is not allowed by policy"),
    });
  });

  it("injects local authoring guidance only in development environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-dev-guidance-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: dev-guidance-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Dev Guidance Agent
`,
      "utf8",
    );

    const developmentHarness = new AgentHarness({ workingDir: dir, environment: "development" });
    await developmentHarness.initialize();
    const devGenerate = vi.fn().mockResolvedValueOnce({
      text: "done",
      toolCalls: [],
      usage: { input: 5, output: 5 },
      rawContent: [],
    });
    (developmentHarness as unknown as { modelClient: { generate: unknown } }).modelClient = {
      generate: devGenerate,
    };
    for await (const _event of developmentHarness.run({ task: "hello" })) {
      // consume events
    }
    const devCall = devGenerate.mock.calls[0]?.[0] as { systemPrompt?: string } | undefined;
    expect(devCall?.systemPrompt).toContain("## Development Mode Context");
    expect(devCall?.systemPrompt).toContain("poncho.config.js");
    expect(devCall?.systemPrompt).toContain("skills/<skill-name>/SKILL.md");

    const productionHarness = new AgentHarness({ workingDir: dir, environment: "production" });
    await productionHarness.initialize();
    const prodGenerate = vi.fn().mockResolvedValueOnce({
      text: "done",
      toolCalls: [],
      usage: { input: 5, output: 5 },
      rawContent: [],
    });
    (productionHarness as unknown as { modelClient: { generate: unknown } }).modelClient = {
      generate: prodGenerate,
    };
    for await (const _event of productionHarness.run({ task: "hello" })) {
      // consume events
    }
    const prodCall = prodGenerate.mock.calls[0]?.[0] as { systemPrompt?: string } | undefined;
    expect(prodCall?.systemPrompt).not.toContain("## Development Mode Context");
    expect(prodCall?.systemPrompt).not.toContain("skills/<skill-name>/SKILL.md");
  });

  it("runs a tool call loop and completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: test-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Test Agent
`,
      "utf8",
    );

    const harness = new AgentHarness({
      workingDir: dir,
      toolDefinitions: [
        defineTool({
          name: "echo",
          description: "Echoes input value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          handler: async (input) => ({ echoed: input.value }),
        }),
      ],
    });
    await harness.initialize();

    const mockedGenerate = vi
      .fn()
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [{ id: "tool_1", name: "echo", input: { value: "hi" } }],
        usage: { input: 10, output: 5 },
        rawContent: [],
      })
      .mockResolvedValueOnce({
        text: "done",
        toolCalls: [],
        usage: { input: 5, output: 5 },
        rawContent: [],
      });

    (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
      generate: mockedGenerate,
    };

    const events = [];
    for await (const event of harness.run({ task: "run echo" })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "tool:completed")).toBe(true);
    expect(events.some((event) => event.type === "run:completed")).toBe(true);
  });

  it("emits approval events and denies requiresApproval tools by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-approval-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: approval-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Approval Agent
`,
      "utf8",
    );

    const harness = new AgentHarness({
      workingDir: dir,
      toolDefinitions: [
        defineTool({
          name: "dangerous-delete",
          description: "Requires approval",
          requiresApproval: true,
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          handler: async () => ({ ok: true }),
        }),
      ],
    });
    await harness.initialize();

    const mockedGenerate = vi
      .fn()
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            id: "tool_approval",
            name: "dangerous-delete",
            input: { path: "/tmp/foo" },
          },
        ],
        usage: { input: 10, output: 5 },
        rawContent: [],
      })
      .mockResolvedValueOnce({
        text: "I could not run that tool without approval.",
        toolCalls: [],
        usage: { input: 5, output: 5 },
        rawContent: [],
      });

    (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
      generate: mockedGenerate,
    };

    const events = [];
    for await (const event of harness.run({ task: "delete the file" })) {
      events.push(event);
    }

    expect(
      events.some((event) => event.type === "tool:approval:required"),
    ).toBe(true);
    expect(events.some((event) => event.type === "tool:approval:denied")).toBe(true);
    expect(events.some((event) => event.type === "tool:error")).toBe(true);
    expect(events.some((event) => event.type === "run:completed")).toBe(true);
  });

  it("grants requiresApproval tools when approval handler allows it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-approval-ok-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: approval-agent-ok
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Approval Agent OK
`,
      "utf8",
    );

    const harness = new AgentHarness({
      workingDir: dir,
      approvalHandler: async () => true,
      toolDefinitions: [
        defineTool({
          name: "dangerous-delete",
          description: "Requires approval",
          requiresApproval: true,
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          handler: async () => ({ ok: true }),
        }),
      ],
    });
    await harness.initialize();

    const mockedGenerate = vi
      .fn()
      .mockResolvedValueOnce({
        text: "",
        toolCalls: [
          {
            id: "tool_approval_ok",
            name: "dangerous-delete",
            input: { path: "/tmp/foo" },
          },
        ],
        usage: { input: 10, output: 5 },
        rawContent: [],
      })
      .mockResolvedValueOnce({
        text: "Done.",
        toolCalls: [],
        usage: { input: 5, output: 5 },
        rawContent: [],
      });

    (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
      generate: mockedGenerate,
    };

    const events = [];
    for await (const event of harness.run({ task: "delete the file" })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "tool:approval:granted")).toBe(true);
    expect(events.some((event) => event.type === "tool:completed")).toBe(true);
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
      auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
      tools: { mode: "allowlist", include: ["remote/*"] }
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
      auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
      tools: { mode: "allowlist", include: ["remote/*"] }
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

  it("sanitizes tool names sent to model providers when MCP tools include slashes", async () => {
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
              serverInfo: { name: "linear", version: "1.0.0" },
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
              tools: [{ name: "list_issues", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }));
    });
    await new Promise<void>((resolveOpen) => mcpServer.listen(0, () => resolveOpen()));
    const address = mcpServer.address();
    if (!address || typeof address === "string") throw new Error("Unexpected address");
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-tool-name-sanitize-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: sanitize-agent
model:
  provider: anthropic
  name: claude-opus-4-5
tools:
  mcp:
    - linear/*
---

# Sanitize
`,
      "utf8",
    );
    await writeFile(
      join(dir, "poncho.config.js"),
      `export default {
  mcp: [
    {
      name: "linear",
      url: "http://127.0.0.1:${address.port}/mcp",
      auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
      tools: { mode: "allowlist", include: ["linear/*"] }
    }
  ]
};
`,
      "utf8",
    );
    const harness = new AgentHarness({ workingDir: dir });
    await harness.initialize();
    const mockedGenerate = vi.fn().mockResolvedValueOnce({
      text: "done",
      toolCalls: [],
      usage: { input: 5, output: 5 },
      rawContent: [],
    });
    (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
      generate: mockedGenerate,
    };
    for await (const _event of harness.run({ task: "hello" })) {
      // consume events
    }
    const firstCall = mockedGenerate.mock.calls[0]?.[0] as
      | { tools?: Array<{ name: string }> }
      | undefined;
    expect(firstCall?.tools?.some((tool) => tool.name.includes("/"))).toBe(false);
    await harness.shutdown();
    await new Promise<void>((resolveClose) => mcpServer.close(() => resolveClose()));
  });

  describe("run loop execution", () => {
    describe("timeout enforcement", () => {
      it("enforces timeout during active run execution", async () => {
        const dir = await createTestAgent({ timeout: 1 }); // 1 second timeout

        const harness = new AgentHarness({ workingDir: dir });
        await harness.initialize();

        // Mock generate with delays - multiple tool calls to ensure we exceed timeout
        // Each call with tool calls continues the loop
        const mockedGenerate = vi.fn().mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return {
            text: "",
            toolCalls: [{ id: `tool_${Date.now()}`, name: "list_directory", input: { path: "." } }],
            usage: { input: 10, output: 5 },
            rawContent: [],
          };
        });

        (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
          generate: mockedGenerate,
        };

        const events: AgentEvent[] = [];
        for await (const event of harness.run({ task: "test timeout" })) {
          events.push(event);
        }

        const errorEvents = collectEvents(events, "run:error");
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0]?.error.code).toBe("TIMEOUT");
        expect(errorEvents[0]?.error.message).toContain("1s");
        expect(collectEvents(events, "run:completed")).toHaveLength(0);
      });

      it("allows completion before timeout expires", async () => {
        const dir = await createTestAgent({ timeout: 5 }); // 5 second timeout

        const harness = new AgentHarness({ workingDir: dir });
        await harness.initialize();

        // Mock fast responses
        const mockedGenerate = vi
          .fn()
          .mockResolvedValueOnce({
            text: "",
            toolCalls: [{ id: "tool_1", name: "list_directory", input: { path: "." } }],
            usage: { input: 10, output: 5 },
            rawContent: [],
          })
          .mockResolvedValueOnce({
            text: "done",
            toolCalls: [],
            usage: { input: 5, output: 5 },
            rawContent: [],
          });

        (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
          generate: mockedGenerate,
        };

        const events: AgentEvent[] = [];
        for await (const event of harness.run({ task: "list directory" })) {
          events.push(event);
        }

        const completedEvents = collectEvents(events, "run:completed");
        expect(completedEvents).toHaveLength(1);
        expect(collectEvents(events, "run:error")).toHaveLength(0);
      });
    });

    describe("max steps limit", () => {
      it("terminates run when max steps exceeded", async () => {
        const dir = await createTestAgent({ maxSteps: 3 });

        const harness = new AgentHarness({ workingDir: dir });
        await harness.initialize();

        // Mock generate that always returns tool calls (infinite loop)
        const mockedGenerate = vi.fn().mockImplementation(async () => ({
          text: "",
          toolCalls: [{ id: `tool_${Date.now()}`, name: "list_directory", input: { path: "." } }],
          usage: { input: 10, output: 5 },
          rawContent: [],
        }));

        (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
          generate: mockedGenerate,
        };

        const events: AgentEvent[] = [];
        for await (const event of harness.run({ task: "infinite loop" })) {
          events.push(event);
        }

        const stepStartedEvents = collectEvents(events, "step:started");
        expect(stepStartedEvents).toHaveLength(3);
        expect(stepStartedEvents.map((e) => e.step)).toEqual([1, 2, 3]);

        const errorEvents = collectEvents(events, "run:error");
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0]?.error.code).toBe("MAX_STEPS_EXCEEDED");
        expect(errorEvents[0]?.error.message).toContain("3 steps");
        expect(collectEvents(events, "run:completed")).toHaveLength(0);
      });

      it("allows completion before max steps reached", async () => {
        const dir = await createTestAgent({ maxSteps: 10 });

        const harness = new AgentHarness({ workingDir: dir });
        await harness.initialize();

        // Mock completes in 2 steps
        const mockedGenerate = vi
          .fn()
          .mockResolvedValueOnce({
            text: "",
            toolCalls: [{ id: "tool_1", name: "list_directory", input: { path: "." } }],
            usage: { input: 10, output: 5 },
            rawContent: [],
          })
          .mockResolvedValueOnce({
            text: "done",
            toolCalls: [],
            usage: { input: 5, output: 5 },
            rawContent: [],
          });

        (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
          generate: mockedGenerate,
        };

        const events: AgentEvent[] = [];
        for await (const event of harness.run({ task: "quick task" })) {
          events.push(event);
        }

        const completedEvents = collectEvents(events, "run:completed");
        expect(completedEvents).toHaveLength(1);
        expect(completedEvents[0]?.result.steps).toBe(2);
        expect(collectEvents(events, "run:error")).toHaveLength(0);
      });
    });

    describe("message window trimming", () => {
      it("trims message history to 40 messages", async () => {
        const dir = await createTestAgent({});

        const harness = new AgentHarness({ workingDir: dir });
        await harness.initialize();

        // Spy on generate to capture messages parameter
        const mockedGenerate = vi.fn().mockResolvedValueOnce({
          text: "done",
          toolCalls: [],
          usage: { input: 5, output: 5 },
          rawContent: [],
        });

        (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
          generate: mockedGenerate,
        };

        // Pass 50 pre-existing messages
        const messages = createMessages(50);

        for await (const _event of harness.run({ task: "test trim", messages })) {
          // consume events
        }

        const firstCall = mockedGenerate.mock.calls[0]?.[0] as
          | { messages?: Message[] }
          | undefined;

        expect(firstCall?.messages).toBeDefined();
        // The task message is added to messages array, then the whole array is trimmed to 40
        // So with 50 messages + 1 task = 51 messages, trimmed to 40 (most recent)
        expect(firstCall?.messages?.length).toBe(40);
      });

      it("preserves all messages when under 40 limit", async () => {
        const dir = await createTestAgent({});

        const harness = new AgentHarness({ workingDir: dir });
        await harness.initialize();

        const mockedGenerate = vi.fn().mockResolvedValueOnce({
          text: "done",
          toolCalls: [],
          usage: { input: 5, output: 5 },
          rawContent: [],
        });

        (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
          generate: mockedGenerate,
        };

        // Pass 10 messages
        const messages = createMessages(10);

        for await (const _event of harness.run({ task: "test preserve", messages })) {
          // consume events
        }

        const firstCall = mockedGenerate.mock.calls[0]?.[0] as
          | { messages?: Message[] }
          | undefined;

        expect(firstCall?.messages).toBeDefined();
        expect(firstCall?.messages?.length).toBe(11); // 10 from history + 1 new task
      });
    });

    describe("tool error handling", () => {
      it("handles tool handler exceptions gracefully", async () => {
        const dir = await createTestAgent({});

        const harness = new AgentHarness({
          workingDir: dir,
          toolDefinitions: [
            defineTool({
              name: "failing-tool",
              description: "Tool that throws error",
              inputSchema: {
                type: "object",
                properties: {},
              },
              handler: async () => {
                throw new Error("Database connection failed");
              },
            }),
          ],
        });
        await harness.initialize();

        const mockedGenerate = vi
          .fn()
          .mockResolvedValueOnce({
            text: "",
            toolCalls: [{ id: "tool_1", name: "failing-tool", input: {} }],
            usage: { input: 10, output: 5 },
            rawContent: [],
          })
          .mockResolvedValueOnce({
            text: "I encountered an error",
            toolCalls: [],
            usage: { input: 5, output: 5 },
            rawContent: [],
          });

        (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
          generate: mockedGenerate,
        };

        const events: AgentEvent[] = [];
        for await (const event of harness.run({ task: "test error" })) {
          events.push(event);
        }

        const errorEvents = collectEvents(events, "tool:error");
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0]?.tool).toBe("failing-tool");
        expect(errorEvents[0]?.error).toContain("Database connection failed");
        expect(errorEvents[0]?.recoverable).toBe(true);

        // Loop should continue and complete
        expect(collectEvents(events, "run:completed")).toHaveLength(1);
      });

      it("handles tool handler promise rejections", async () => {
        const dir = await createTestAgent({});

        const harness = new AgentHarness({
          workingDir: dir,
          toolDefinitions: [
            defineTool({
              name: "rejecting-tool",
              description: "Tool that rejects",
              inputSchema: {
                type: "object",
                properties: {},
              },
              handler: async () => {
                return Promise.reject(new Error("Timeout"));
              },
            }),
          ],
        });
        await harness.initialize();

        const mockedGenerate = vi
          .fn()
          .mockResolvedValueOnce({
            text: "",
            toolCalls: [{ id: "tool_1", name: "rejecting-tool", input: {} }],
            usage: { input: 10, output: 5 },
            rawContent: [],
          })
          .mockResolvedValueOnce({
            text: "I encountered an error",
            toolCalls: [],
            usage: { input: 5, output: 5 },
            rawContent: [],
          });

        (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
          generate: mockedGenerate,
        };

        const events: AgentEvent[] = [];
        for await (const event of harness.run({ task: "test rejection" })) {
          events.push(event);
        }

        const errorEvents = collectEvents(events, "tool:error");
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0]?.tool).toBe("rejecting-tool");
        expect(errorEvents[0]?.error).toContain("Timeout");
        expect(errorEvents[0]?.recoverable).toBe(true);

        // Loop should continue and complete
        expect(collectEvents(events, "run:completed")).toHaveLength(1);
      });
    });

    describe("tool execution", () => {
      describe("batch execution", () => {
        it("executes multiple tool calls in parallel", async () => {
          const dir = await createTestAgent({});
          const executionOrder: string[] = [];

          const harness = new AgentHarness({
            workingDir: dir,
            toolDefinitions: [
              defineTool({
                name: "tool-a",
                description: "Tool A with 150ms delay",
                inputSchema: { type: "object", properties: {} },
                handler: async () => {
                  executionOrder.push("tool-a-start");
                  await new Promise((resolve) => setTimeout(resolve, 150));
                  executionOrder.push("tool-a-end");
                  return { result: "a" };
                },
              }),
              defineTool({
                name: "tool-b",
                description: "Tool B with 100ms delay",
                inputSchema: { type: "object", properties: {} },
                handler: async () => {
                  executionOrder.push("tool-b-start");
                  await new Promise((resolve) => setTimeout(resolve, 100));
                  executionOrder.push("tool-b-end");
                  return { result: "b" };
                },
              }),
              defineTool({
                name: "tool-c",
                description: "Tool C with 200ms delay",
                inputSchema: { type: "object", properties: {} },
                handler: async () => {
                  executionOrder.push("tool-c-start");
                  await new Promise((resolve) => setTimeout(resolve, 200));
                  executionOrder.push("tool-c-end");
                  return { result: "c" };
                },
              }),
            ],
          });
          await harness.initialize();

          const mockedGenerate = vi
            .fn()
            .mockResolvedValueOnce({
              text: "",
              toolCalls: [
                { id: "call_a", name: "tool-a", input: {} },
                { id: "call_b", name: "tool-b", input: {} },
                { id: "call_c", name: "tool-c", input: {} },
              ],
              usage: { input: 10, output: 5 },
              rawContent: [],
            })
            .mockResolvedValueOnce({
              text: "done",
              toolCalls: [],
              usage: { input: 5, output: 5 },
              rawContent: [],
            });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          const startTime = Date.now();
          const events: AgentEvent[] = [];
          for await (const event of harness.run({ task: "test parallel" })) {
            events.push(event);
          }
          const duration = Date.now() - startTime;

          // All tools should start before any complete
          expect(executionOrder.slice(0, 3)).toEqual(["tool-a-start", "tool-b-start", "tool-c-start"]);

          // Total duration should be less than sum of individual delays (450ms)
          // Should be close to max delay (200ms) + overhead
          expect(duration).toBeLessThan(400);

          const completedEvents = collectEvents(events, "tool:completed");
          expect(completedEvents).toHaveLength(3);
          expect(completedEvents.map((e) => e.tool)).toEqual(
            expect.arrayContaining(["tool-a", "tool-b", "tool-c"]),
          );
        });

        it("handles mixed success and failure in batch", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({
            workingDir: dir,
            toolDefinitions: [
              defineTool({
                name: "success-tool-1",
                description: "Succeeds",
                inputSchema: { type: "object", properties: {} },
                handler: async () => ({ result: "ok1" }),
              }),
              defineTool({
                name: "failing-tool",
                description: "Fails",
                inputSchema: { type: "object", properties: {} },
                handler: async () => {
                  throw new Error("Tool failed");
                },
              }),
              defineTool({
                name: "success-tool-2",
                description: "Succeeds",
                inputSchema: { type: "object", properties: {} },
                handler: async () => ({ result: "ok2" }),
              }),
            ],
          });
          await harness.initialize();

          const mockedGenerate = vi
            .fn()
            .mockResolvedValueOnce({
              text: "",
              toolCalls: [
                { id: "call_1", name: "success-tool-1", input: {} },
                { id: "call_2", name: "failing-tool", input: {} },
                { id: "call_3", name: "success-tool-2", input: {} },
              ],
              usage: { input: 10, output: 5 },
              rawContent: [],
            })
            .mockResolvedValueOnce({
              text: "handled errors",
              toolCalls: [],
              usage: { input: 5, output: 5 },
              rawContent: [],
            });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          const events: AgentEvent[] = [];
          for await (const event of harness.run({ task: "test batch errors" })) {
            events.push(event);
          }

          const completedEvents = collectEvents(events, "tool:completed");
          const errorEvents = collectEvents(events, "tool:error");

          expect(completedEvents).toHaveLength(2);
          expect(completedEvents.map((e) => e.tool)).toEqual(
            expect.arrayContaining(["success-tool-1", "success-tool-2"]),
          );

          expect(errorEvents).toHaveLength(1);
          expect(errorEvents[0]?.tool).toBe("failing-tool");
          expect(errorEvents[0]?.error).toContain("Tool failed");

          // Run should still complete
          expect(collectEvents(events, "run:completed")).toHaveLength(1);
        });
      });

      describe("tool name sanitization", () => {
        it("sanitizes tools with special characters", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({
            workingDir: dir,
            toolDefinitions: [
              defineTool({
                name: "@special!tool",
                description: "Tool with special chars",
                inputSchema: { type: "object", properties: {} },
                handler: async () => ({ ok: true }),
              }),
              defineTool({
                name: "tool#with$chars",
                description: "Another tool with special chars",
                inputSchema: { type: "object", properties: {} },
                handler: async () => ({ ok: true }),
              }),
            ],
          });
          await harness.initialize();

          const mockedGenerate = vi.fn().mockResolvedValueOnce({
            text: "done",
            toolCalls: [],
            usage: { input: 5, output: 5 },
            rawContent: [],
          });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          for await (const _event of harness.run({ task: "test sanitize" })) {
            // consume events
          }

          const firstCall = mockedGenerate.mock.calls[0]?.[0] as
            | { tools?: Array<{ name: string }> }
            | undefined;

          expect(firstCall?.tools).toBeDefined();
          const toolNames = firstCall?.tools?.map((t) => t.name) ?? [];

          // All tool names should match the pattern /^[a-zA-Z0-9_-]{1,128}$/
          for (const name of toolNames) {
            expect(name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
          }

          // Should not contain original names with special chars
          expect(toolNames).not.toContain("@special!tool");
          expect(toolNames).not.toContain("tool#with$chars");
        });
      });

      describe("tool context", () => {
        it("passes correct context to tool handlers", async () => {
          const dir = await createTestAgent({});
          let capturedContext: any = null;

          const harness = new AgentHarness({
            workingDir: dir,
            toolDefinitions: [
              defineTool({
                name: "context-tool",
                description: "Captures context",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                },
                handler: async (input, context) => {
                  capturedContext = context;
                  return { received: input };
                },
              }),
            ],
          });
          await harness.initialize();

          const mockedGenerate = vi
            .fn()
            .mockResolvedValueOnce({
              text: "",
              toolCalls: [
                { id: "call_1", name: "context-tool", input: { value: "test" } },
              ],
              usage: { input: 10, output: 5 },
              rawContent: [],
            })
            .mockResolvedValueOnce({
              text: "done",
              toolCalls: [],
              usage: { input: 5, output: 5 },
              rawContent: [],
            });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          const events: AgentEvent[] = [];
          for await (const event of harness.run({
            task: "test context",
            parameters: { projectName: "test-project" },
          })) {
            events.push(event);
          }

          expect(capturedContext).toBeDefined();
          expect(capturedContext.runId).toBeDefined();
          expect(typeof capturedContext.runId).toBe("string");
          expect(capturedContext.step).toBe(1);
          expect(capturedContext.agentId).toBe("test-agent");
          expect(capturedContext.workingDir).toBe(dir);
          expect(capturedContext.parameters).toEqual({ projectName: "test-project" });
        });

        it("includes tool input in tool:started event", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({
            workingDir: dir,
            toolDefinitions: [
              defineTool({
                name: "echo-tool",
                description: "Echoes input",
                inputSchema: {
                  type: "object",
                  properties: { message: { type: "string" } },
                },
                handler: async (input) => ({ echoed: input.message }),
              }),
            ],
          });
          await harness.initialize();

          const mockedGenerate = vi
            .fn()
            .mockResolvedValueOnce({
              text: "",
              toolCalls: [
                { id: "call_1", name: "echo-tool", input: { message: "hello world" } },
              ],
              usage: { input: 10, output: 5 },
              rawContent: [],
            })
            .mockResolvedValueOnce({
              text: "done",
              toolCalls: [],
              usage: { input: 5, output: 5 },
              rawContent: [],
            });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          const events: AgentEvent[] = [];
          for await (const event of harness.run({ task: "test input" })) {
            events.push(event);
          }

          const startedEvents = collectEvents(events, "tool:started");
          expect(startedEvents).toHaveLength(1);
          expect(startedEvents[0]?.tool).toBe("echo-tool");
          expect(startedEvents[0]?.input).toEqual({ message: "hello world" });
        });
      });
    });

    describe("model interaction", () => {
      describe("streaming", () => {
        it("emits model:chunk events during streaming", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          // Mock streaming model client
          async function* mockGenerateStream() {
            yield {
              type: "chunk" as const,
              content: "Hello ",
            };
            yield {
              type: "chunk" as const,
              content: "world",
            };
            yield {
              type: "chunk" as const,
              content: "!",
            };
            yield {
              type: "final" as const,
              response: {
                text: "Hello world!",
                toolCalls: [],
                usage: { input: 10, output: 15 },
                rawContent: [],
              },
            };
          }

          (harness as unknown as { modelClient: { generateStream: unknown } }).modelClient = {
            generateStream: vi.fn(mockGenerateStream),
          };

          const events: AgentEvent[] = [];
          for await (const event of harness.run({ task: "test streaming" })) {
            events.push(event);
          }

          const chunkEvents = collectEvents(events, "model:chunk");
          expect(chunkEvents).toHaveLength(3);
          expect(chunkEvents[0]?.content).toBe("Hello ");
          expect(chunkEvents[1]?.content).toBe("world");
          expect(chunkEvents[2]?.content).toBe("!");

          const responseEvents = collectEvents(events, "model:response");
          expect(responseEvents).toHaveLength(1);
          expect(responseEvents[0]?.usage).toEqual({ input: 10, output: 15, cached: 0 });
        });

        it("emits single chunk for non-streaming models", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          // Mock non-streaming model (no generateStream method)
          const mockedGenerate = vi.fn().mockResolvedValueOnce({
            text: "Full response text",
            toolCalls: [],
            usage: { input: 10, output: 20 },
            rawContent: [],
          });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          const events: AgentEvent[] = [];
          for await (const event of harness.run({ task: "test non-streaming" })) {
            events.push(event);
          }

          const chunkEvents = collectEvents(events, "model:chunk");
          expect(chunkEvents).toHaveLength(1);
          expect(chunkEvents[0]?.content).toBe("Full response text");
        });

        it("handles empty streaming chunks gracefully", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          // Mock streaming with empty chunks
          async function* mockGenerateStream() {
            yield { type: "chunk" as const, content: "" };
            yield { type: "chunk" as const, content: "Hello" };
            yield { type: "chunk" as const, content: "" };
            yield { type: "chunk" as const, content: " world" };
            yield { type: "chunk" as const, content: "" };
            yield {
              type: "final" as const,
              response: {
                text: "Hello world",
                toolCalls: [],
                usage: { input: 10, output: 10 },
                rawContent: [],
              },
            };
          }

          (harness as unknown as { modelClient: { generateStream: unknown } }).modelClient = {
            generateStream: vi.fn(mockGenerateStream),
          };

          const events: AgentEvent[] = [];
          for await (const event of harness.run({ task: "test empty chunks" })) {
            events.push(event);
          }

          const chunkEvents = collectEvents(events, "model:chunk");
          // Only non-empty chunks should be emitted
          expect(chunkEvents).toHaveLength(2);
          expect(chunkEvents[0]?.content).toBe("Hello");
          expect(chunkEvents[1]?.content).toBe(" world");
        });
      });

      describe("system prompt", () => {
        it("interpolates parameters in agent body", async () => {
          const dir = await createTestAgent({
            body: `# Agent with Parameters

You are working on project: {{parameters.projectName}}
Environment: {{parameters.environment}}`,
          });

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          const mockedGenerate = vi.fn().mockResolvedValueOnce({
            text: "done",
            toolCalls: [],
            usage: { input: 5, output: 5 },
            rawContent: [],
          });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          for await (const _event of harness.run({
            task: "test interpolation",
            parameters: {
              projectName: "poncho-ai",
              environment: "production",
            },
          })) {
            // consume events
          }

          const firstCall = mockedGenerate.mock.calls[0]?.[0] as
            | { systemPrompt?: string }
            | undefined;

          expect(firstCall?.systemPrompt).toBeDefined();
          expect(firstCall?.systemPrompt).toContain("poncho-ai");
          expect(firstCall?.systemPrompt).toContain("production");
        });

        it("interpolates runtime context", async () => {
          const dir = await createTestAgent({
            body: `# Agent with Runtime Context

Environment: {{runtime.environment}}
Run ID: {{runtime.runId}}`,
          });

          const harness = new AgentHarness({ workingDir: dir, environment: "development" });
          await harness.initialize();

          const mockedGenerate = vi.fn().mockResolvedValueOnce({
            text: "done",
            toolCalls: [],
            usage: { input: 5, output: 5 },
            rawContent: [],
          });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          for await (const _event of harness.run({ task: "test runtime" })) {
            // consume events
          }

          const firstCall = mockedGenerate.mock.calls[0]?.[0] as
            | { systemPrompt?: string }
            | undefined;

          expect(firstCall?.systemPrompt).toBeDefined();
          expect(firstCall?.systemPrompt).toContain("development");
          // runId is a UUID with run_ prefix
          expect(firstCall?.systemPrompt).toMatch(/Run ID: run_[a-f0-9-]{36}/);
        });

        it("truncates long memory content to 4000 characters", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          // Mock memory store with long content
          const longContent = "A".repeat(5000);
          (harness as any).memoryStore = {
            getMainMemory: vi.fn().mockResolvedValue({
              content: longContent,
            }),
          };

          const mockedGenerate = vi.fn().mockResolvedValueOnce({
            text: "done",
            toolCalls: [],
            usage: { input: 5, output: 5 },
            rawContent: [],
          });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          for await (const _event of harness.run({ task: "test memory truncation" })) {
            // consume events
          }

          const firstCall = mockedGenerate.mock.calls[0]?.[0] as
            | { systemPrompt?: string }
            | undefined;

          expect(firstCall?.systemPrompt).toBeDefined();
          // Check that memory content is truncated
          // Should contain truncation marker
          expect(firstCall?.systemPrompt).toContain("...[truncated]");
          // Memory content should be truncated to around 4000 chars (allowing some overhead for other As in the prompt)
          const aCount = (firstCall?.systemPrompt?.match(/A/g) || []).length;
          // Should be much less than 5000 (original), but allow some buffer
          expect(aCount).toBeGreaterThan(3900); // At least most of the truncated content
          expect(aCount).toBeLessThan(4500); // But significantly less than original 5000
        });
      });
    });

    describe("events and lifecycle", () => {
      describe("event ordering", () => {
        it("emits events in correct order for simple run", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          const mockedGenerate = vi.fn().mockResolvedValueOnce({
            text: "completed",
            toolCalls: [],
            usage: { input: 10, output: 5 },
            rawContent: [],
          });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          const events: AgentEvent[] = [];
          for await (const event of harness.run({ task: "simple task" })) {
            events.push(event);
          }

          // Extract event types in order
          const eventTypes = events.map((e) => e.type);

          // Verify correct sequence
          expect(eventTypes[0]).toBe("run:started");
          expect(eventTypes[1]).toBe("step:started");
          expect(eventTypes[2]).toBe("model:request");
          expect(eventTypes[3]).toBe("model:chunk");
          expect(eventTypes[4]).toBe("model:response");
          expect(eventTypes[5]).toBe("step:completed");
          expect(eventTypes[6]).toBe("run:completed");
        });

        it("includes correct metadata in all events", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          const mockedGenerate = vi
            .fn()
            .mockResolvedValueOnce({
              text: "",
              toolCalls: [{ id: "tool_1", name: "list_directory", input: { path: "." } }],
              usage: { input: 10, output: 5 },
              rawContent: [],
            })
            .mockResolvedValueOnce({
              text: "done",
              toolCalls: [],
              usage: { input: 8, output: 3 },
              rawContent: [],
            });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          const events: AgentEvent[] = [];
          for await (const event of harness.run({ task: "test metadata" })) {
            events.push(event);
          }

          // Check runId consistency
          const runStarted = collectEvents(events, "run:started")[0];
          expect(runStarted?.runId).toBeDefined();
          expect(typeof runStarted?.runId).toBe("string");

          const runCompleted = collectEvents(events, "run:completed")[0];
          expect(runCompleted?.runId).toBe(runStarted?.runId);

          // Check step increments
          const stepStarted = collectEvents(events, "step:started");
          expect(stepStarted).toHaveLength(2);
          expect(stepStarted[0]?.step).toBe(1);
          expect(stepStarted[1]?.step).toBe(2);

          // Check step completed has duration
          const stepCompleted = collectEvents(events, "step:completed");
          expect(stepCompleted).toHaveLength(2);
          expect(stepCompleted[0]?.duration).toBeGreaterThanOrEqual(0);
          expect(stepCompleted[1]?.duration).toBeGreaterThanOrEqual(0);
          expect(typeof stepCompleted[0]?.duration).toBe("number");
          expect(typeof stepCompleted[1]?.duration).toBe("number");

          // Check tokens accumulate
          const modelResponses = collectEvents(events, "model:response");
          expect(modelResponses).toHaveLength(2);
          const totalInput = modelResponses.reduce((sum, e) => sum + e.usage.input, 0);
          const totalOutput = modelResponses.reduce((sum, e) => sum + e.usage.output, 0);
          expect(totalInput).toBe(18);
          expect(totalOutput).toBe(8);
        });
      });

      describe("message management", () => {
        it("adds messages with correct metadata", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          const mockedGenerate = vi.fn().mockResolvedValueOnce({
            text: "response",
            toolCalls: [],
            usage: { input: 10, output: 5 },
            rawContent: [],
          });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          for await (const _event of harness.run({ task: "test messages" })) {
            // consume events
          }

          // Check the messages sent to the model
          const firstCall = mockedGenerate.mock.calls[0]?.[0] as
            | { messages?: Message[] }
            | undefined;

          expect(firstCall?.messages).toBeDefined();
          const messages = firstCall?.messages ?? [];
          expect(messages.length).toBeGreaterThan(0);

          // Check last message (task message) has metadata
          const lastMessage = messages[messages.length - 1];
          expect(lastMessage?.role).toBe("user");
          expect(lastMessage?.content).toBe("test messages");
          expect(lastMessage?.metadata).toBeDefined();
          expect(lastMessage?.metadata?.id).toBeDefined();
          expect(typeof lastMessage?.metadata?.id).toBe("string");
          expect(lastMessage?.metadata?.timestamp).toBeDefined();
          expect(typeof lastMessage?.metadata?.timestamp).toBe("number");
        });

        it("preserves message order during multi-step runs", async () => {
          const dir = await createTestAgent({});

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          let secondCallMessages: Message[] = [];

          const mockedGenerate = vi
            .fn()
            .mockResolvedValueOnce({
              text: "step 1 response",
              toolCalls: [{ id: "tool_1", name: "list_directory", input: { path: "." } }],
              usage: { input: 10, output: 5 },
              rawContent: [],
            })
            .mockImplementationOnce(async (input: { messages?: Message[] }) => {
              secondCallMessages = input.messages ?? [];
              return {
                text: "step 2 response",
                toolCalls: [{ id: "tool_2", name: "read_file", input: { path: "test.txt" } }],
                usage: { input: 20, output: 10 },
                rawContent: [],
              };
            })
            .mockResolvedValueOnce({
              text: "final response",
              toolCalls: [],
              usage: { input: 15, output: 8 },
              rawContent: [],
            });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          for await (const _event of harness.run({ task: "multi-step task" })) {
            // consume events
          }

          // Check message structure in second call
          expect(secondCallMessages.length).toBeGreaterThan(2);

          // Find the assistant and tool messages from step 1
          const roles = secondCallMessages.map((m) => m.role);
          const lastThreeRoles = roles.slice(-3);

          // Should have: ...previous, assistant (step 1), tool (step 1 results), user (original task)
          // Actually, the user message is added at the start, so the pattern should be:
          // user, assistant (with tool calls), tool (results), assistant (with tool calls), tool (results)
          expect(roles).toContain("user");
          expect(roles).toContain("assistant");
          expect(roles).toContain("tool");

          // Check step attribution in metadata
          const messagesWithSteps = secondCallMessages.filter(
            (m) => m.metadata?.step !== undefined,
          );
          expect(messagesWithSteps.length).toBeGreaterThan(0);
          // First step's messages should have step: 1
          const step1Messages = messagesWithSteps.filter((m) => m.metadata?.step === 1);
          expect(step1Messages.length).toBeGreaterThan(0);
        });
      });
    });

    describe("configuration", () => {
      describe("validation", () => {
        it("throws error for missing AGENT.md name field", async () => {
          const dir = await mkdtemp(join(tmpdir(), "poncho-test-no-name-"));
          // Create AGENT.md without name field
          await writeFile(
            join(dir, "AGENT.md"),
            `---
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Agent without name`,
            "utf8",
          );

          const harness = new AgentHarness({ workingDir: dir });
          await expect(harness.initialize()).rejects.toThrow(/name/i);
        });

        it("throws error for malformed frontmatter", async () => {
          const dir = await mkdtemp(join(tmpdir(), "poncho-test-bad-frontmatter-"));
          // Create AGENT.md without proper frontmatter markers
          await writeFile(
            join(dir, "AGENT.md"),
            `name: test-agent
model:
  provider: anthropic

# Agent without frontmatter markers`,
            "utf8",
          );

          const harness = new AgentHarness({ workingDir: dir });
          await expect(harness.initialize()).rejects.toThrow();
        });

        it("uses defaults for missing model config", async () => {
          const dir = await mkdtemp(join(tmpdir(), "poncho-test-default-model-"));
          // Create AGENT.md without model section
          await writeFile(
            join(dir, "AGENT.md"),
            `---
name: default-model-agent
---

# Agent with default model`,
            "utf8",
          );

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          const mockedGenerate = vi.fn().mockResolvedValueOnce({
            text: "done",
            toolCalls: [],
            usage: { input: 5, output: 5 },
            rawContent: [],
          });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          for await (const _event of harness.run({ task: "test defaults" })) {
            // consume events
          }

          const firstCall = mockedGenerate.mock.calls[0]?.[0] as
            | { modelName?: string }
            | undefined;

          // Should default to claude-opus-4-5
          expect(firstCall?.modelName).toBe("claude-opus-4-5");
        });

        it("uses defaults for missing limits config", async () => {
          const dir = await mkdtemp(join(tmpdir(), "poncho-test-default-limits-"));
          // Create AGENT.md without limits section
          await writeFile(
            join(dir, "AGENT.md"),
            `---
name: default-limits-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Agent with default limits`,
            "utf8",
          );

          const harness = new AgentHarness({ workingDir: dir });
          await harness.initialize();

          // Mock generate that always returns tool calls to test maxSteps default
          let callCount = 0;
          const mockedGenerate = vi.fn().mockImplementation(async () => {
            callCount += 1;
            // Return tool calls for many steps to test default maxSteps (50)
            if (callCount < 52) {
              return {
                text: "",
                toolCalls: [{ id: `tool_${callCount}`, name: "list_directory", input: { path: "." } }],
                usage: { input: 10, output: 5 },
                rawContent: [],
              };
            }
            return {
              text: "done",
              toolCalls: [],
              usage: { input: 5, output: 5 },
              rawContent: [],
            };
          });

          (harness as unknown as { modelClient: { generate: unknown } }).modelClient = {
            generate: mockedGenerate,
          };

          const events: AgentEvent[] = [];
          for await (const event of harness.run({ task: "test default limits" })) {
            events.push(event);
          }

          const stepStartedEvents = collectEvents(events, "step:started");
          const errorEvents = collectEvents(events, "run:error");

          // Should hit default maxSteps of 50
          expect(stepStartedEvents).toHaveLength(50);
          expect(errorEvents).toHaveLength(1);
          expect(errorEvents[0]?.error.code).toBe("MAX_STEPS_EXCEEDED");
          expect(errorEvents[0]?.error.message).toContain("50");
        });
      });
    });
  });
});
