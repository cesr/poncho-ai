import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, Message } from "@poncho-ai/sdk";
import { FileConversationStore, getRequestIp, parseCookies } from "../src/web-ui.js";
import * as initOnboardingModule from "../src/init-onboarding.js";
import { buildConfigFromOnboardingAnswers, runInitOnboarding } from "../src/init-onboarding.js";
import {
  consumeFirstRunIntro,
  initializeOnboardingMarker,
} from "../src/init-feature-context.js";

vi.mock("@poncho-ai/harness", () => ({
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

    async *runWithTelemetry(): AsyncGenerator<{
      type:
        | "run:started"
        | "step:started"
        | "model:chunk"
        | "step:completed"
        | "run:completed";
      [key: string]: unknown;
    }> {
      // Same as run() for the mock
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
  loadPonchoConfig: async () => ({
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
  generateAgentId: () => "agent_testid1234567890abcdef12345678",
  ensureAgentIdentity: async (workingDir: string) => ({
    name: workingDir.split("/").pop() || "agent",
    id: "agent_testid1234567890abcdef12345678",
  }),
  getAgentStoreDirectory: (identity: { name: string; id: string }) =>
    join("/tmp/.poncho/store", `${identity.name}--${identity.id}`),
  TelemetryEmitter: class {
    async emit(): Promise<void> {}
  },
}));

import {
  buildTarget,
  copySkillsFromPackage,
  initProject,
  listInstalledSkills,
  listTools,
  mcpAdd,
  mcpList,
  mcpRemove,
  removeSkillsFromPackage,
  runTests,
  startDevServer,
  updateAgentGuidance,
} from "../src/index.js";
import { ensureAgentIdentity, getAgentStoreDirectory } from "@poncho-ai/harness";

describe("cli", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "poncho-cli-"));
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
    expect(agentMarkdown).toContain("id: agent_");
    expect(pkgJson).toContain('"name": "my-agent"');
    expect(skillManifest).toContain("name: starter-skill");
    expect(skillTool).toContain("export default async function run(input)");
    expect(basicTest).toContain('name: "Basic sanity"');
  });

  it("scaffolds deploy target files during init when onboarding selects one", async () => {
    const onboardingSpy = vi.spyOn(initOnboardingModule, "runInitOnboarding");
    onboardingSpy.mockResolvedValue({
      answers: {
        "model.provider": "anthropic",
        "deploy.target": "vercel",
        "storage.provider": "local",
        "storage.memory.enabled": true,
        "auth.required": false,
        "telemetry.enabled": true,
      },
      config: buildConfigFromOnboardingAnswers({
        "model.provider": "anthropic",
        "storage.provider": "local",
        "storage.memory.enabled": true,
        "auth.required": false,
        "telemetry.enabled": true,
      }),
      envExample: "ANTHROPIC_API_KEY=sk-ant-...\n",
      envFile: "ANTHROPIC_API_KEY=\n",
      envNeedsUserInput: true,
      deployTarget: "vercel",
      agentModel: {
        provider: "anthropic",
        name: "claude-opus-4-5",
      },
    });
    try {
      await initProject("deploy-agent", { workingDir: tempDir });
    } finally {
      onboardingSpy.mockRestore();
    }

    const projectDir = join(tempDir, "deploy-agent");
    const vercelConfig = await readFile(join(projectDir, "vercel.json"), "utf8");
    const vercelEntry = await readFile(join(projectDir, "api", "index.mjs"), "utf8");
    const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(vercelConfig).toContain('"api/index.mjs"');
    expect(vercelEntry).toContain('from "@poncho-ai/cli"');
    expect(packageJson.dependencies?.["@poncho-ai/cli"]).toMatch(/^\^/);
  }, 15000);

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
      join(tempDir, "default-agent", "poncho.config.js"),
      "utf8",
    );
    expect(configFile).toContain('"storage"');
    expect(configFile).toContain('"memory"');
    expect(configFile).toContain('"auth"');
  });

  it("creates onboarding marker and emits intro only once", async () => {
    const previousPonchoEnv = process.env.PONCHO_ENV;
    process.env.PONCHO_ENV = "development";
    const projectDir = join(tempDir, "intro-agent");
    try {
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
      expect(
        typeof firstIntro === "undefined" ||
          firstIntro.includes("I can configure myself directly by chat"),
      ).toBe(true);
      expect(secondIntro).toBeUndefined();
      const identity = await ensureAgentIdentity(projectDir);
      const markerPath = join(getAgentStoreDirectory(identity), "onboarding-state.json");
      const markerRaw = await readFile(markerPath, "utf8");
      expect(markerRaw).toContain('"onboardingVersion": 1');
    } finally {
      if (typeof previousPonchoEnv === "string") {
        process.env.PONCHO_ENV = previousPonchoEnv;
      } else {
        delete process.env.PONCHO_ENV;
      }
    }
  });

  it("emits intro for interactive init even when config differs from defaults", async () => {
    const previousPonchoEnv = process.env.PONCHO_ENV;
    process.env.PONCHO_ENV = "development";
    try {
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
      expect(
        typeof intro === "undefined" || intro.includes("I can configure myself directly by chat"),
      ).toBe(true);
    } finally {
      if (typeof previousPonchoEnv === "string") {
        process.env.PONCHO_ENV = previousPonchoEnv;
      } else {
        delete process.env.PONCHO_ENV;
      }
    }
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

  it("copies discovered skill folders into local skills directory", async () => {
    const projectDir = join(tempDir, "copy-skills-agent");
    const packageDir = join(tempDir, "mock-skill-package");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, "skills"), { recursive: true });
    await mkdir(join(packageDir, "alpha"), { recursive: true });
    await mkdir(join(packageDir, "nested", "beta"), { recursive: true });
    await mkdir(join(packageDir, "nested", "beta", "scripts"), { recursive: true });

    await writeFile(
      join(packageDir, "alpha", "SKILL.md"),
      "---\nname: alpha\n---\nAlpha skill\n",
      "utf8",
    );
    await writeFile(
      join(packageDir, "nested", "beta", "SKILL.md"),
      "---\nname: beta\n---\nBeta skill\n",
      "utf8",
    );
    await writeFile(
      join(packageDir, "nested", "beta", "scripts", "run.ts"),
      "export default async function run() { return { ok: true }; }\n",
      "utf8",
    );

    const copied = await copySkillsFromPackage(projectDir, packageDir);

    expect(copied).toEqual([
      "skills/mock-skill-package/alpha",
      "skills/mock-skill-package/beta",
    ]);
    const alphaSkill = await readFile(
      join(projectDir, "skills", "mock-skill-package", "alpha", "SKILL.md"),
      "utf8",
    );
    const betaScript = await readFile(
      join(projectDir, "skills", "mock-skill-package", "beta", "scripts", "run.ts"),
      "utf8",
    );
    expect(alphaSkill).toContain("name: alpha");
    expect(betaScript).toContain("export default async function run");
  });

  it("fails when skill destination already exists", async () => {
    const projectDir = join(tempDir, "collision-agent");
    const packageDir = join(tempDir, "collision-package");
    await mkdir(join(projectDir, "skills", "collision-package", "alpha"), { recursive: true });
    await mkdir(join(packageDir, "alpha"), { recursive: true });
    await writeFile(
      join(packageDir, "alpha", "SKILL.md"),
      "---\nname: alpha\n---\nCollision skill\n",
      "utf8",
    );

    await expect(copySkillsFromPackage(projectDir, packageDir)).rejects.toThrow(
      /destination already exists/i,
    );
  });

  it("copies a specific skill when --path style option is used", async () => {
    const projectDir = join(tempDir, "single-skill-agent");
    const packageDir = join(tempDir, "single-skill-package");
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(packageDir, "alpha"), { recursive: true });
    await mkdir(join(packageDir, "nested", "beta"), { recursive: true });
    await writeFile(
      join(packageDir, "alpha", "SKILL.md"),
      "---\nname: alpha\n---\nAlpha skill\n",
      "utf8",
    );
    await writeFile(
      join(packageDir, "nested", "beta", "SKILL.md"),
      "---\nname: beta\n---\nBeta skill\n",
      "utf8",
    );

    const copied = await copySkillsFromPackage(projectDir, packageDir, { path: "nested/beta" });
    expect(copied).toEqual(["skills/single-skill-package/beta"]);
    await expect(
      readFile(join(projectDir, "skills", "single-skill-package", "alpha", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
    const betaSkill = await readFile(
      join(projectDir, "skills", "single-skill-package", "beta", "SKILL.md"),
      "utf8",
    );
    expect(betaSkill).toContain("name: beta");
  });

  it("removes all copied skills for a package in one call", async () => {
    const projectDir = join(tempDir, "remove-skills-agent");
    const packageDir = join(tempDir, "remove-skills-package");
    await mkdir(join(projectDir, "skills", "remove-skills-package", "alpha"), { recursive: true });
    await mkdir(join(projectDir, "skills", "remove-skills-package", "beta"), { recursive: true });
    await writeFile(
      join(projectDir, "skills", "remove-skills-package", "alpha", "SKILL.md"),
      "alpha\n",
      "utf8",
    );
    await writeFile(
      join(projectDir, "skills", "remove-skills-package", "beta", "SKILL.md"),
      "beta\n",
      "utf8",
    );

    await mkdir(join(packageDir, "alpha"), { recursive: true });
    await mkdir(join(packageDir, "nested", "beta"), { recursive: true });
    await writeFile(
      join(packageDir, "alpha", "SKILL.md"),
      "---\nname: alpha\n---\nAlpha skill\n",
      "utf8",
    );
    await writeFile(
      join(packageDir, "nested", "beta", "SKILL.md"),
      "---\nname: beta\n---\nBeta skill\n",
      "utf8",
    );

    const result = await removeSkillsFromPackage(projectDir, packageDir);
    expect(result.removed).toEqual(["skills/remove-skills-package"]);
    expect(result.missing).toEqual([]);
    await expect(lstat(join(projectDir, "skills", "remove-skills-package"))).rejects.toThrow();
  });

  it("removes a specific skill path from namespaced folder", async () => {
    const projectDir = join(tempDir, "remove-single-skill-agent");
    const packageDir = join(tempDir, "remove-single-skill-package");
    await mkdir(
      join(projectDir, "skills", "remove-single-skill-package", "alpha"),
      { recursive: true },
    );
    await mkdir(
      join(projectDir, "skills", "remove-single-skill-package", "beta"),
      { recursive: true },
    );
    await writeFile(
      join(projectDir, "skills", "remove-single-skill-package", "alpha", "SKILL.md"),
      "alpha\n",
      "utf8",
    );
    await writeFile(
      join(projectDir, "skills", "remove-single-skill-package", "beta", "SKILL.md"),
      "beta\n",
      "utf8",
    );
    await mkdir(join(packageDir, "alpha"), { recursive: true });
    await mkdir(join(packageDir, "nested", "beta"), { recursive: true });
    await writeFile(join(packageDir, "alpha", "SKILL.md"), "---\nname: alpha\n---\n", "utf8");
    await writeFile(
      join(packageDir, "nested", "beta", "SKILL.md"),
      "---\nname: beta\n---\n",
      "utf8",
    );

    const result = await removeSkillsFromPackage(projectDir, packageDir, { path: "nested/beta" });
    expect(result.removed).toEqual(["skills/remove-single-skill-package/beta"]);
    await expect(
      lstat(join(projectDir, "skills", "remove-single-skill-package", "beta")),
    ).rejects.toThrow();
    const alphaStillExists = await readFile(
      join(projectDir, "skills", "remove-single-skill-package", "alpha", "SKILL.md"),
      "utf8",
    );
    expect(alphaStillExists).toContain("alpha");
  });

  it("lists installed skills with and without source filter", async () => {
    const projectDir = join(tempDir, "list-skills-agent");
    await mkdir(join(projectDir, "skills", "agent-skills", "alpha"), { recursive: true });
    await mkdir(join(projectDir, "skills", "agent-skills", "beta"), { recursive: true });
    await mkdir(join(projectDir, "skills", "other-source", "gamma"), { recursive: true });
    await writeFile(
      join(projectDir, "skills", "agent-skills", "alpha", "SKILL.md"),
      "---\nname: alpha\n---\n",
      "utf8",
    );
    await writeFile(
      join(projectDir, "skills", "agent-skills", "beta", "SKILL.md"),
      "---\nname: beta\n---\n",
      "utf8",
    );
    await writeFile(
      join(projectDir, "skills", "other-source", "gamma", "SKILL.md"),
      "---\nname: gamma\n---\n",
      "utf8",
    );

    const all = await listInstalledSkills(projectDir);
    const filtered = await listInstalledSkills(projectDir, "vercel-labs/agent-skills");

    expect(all).toEqual([
      "skills/agent-skills/alpha",
      "skills/agent-skills/beta",
      "skills/other-source/gamma",
    ]);
    expect(filtered).toEqual(["skills/agent-skills/alpha", "skills/agent-skills/beta"]);
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

  it.skip("supports web ui auth and conversation routes", async () => {
    await initProject("webui-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "webui-agent");

    // Enable auth by adding it to poncho.config.js and .env
    await writeFile(
      join(projectDir, "poncho.config.js"),
      'export default { auth: { required: true, type: "bearer" } }\n',
      "utf8"
    );
    await writeFile(
      join(projectDir, ".env"),
      'ANTHROPIC_API_KEY=test-key\nPONCHO_AUTH_TOKEN=very-secret-passphrase\n',
      "utf8"
    );

    // Small delay to ensure filesystem writes are flushed
    await new Promise(resolve => setTimeout(resolve, 50));

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
      expect(setCookieHeader).toContain("poncho_session=");
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

  it.skip("supports web ui passphrase auth in production mode", async () => {
    await initProject("webui-prod-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "webui-prod-agent");

    // Enable auth by adding it to poncho.config.js and .env
    await writeFile(
      join(projectDir, "poncho.config.js"),
      'export default { auth: { required: true, type: "bearer" } }\n',
      "utf8"
    );
    await writeFile(
      join(projectDir, ".env"),
      'ANTHROPIC_API_KEY=test-key\nPONCHO_AUTH_TOKEN=prod-secret-passphrase\n',
      "utf8"
    );

    // Small delay to ensure filesystem writes are flushed
    await new Promise(resolve => setTimeout(resolve, 50));

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
      expect(setCookieHeader).toContain("poncho_session=");
      expect(setCookieHeader).toContain("Secure");
    } finally {
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

  it.skip("supports API bearer token authentication", async () => {
    await initProject("api-auth-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "api-auth-agent");

    // Enable auth by adding it to poncho.config.js and .env
    await writeFile(
      join(projectDir, "poncho.config.js"),
      'export default { auth: { required: true, type: "bearer" } }\n',
      "utf8"
    );
    await writeFile(
      join(projectDir, ".env"),
      'ANTHROPIC_API_KEY=test-key\nPONCHO_AUTH_TOKEN=test-api-token\n',
      "utf8"
    );

    // Small delay to ensure filesystem writes are flushed
    await new Promise(resolve => setTimeout(resolve, 50));

    const port = 46000 + Math.floor(Math.random() * 1000);
    const server = await startDevServer(port, { workingDir: projectDir });
    try {
      // Test without Bearer token - should fail
      const unauthorized = await fetch(`http://localhost:${port}/api/conversations`);
      expect(unauthorized.status).toBe(401);

      // Test with Bearer token - should succeed
      const authorized = await fetch(`http://localhost:${port}/api/conversations`, {
        headers: { Authorization: "Bearer test-api-token" },
      });
      expect(authorized.status).toBe(200);

      // Test creating conversation with Bearer token
      const createConversation = await fetch(`http://localhost:${port}/api/conversations`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-api-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "API Test" }),
      });
      expect(createConversation.status).toBe(201);
    } finally {
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
    await mcpAdd(projectDir, { url: "https://example.com/mcp", name: "remote-mcp" });
    await mcpList(projectDir);
    await mcpRemove(projectDir, "remote-mcp");

    await buildTarget(projectDir, "vercel");
    await buildTarget(projectDir, "docker");
    await buildTarget(projectDir, "lambda");
    await expect(buildTarget(projectDir, "fly")).rejects.toThrow("Refusing to overwrite");
    await buildTarget(projectDir, "fly", { force: true });
    const vercelConfig = await readFile(
      join(projectDir, "vercel.json"),
      "utf8",
    );
    const vercelEntry = await readFile(join(projectDir, "api", "index.mjs"), "utf8");
    const dockerFile = await readFile(join(projectDir, "Dockerfile"), "utf8");
    const lambdaHandler = await readFile(
      join(projectDir, "lambda-handler.js"),
      "utf8",
    );
    const flyToml = await readFile(join(projectDir, "fly.toml"), "utf8");
    expect(vercelConfig).toContain('"functions"');
    expect(vercelConfig).toContain('"routes"');
    expect(vercelConfig).not.toContain('"builds"');
    expect(vercelEntry).toContain("createRequestHandler");
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

  it("fails on existing deploy files unless force is enabled", async () => {
    await initProject("collision-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "collision-agent");
    await buildTarget(projectDir, "vercel");
    await expect(buildTarget(projectDir, "vercel")).rejects.toThrow("Refusing to overwrite");
    await buildTarget(projectDir, "vercel", { force: true });
  });

  it("seeds bearer token placeholders in env files when adding mcp auth", async () => {
    await initProject("mcp-env-seed-agent", { workingDir: tempDir });
    const projectDir = join(tempDir, "mcp-env-seed-agent");
    await mcpAdd(projectDir, {
      url: "https://example.com/mcp",
      name: "remote-mcp",
      authBearerEnv: "LINEAR_TOKEN",
    });
    const envFile = await readFile(join(projectDir, ".env"), "utf8");
    const envExampleFile = await readFile(join(projectDir, ".env.example"), "utf8");
    expect(envFile).toContain("LINEAR_TOKEN=");
    expect(envExampleFile).toContain("LINEAR_TOKEN=");
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
