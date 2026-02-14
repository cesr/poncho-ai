import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Message } from "@agentl/sdk";
import { FileConversationStore, getRequestIp, parseCookies } from "../src/web-ui.js";
import { buildConfigFromOnboardingAnswers, runInitOnboarding } from "../src/init-onboarding.js";
import {
  consumeFirstRunIntro,
  initializeOnboardingMarker,
} from "../src/init-feature-context.js";

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
  resolveStateConfig: (config: { state?: unknown }) => config.state,
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
  createConversationStore: () => {
    const store = new FileConversationStore(process.cwd());
    return {
      list: (ownerId?: string) => store.list(ownerId),
      get: (conversationId: string) => store.get(conversationId),
      create: (ownerId?: string, title?: string) => store.create(ownerId, title),
      update: (conversation: Awaited<ReturnType<FileConversationStore["create"]>>) =>
        store.update(conversation),
      rename: (conversationId: string, title: string) => store.rename(conversationId, title),
      delete: (conversationId: string) => store.delete(conversationId),
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
      join(tempDir, "my-agent", "skills", "starter", "scripts", "starter-echo.ts"),
      "utf8",
    );
    const basicTest = await readFile(join(tempDir, "my-agent", "tests", "basic.yaml"), "utf8");

    expect(agentMarkdown).toContain("name: my-agent");
    expect(pkgJson).toContain('"name": "my-agent"');
    expect(skillManifest).toContain("name: starter-skill");
    expect(skillTool).toContain("export default async function run(input)");
    expect(basicTest).toContain('name: "Basic sanity"');
  });

  it("builds onboarding config with light defaults", async () => {
    const result = await runInitOnboarding({
      yes: true,
      interactive: false,
    });
    expect(result.config.storage?.provider).toBe("local");
    expect(result.config.telemetry?.enabled).toBe(true);
    expect(result.agentModel.provider).toBe("anthropic");
  });

  it("supports onboarding scaffold defaults via init options", async () => {
    await initProject("default-agent", {
      workingDir: tempDir,
      onboarding: { yes: true, interactive: false },
    });
    const configFile = await readFile(
      join(tempDir, "default-agent", "agentl.config.js"),
      "utf8",
    );
    expect(configFile).toContain('"storage"');
    expect(configFile).toContain('"memory"');
    expect(configFile).toContain('"auth"');
  });

  it("creates onboarding marker and emits intro only once", async () => {
    const projectDir = join(tempDir, "intro-agent");
    await mkdir(projectDir, { recursive: true });
    await initializeOnboardingMarker(projectDir);
    const firstIntro = await consumeFirstRunIntro(projectDir, {
      agentName: "IntroAgent",
      provider: "anthropic",
      model: "claude-opus-4-5",
      config: buildConfigFromOnboardingAnswers({
        "model.provider": "anthropic",
        "storage.provider": "local",
        "storage.memory.enabled": true,
        "auth.required": false,
        "telemetry.enabled": true,
      }),
    });
    const secondIntro = await consumeFirstRunIntro(projectDir, {
      agentName: "IntroAgent",
      provider: "anthropic",
      model: "claude-opus-4-5",
      config: undefined,
    });
    expect(firstIntro).toContain("I can help configure this agent directly by chat");
    expect(secondIntro).toBeUndefined();
  });

  it("emits intro for interactive init even when config differs from defaults", async () => {
    await initProject("interactive-custom-agent", {
      workingDir: tempDir,
      onboarding: { yes: false, interactive: false },
    });
    const projectDir = join(tempDir, "interactive-custom-agent");
    const intro = await consumeFirstRunIntro(projectDir, {
      agentName: "InteractiveCustomAgent",
      provider: "openai",
      model: "gpt-4.1",
      config: buildConfigFromOnboardingAnswers({
        "model.provider": "openai",
        "storage.provider": "memory",
        "storage.memory.enabled": false,
        "auth.required": true,
        "telemetry.enabled": false,
      }),
    });
    expect(intro).toContain("I can help configure this agent directly by chat");
  });

  it("does not emit intro for init defaults created with --yes behavior", async () => {
    await initProject("no-intro-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "no-intro-agent");
    const intro = await consumeFirstRunIntro(projectDir, {
      agentName: "NoIntroAgent",
      provider: "anthropic",
      model: "claude-opus-4-5",
      config: buildConfigFromOnboardingAnswers({
        "model.provider": "anthropic",
        "storage.provider": "local",
        "storage.memory.enabled": true,
        "auth.required": false,
        "telemetry.enabled": true,
      }),
    });
    expect(intro).toBeUndefined();
  });

  it("supports smoke flow init -> dev -> api conversation endpoint", async () => {
    await initProject("smoke-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "smoke-agent");

    const port = 43000 + Math.floor(Math.random() * 1000);
    const server = await startDevServer(port, { workingDir: projectDir });

    const health = await fetch(`http://localhost:${port}/health`);
    expect(health.status).toBe(200);

    const createdConversation = await fetch(`http://localhost:${port}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "smoke" }),
    });
    expect(createdConversation.status).toBe(201);
    const createdConversationPayload = (await createdConversation.json()) as {
      conversation: { conversationId: string };
    };
    const conversationId = createdConversationPayload.conversation.conversationId;

    const streamResponse = await fetch(
      `http://localhost:${port}/api/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      },
    );
    expect(streamResponse.status).toBe(200);
    const streamPayload = await streamResponse.text();
    expect(streamPayload).toContain("event: model:chunk");

    const getConversation = await fetch(`http://localhost:${port}/api/conversations/${conversationId}`);
    expect(getConversation.status).toBe(200);
    const payload = (await getConversation.json()) as {
      conversation: { messages: Message[] };
    };
    expect(payload.conversation.messages.at(-1)?.content).toBe("hello");

    const legacyRunSync = await fetch(`http://localhost:${port}/run/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "legacy" }),
    });
    expect(legacyRunSync.status).toBe(404);
    const legacyContinue = await fetch(`http://localhost:${port}/continue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run_test", message: "next" }),
    });
    expect(legacyContinue.status).toBe(404);

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

  it("supports web ui auth and conversation routes", async () => {
    await initProject("webui-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "webui-agent");
    process.env.AGENT_UI_PASSPHRASE = "very-secret-passphrase";

    const port = 44000 + Math.floor(Math.random() * 1000);
    const server = await startDevServer(port, { workingDir: projectDir });
    try {
      const sessionState = await fetch(`http://localhost:${port}/api/auth/session`);
      const sessionPayload = (await sessionState.json()) as { authenticated: boolean };
      expect(sessionPayload.authenticated).toBe(false);

      const login = await fetch(`http://localhost:${port}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: "very-secret-passphrase" }),
      });
      expect(login.status).toBe(200);
      const loginPayload = (await login.json()) as { csrfToken: string };
      const setCookieHeader = login.headers.get("set-cookie");
      expect(setCookieHeader).toContain("agentl_session=");
      const cookie = (setCookieHeader ?? "").split(";")[0] ?? "";

      const conversationCreate = await fetch(`http://localhost:${port}/api/conversations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          "x-csrf-token": loginPayload.csrfToken,
        },
        body: JSON.stringify({ title: "My test conversation" }),
      });
      expect(conversationCreate.status).toBe(201);
      const createdPayload = (await conversationCreate.json()) as {
        conversation: { conversationId: string };
      };
      const conversationId = createdPayload.conversation.conversationId;

      const streamResponse = await fetch(
        `http://localhost:${port}/api/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            "x-csrf-token": loginPayload.csrfToken,
          },
          body: JSON.stringify({ message: "hello from web ui" }),
        },
      );
      expect(streamResponse.status).toBe(200);
      const streamText = await streamResponse.text();
      expect(streamText).toContain("event: model:chunk");

      const conversationRead = await fetch(
        `http://localhost:${port}/api/conversations/${conversationId}`,
        {
          headers: {
            Cookie: cookie,
          },
        },
      );
      expect(conversationRead.status).toBe(200);
      const conversationPayload = (await conversationRead.json()) as {
        conversation: { messages: Message[] };
      };
      expect(conversationPayload.conversation.messages.length).toBeGreaterThan(0);
    } finally {
      delete process.env.AGENT_UI_PASSPHRASE;
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
  });

  it("persists conversation data in shared user store", async () => {
    const projectDir = join(tempDir, "store-agent");
    await mkdir(projectDir, { recursive: true });
    const store = new FileConversationStore(projectDir);

    const created = await store.create("local-owner", "store test");
    expect(created.messages).toHaveLength(0);

    created.messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    await store.update(created);

    const listed = await store.list("local-owner");
    expect(listed.length).toBeGreaterThan(0);
    expect(listed[0]?.conversationId).toBe(created.conversationId);

    const opened = await store.get(created.conversationId);
    expect(opened?.messages.length).toBe(2);

    const removed = await store.delete(created.conversationId);
    expect(removed).toBe(true);
  });

  it("parses malformed cookies without throwing", () => {
    const request = {
      headers: {
        cookie: "ok=value; bad=%E0%A4%A",
      },
    } as unknown as import("node:http").IncomingMessage;
    const parsed = parseCookies(request);
    expect(parsed.ok).toBe("value");
    expect(parsed.bad).toBe("%E0%A4%A");
  });

  it("uses socket remote address for request ip", () => {
    const request = {
      headers: {
        "x-forwarded-for": "1.2.3.4",
      },
      socket: {
        remoteAddress: "127.0.0.1",
      },
    } as unknown as import("node:http").IncomingMessage;
    expect(getRequestIp(request)).toBe("127.0.0.1");
  });

  it("supports web ui passphrase auth in production mode", async () => {
    await initProject("webui-prod-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "webui-prod-agent");
    process.env.AGENT_UI_PASSPHRASE = "prod-secret-passphrase";
    process.env.NODE_ENV = "production";

    const port = 45000 + Math.floor(Math.random() * 1000);
    const server = await startDevServer(port, { workingDir: projectDir });
    try {
      const login = await fetch(`http://localhost:${port}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase: "prod-secret-passphrase" }),
      });
      expect(login.status).toBe(200);
      const setCookieHeader = login.headers.get("set-cookie") ?? "";
      expect(setCookieHeader).toContain("agentl_session=");
      expect(setCookieHeader).toContain("Secure");
    } finally {
      delete process.env.AGENT_UI_PASSPHRASE;
      delete process.env.NODE_ENV;
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
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
    expect(vercelConfig).toContain('"functions"');
    expect(vercelConfig).toContain('"routes"');
    expect(vercelConfig).not.toContain('"builds"');
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

  it("does not modify AGENT.md when no deprecated embedded guidance exists", async () => {
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

    expect(changed).toBe(false);
    expect(updated).toContain("Old instructions only.");
  });

  it("removes deprecated embedded local guidance sections", async () => {
    const projectDir = join(tempDir, "legacy-agent-guidance");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "AGENT.md"),
      `---
name: legacy-agent
---

# Legacy Agent

## Configuration Assistant Context

Old local config guidance that should be removed.

## Skill Authoring Guidance

Old guidance that should be removed.

## Other Section

Keep this section.
`,
      "utf8",
    );

    const changed = await updateAgentGuidance(projectDir);
    const updated = await readFile(join(projectDir, "AGENT.md"), "utf8");

    expect(changed).toBe(true);
    expect(updated).not.toContain("## Configuration Assistant Context");
    expect(updated).not.toContain("## Skill Authoring Guidance");
    expect(updated).not.toContain("Old local config guidance that should be removed.");
    expect(updated).not.toContain("Old guidance that should be removed.");
    expect(updated).toContain("## Other Section");
  });
});
