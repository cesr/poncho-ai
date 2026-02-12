import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defineTool } from "@agentl/sdk";
import { AgentHarness } from "../src/harness.js";

describe("agent harness", () => {
  it("registers default filesystem tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentl-harness-default-tools-"));
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
    const dir = await mkdtemp(join(tmpdir(), "agentl-harness-prod-tools-"));
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

  it("loads local skill tools from skills directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentl-harness-local-tools-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: local-tools-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Local Tools Agent
`,
      "utf8",
    );
    await mkdir(join(dir, "skills", "summarize", "tools"), { recursive: true });
    await writeFile(
      join(dir, "skills", "summarize", "tools", "summarize.ts"),
      `import { defineTool } from "@agentl/sdk";

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

    expect(names).toContain("summarize_text");
  });

  it("injects SKILL.md context into system prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentl-harness-skill-context-"));
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
  - summarize_text
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
      | { systemPrompt?: string }
      | undefined;
    expect(firstCall?.systemPrompt).toContain("## Agent Skills Context");
    expect(firstCall?.systemPrompt).toContain("Skill: summarize");
    expect(firstCall?.systemPrompt).toContain("summarize_text");
  });

  it("runs a tool call loop and completes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentl-harness-"));
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
    const dir = await mkdtemp(join(tmpdir(), "agentl-harness-approval-"));
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
    const dir = await mkdtemp(join(tmpdir(), "agentl-harness-approval-ok-"));
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
});
