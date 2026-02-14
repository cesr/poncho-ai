import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defineTool } from "@poncho-ai/sdk";
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
allowed-tools: summarize_text
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
allowed-tools: summarize_text read_file
---

# Summarize
`,
      "utf8",
    );

    const metadata = await loadSkillMetadata(dir);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.name).toBe("summarize");
    expect(metadata[0]?.tools).toEqual(["summarize_text", "read_file"]);
  });

  it("keeps backward compatibility with legacy tools list frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-harness-legacy-tools-"));
    await mkdir(join(dir, "skills", "legacy"), { recursive: true });
    await writeFile(
      join(dir, "skills", "legacy", "SKILL.md"),
      `---
name: legacy
description: Legacy skill
tools:
  - legacy_tool
---

# Legacy
`,
      "utf8",
    );

    const metadata = await loadSkillMetadata(dir);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.name).toBe("legacy");
    expect(metadata[0]?.tools).toEqual(["legacy_tool"]);
  });
});
