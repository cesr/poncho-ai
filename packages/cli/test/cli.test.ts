import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Message } from "@agentl/sdk";

vi.mock("@agentl/harness", () => ({
  AgentHarness: class MockHarness {
    async initialize(): Promise<void> {}
    listTools(): Array<{ name: string; description: string }> {
      return [{ name: "echo", description: "Echo tool" }];
    }

    async *run(): AsyncGenerator<{
      type:
        | "run:started"
        | "step:started"
        | "model:chunk"
        | "step:completed"
        | "run:completed";
      [key: string]: unknown;
    }> {
      yield { type: "run:started", runId: "run_test", agentId: "test-agent" };
      yield { type: "step:started", step: 1 };
      yield { type: "model:chunk", content: "hello" };
      yield { type: "step:completed", step: 1, duration: 1 };
      yield {
        type: "run:completed",
        runId: "run_test",
        result: {
          status: "completed",
          response: "hello",
          steps: 1,
          tokens: { input: 1, output: 1, cached: 0 },
          duration: 1,
        },
      };
    }

    async runToCompletion(input: { task: string; messages?: Message[] }): Promise<{
      runId: string;
      result: {
        status: "completed";
        response: string;
        steps: number;
        tokens: { input: number; output: number; cached: number };
        duration: number;
      };
      events: AgentEvent[];
      messages: Message[];
    }> {
      return {
        runId: "run_test",
        result: {
          status: "completed",
          response: input.task,
          steps: 1,
          tokens: { input: 1, output: 1, cached: 0 },
          duration: 1,
        },
        events: [
          { type: "run:started", runId: "run_test", agentId: "test-agent" },
          {
            type: "run:completed",
            runId: "run_test",
            result: {
              status: "completed",
              response: input.task,
              steps: 1,
              tokens: { input: 1, output: 1, cached: 0 },
              duration: 1,
            },
          },
        ],
        messages: [
          ...(input.messages ?? []),
          { role: "user", content: input.task },
          { role: "assistant", content: input.task },
        ],
      };
    }
  },
  loadAgentlConfig: async () => ({
    auth: { required: false },
    state: { provider: "memory", ttl: 3600 },
    telemetry: { enabled: false },
  }),
  createStateStore: () => {
    const map = new Map<string, { runId: string; messages: Message[]; updatedAt: number }>();
    return {
      get: async (runId: string) => map.get(runId),
      set: async (state: { runId: string; messages: Message[]; updatedAt: number }) => {
        map.set(state.runId, state);
      },
      delete: async (runId: string) => {
        map.delete(runId);
      },
    };
  },
  InMemoryStateStore: class {},
  TelemetryEmitter: class {
    async emit(): Promise<void> {}
  },
}));

import {
  buildTarget,
  initProject,
  listTools,
  mcpAdd,
  mcpList,
  mcpRemove,
  runTests,
  startDevServer,
  updateAgentGuidance,
} from "../src/index.js";

describe("cli", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agentl-cli-"));
  });

  it("scaffolds a project with init", async () => {
    await initProject("my-agent", { workingDir: tempDir });
    const agentMarkdown = await readFile(join(tempDir, "my-agent", "AGENT.md"), "utf8");
    const pkgJson = await readFile(join(tempDir, "my-agent", "package.json"), "utf8");
    const skillManifest = await readFile(
      join(tempDir, "my-agent", "skills", "starter", "SKILL.md"),
      "utf8",
    );
    const skillTool = await readFile(
      join(tempDir, "my-agent", "skills", "starter", "tools", "starter-echo.ts"),
      "utf8",
    );
    const basicTest = await readFile(join(tempDir, "my-agent", "tests", "basic.yaml"), "utf8");

    expect(agentMarkdown).toContain("name: my-agent");
    expect(pkgJson).toContain('"name": "my-agent"');
    expect(skillManifest).toContain("name: starter-skill");
    expect(skillTool).toContain('name: "starter-echo"');
    expect(basicTest).toContain('name: "Basic sanity"');
  });

  it("supports smoke flow init -> dev -> run endpoint", async () => {
    await initProject("smoke-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "smoke-agent");

    const port = 43000 + Math.floor(Math.random() * 1000);
    const server = await startDevServer(port, { workingDir: projectDir });

    const health = await fetch(`http://localhost:${port}/health`);
    expect(health.status).toBe(200);

    const runSync = await fetch(`http://localhost:${port}/run/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "hello" }),
    });
    expect(runSync.status).toBe(200);
    const payload = (await runSync.json()) as {
      status: string;
      result: { response: string };
    };
    expect(payload.status).toBe("completed");
    expect(payload.result.response).toBe("hello");

    const continueResponse = await fetch(`http://localhost:${port}/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run_test", message: "next" }),
    });
    expect(continueResponse.status).toBe(200);
    const continuePayload = (await continueResponse.json()) as {
      status: string;
      result: { response: string };
    };
    expect(continuePayload.status).toBe("completed");
    expect(continuePayload.result.response).toBe("next");

    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    });
  });

  it("supports auxiliary commands and config updates", async () => {
    await initProject("aux-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "aux-agent");

    await listTools(projectDir);
    await mcpAdd(projectDir, { url: "wss://example.com/mcp", name: "remote-mcp" });
    await mcpList(projectDir);
    await mcpRemove(projectDir, "remote-mcp");

    await buildTarget(projectDir, "vercel");
    await buildTarget(projectDir, "docker");
    await buildTarget(projectDir, "lambda");
    await buildTarget(projectDir, "fly");
    const vercelConfig = await readFile(
      join(projectDir, ".agentl-build", "vercel", "vercel.json"),
      "utf8",
    );
    const dockerFile = await readFile(
      join(projectDir, ".agentl-build", "docker", "Dockerfile"),
      "utf8",
    );
    const lambdaHandler = await readFile(
      join(projectDir, ".agentl-build", "lambda", "lambda-handler.js"),
      "utf8",
    );
    const flyToml = await readFile(
      join(projectDir, ".agentl-build", "fly", "fly.toml"),
      "utf8",
    );
    expect(vercelConfig).toContain('"routes"');
    expect(dockerFile).toContain("CMD [\"node\",\"server.js\"]");
    expect(lambdaHandler).toContain("export const handler");
    expect(flyToml).toContain("internal_port = 3000");

    const testsDir = join(projectDir, "tests");
    await mkdir(testsDir, { recursive: true });
    await writeFile(
      join(testsDir, "basic.yaml"),
      `tests:\n  - name: basic\n    task: hello\n    expect:\n      contains: hello\n`,
      "utf8",
    );
    const result = await runTests(projectDir, join(testsDir, "basic.yaml"));
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("can backfill skill guidance into an existing AGENT.md", async () => {
    const projectDir = join(tempDir, "legacy-agent");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "AGENT.md"),
      `---
name: legacy-agent
---

# Legacy Agent

Old instructions only.
`,
      "utf8",
    );

    const changed = await updateAgentGuidance(projectDir);
    const updated = await readFile(join(projectDir, "AGENT.md"), "utf8");

    expect(changed).toBe(true);
    expect(updated).toContain("## Skill Authoring Guidance");
    expect(updated).toContain("skills/<skill-name>/SKILL.md");
  });

  it("replaces existing skill guidance with latest version", async () => {
    const projectDir = join(tempDir, "legacy-agent-guidance");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "AGENT.md"),
      `---
name: legacy-agent
---

# Legacy Agent

## Skill Authoring Guidance

Old guidance that should be replaced.

## Other Section

Keep this section.
`,
      "utf8",
    );

    const changed = await updateAgentGuidance(projectDir);
    const updated = await readFile(join(projectDir, "AGENT.md"), "utf8");

    expect(changed).toBe(true);
    expect(updated).toContain("Instruction skill (no tool code)");
    expect(updated).not.toContain("Old guidance that should be replaced.");
    expect(updated).toContain("## Other Section");
  });
});
