import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  AgentHarness,
  TelemetryEmitter,
  createStateStore,
  loadAgentlConfig,
  type AgentlConfig,
} from "@agentl/harness";
import type { AgentEvent, Message, RunInput } from "@agentl/sdk";
import { Command } from "commander";
import dotenv from "dotenv";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const writeJson = (response: ServerResponse, statusCode: number, payload: unknown) => {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
};

const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.length > 0 ? (JSON.parse(body) as unknown) : {};
};

const resolveHarnessEnvironment = (): "development" | "staging" | "production" => {
  const value = (process.env.AGENTL_ENV ?? process.env.NODE_ENV ?? "development").toLowerCase();
  if (value === "production" || value === "staging") {
    return value;
  }
  return "development";
};

const listenOnAvailablePort = async (
  server: Server,
  preferredPort: number,
): Promise<number> =>
  await new Promise<number>((resolveListen, rejectListen) => {
    let currentPort = preferredPort;

    const tryListen = (): void => {
      const onListening = (): void => {
        server.off("error", onError);
        resolveListen(currentPort);
      };

      const onError = (error: unknown): void => {
        server.off("listening", onListening);
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "EADDRINUSE"
        ) {
          currentPort += 1;
          if (currentPort > 65535) {
            rejectListen(
              new Error(
                "No available ports found from the requested port up to 65535.",
              ),
            );
            return;
          }
          setImmediate(tryListen);
          return;
        }
        rejectListen(error);
      };

      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(currentPort);
    };

    tryListen();
  });

const readJsonFile = async <T>(path: string): Promise<T | undefined> => {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
};

const parseParams = (values: string[]): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const value of values) {
    const [key, ...rest] = value.split("=");
    if (!key) {
      continue;
    }
    params[key] = rest.join("=");
  }
  return params;
};

const AGENT_SKILL_GUIDANCE = `## Skill Authoring Guidance

When asked to create or update a skill:

1. Inspect current skills under \`skills/\` first (\`list_directory\`, \`read_file\`).
2. Decide skill type before writing files:
   - **Instruction skill (no tool code)** for summarization, rewriting, classification, translation, planning, and other pure language tasks.
   - **Tool-backed skill** only when external I/O, deterministic transforms, side effects, or integrations are required.
3. If creating a tool-backed skill, create/update:
   - \`skills/<skill-name>/SKILL.md\`
   - \`skills/<skill-name>/tools/<tool-name>.ts\`
4. Keep tool names and schemas explicit and stable.
5. Never create placeholder tool handlers for tasks the model can already do directly.
6. After writing files, verify by listing/reading the created paths.
7. Ask the user to run \`agentl tools\` to confirm the new tool is discovered (when tools were added).

Skill file conventions:
- \`SKILL.md\` frontmatter should include \`name\`, \`description\`, and \`tools\`.
- Tool modules should export a default tool definition object with:
  - \`name\`
  - \`description\`
  - \`inputSchema\`
  - \`handler\``;

const AGENT_TEMPLATE = `---
name: my-agent
description: A helpful AgentL assistant
model:
  provider: anthropic
  name: claude-sonnet-4-20250514
  temperature: 0.2
limits:
  maxSteps: 50
  timeout: 300
---

# My Agent

You are a helpful assistant built with AgentL.

Working directory: {{runtime.workingDir}}
Environment: {{runtime.environment}}

## Task Guidance

- Use tools when needed
- Explain your reasoning clearly
- Ask clarifying questions when requirements are ambiguous
- Never claim a file/tool change unless the corresponding tool call actually succeeded

${AGENT_SKILL_GUIDANCE}
`;

const CONFIG_TEMPLATE = `export default {
  mcp: [],
  auth: { required: false },
  state: { provider: 'memory', ttl: 3600 },
  telemetry: { enabled: true }
}
`;

const PACKAGE_TEMPLATE = (name: string): string =>
  JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      dependencies: {
        "@agentl/harness": "^0.1.0",
        "@agentl/sdk": "^0.1.0",
      },
    },
    null,
    2,
  );

const ENV_TEMPLATE = "ANTHROPIC_API_KEY=sk-ant-...\n";
const GITIGNORE_TEMPLATE = ".env\nnode_modules\ndist\n";
const VERCEL_RUNTIME_DEPENDENCIES: Record<string, string> = {
  "@anthropic-ai/sdk": "^0.74.0",
  "@aws-sdk/client-dynamodb": "^3.988.0",
  "@latitude-data/telemetry": "^2.0.2",
  "@vercel/kv": "^3.0.0",
  commander: "^12.0.0",
  dotenv: "^16.4.0",
  jiti: "^2.6.1",
  mustache: "^4.2.0",
  openai: "^6.3.0",
  redis: "^5.10.0",
  ws: "^8.18.0",
  yaml: "^2.8.1",
};
const TEST_TEMPLATE = `tests:
  - name: "Basic sanity"
    task: "What is 2 + 2?"
    expect:
      contains: "4"
`;

const SKILL_TEMPLATE = `---
name: starter-skill
version: 1.0.0
description: Starter local skill template
tools:
  - starter-echo
---

# Starter Skill

This is a starter local skill created by \`agentl init\`.

## Authoring Notes

- Keep the \`tools\` frontmatter list in sync with actual tool module names.
- Prefer narrow, explicit schemas for predictable tool calling.
- After edits, run \`agentl tools\` to confirm discovery.
`;

const SKILL_TOOL_TEMPLATE = `export default {
  name: "starter-echo",
  description: "Echoes a message for testing local skill wiring",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to echo" }
    },
    required: ["message"]
  },
  async handler(input) {
    return { echoed: input.message };
  }
};
`;

const ensureFile = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
};

const copyIfExists = async (sourcePath: string, destinationPath: string): Promise<void> => {
  try {
    await access(sourcePath);
  } catch {
    return;
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true });
};

const resolveCliEntrypoint = async (): Promise<string> => {
  const sourceEntrypoint = resolve(packageRoot, "src", "index.ts");
  try {
    await access(sourceEntrypoint);
    return sourceEntrypoint;
  } catch {
    return resolve(packageRoot, "dist", "index.js");
  }
};

const buildVercelHandlerBundle = async (outDir: string): Promise<void> => {
  const { build: esbuild } = await import("esbuild");
  const cliEntrypoint = await resolveCliEntrypoint();
  const tempEntry = resolve(outDir, "api", "_entry.js");
  await writeFile(
    tempEntry,
    `import { startDevServer } from ${JSON.stringify(cliEntrypoint)};
let serverPromise;
export default async function handler(req, res) {
  if (!serverPromise) {
    serverPromise = startDevServer(0, { workingDir: process.cwd() });
  }
  const server = await serverPromise;
  server.emit("request", req, res);
}
`,
    "utf8",
  );
  await esbuild({
    entryPoints: [tempEntry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: resolve(outDir, "api", "index.js"),
    sourcemap: false,
    legalComments: "none",
    external: [
      ...Object.keys(VERCEL_RUNTIME_DEPENDENCIES),
      "@anthropic-ai/sdk/*",
      "child_process",
      "fs",
      "fs/promises",
      "http",
      "https",
      "path",
      "module",
      "url",
      "readline",
      "readline/promises",
      "crypto",
      "stream",
      "events",
      "util",
      "os",
      "zlib",
      "net",
      "tls",
      "dns",
      "assert",
      "buffer",
      "timers",
      "timers/promises",
      "node:child_process",
      "node:fs",
      "node:fs/promises",
      "node:http",
      "node:https",
      "node:path",
      "node:module",
      "node:url",
      "node:readline",
      "node:readline/promises",
      "node:crypto",
      "node:stream",
      "node:events",
      "node:util",
      "node:os",
      "node:zlib",
      "node:net",
      "node:tls",
      "node:dns",
      "node:assert",
      "node:buffer",
      "node:timers",
      "node:timers/promises",
    ],
  });
};

const writeConfigFile = async (workingDir: string, config: AgentlConfig): Promise<void> => {
  const serialized = `export default ${JSON.stringify(config, null, 2)}\n`;
  await writeFile(resolve(workingDir, "agentl.config.js"), serialized, "utf8");
};

const extractToken = (
  request: IncomingMessage,
  authConfig: NonNullable<AgentlConfig["auth"]>,
): string => {
  if (authConfig.type === "header") {
    const headerName = (authConfig.headerName ?? "x-agent-api-key").toLowerCase();
    const raw = request.headers[headerName];
    return Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
  }

  const authHeader = request.headers.authorization ?? "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return "";
};

const authorizeRequest = async (
  request: IncomingMessage,
  config: AgentlConfig | undefined,
): Promise<boolean> => {
  const authConfig = config?.auth;
  if (!authConfig?.required) {
    return true;
  }
  const token = extractToken(request, authConfig);
  if (!token) {
    return false;
  }
  if (authConfig.validate) {
    return await authConfig.validate(token, request);
  }
  return token === (process.env.AGENT_API_KEY ?? "");
};

export const initProject = async (
  projectName: string,
  options?: { workingDir?: string },
): Promise<void> => {
  const baseDir = options?.workingDir ?? process.cwd();
  const projectDir = resolve(baseDir, projectName);
  await mkdir(projectDir, { recursive: true });

  await ensureFile(resolve(projectDir, "AGENT.md"), AGENT_TEMPLATE);
  await ensureFile(resolve(projectDir, "agentl.config.js"), CONFIG_TEMPLATE);
  await ensureFile(resolve(projectDir, "package.json"), PACKAGE_TEMPLATE(projectName));
  await ensureFile(resolve(projectDir, ".env.example"), ENV_TEMPLATE);
  await ensureFile(resolve(projectDir, ".gitignore"), GITIGNORE_TEMPLATE);
  await ensureFile(resolve(projectDir, "tests", "basic.yaml"), TEST_TEMPLATE);
  await ensureFile(resolve(projectDir, "skills", "starter", "SKILL.md"), SKILL_TEMPLATE);
  await ensureFile(
    resolve(projectDir, "skills", "starter", "tools", "starter-echo.ts"),
    SKILL_TOOL_TEMPLATE,
  );

  process.stdout.write(`Initialized AgentL project at ${projectDir}\n`);
};

export const updateAgentGuidance = async (workingDir: string): Promise<boolean> => {
  const agentPath = resolve(workingDir, "AGENT.md");
  const content = await readFile(agentPath, "utf8");
  const guidanceSectionPattern = /## Skill Authoring Guidance[\s\S]*?(?=\n## |\n# |$)/;
  const normalized = content.replace(/\s+$/g, "");
  const hasGuidance = guidanceSectionPattern.test(normalized);
  const updated = hasGuidance
    ? normalized.replace(guidanceSectionPattern, AGENT_SKILL_GUIDANCE)
    : `${normalized}\n\n${AGENT_SKILL_GUIDANCE}\n`;
  if (updated === normalized) {
    process.stdout.write("AGENT.md guidance is already up to date.\n");
    return false;
  }
  await writeFile(agentPath, updated, "utf8");
  process.stdout.write("Updated AGENT.md with latest skill authoring guidance.\n");
  return true;
};

const formatSseEvent = (event: AgentEvent): string =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export const startDevServer = async (
  port: number,
  options?: { workingDir?: string },
): Promise<Server> => {
  const workingDir = options?.workingDir ?? process.cwd();
  dotenv.config({ path: resolve(workingDir, ".env") });
  const config = await loadAgentlConfig(workingDir);
  const harness = new AgentHarness({ workingDir });
  await harness.initialize();
  const telemetry = new TelemetryEmitter(config?.telemetry);
  const stateStore = createStateStore(config?.state);

  const server = createServer(async (request, response) => {
    if (!request.url || !request.method) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }
    const [pathname] = request.url.split("?");

    if (pathname === "/health" && request.method === "GET") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (!(await authorizeRequest(request, config))) {
      writeJson(response, 401, {
        code: "AUTH_ERROR",
        message: "Authentication failed",
      });
      return;
    }

    if (pathname === "/run/sync" && request.method === "POST") {
      try {
        const input = (await readRequestBody(request)) as RunInput;
        const output = await harness.runToCompletion(input);
        await stateStore.set({
          runId: output.runId,
          messages: output.messages,
          updatedAt: Date.now(),
        });
        for (const event of output.events) {
          await telemetry.emit(event);
        }
        writeJson(response, 200, {
          runId: output.runId,
          status: output.result.status,
          result: output.result,
        });
      } catch (error) {
        writeJson(response, 500, {
          code: "RUN_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
      return;
    }

    if (pathname === "/run" && request.method === "POST") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      try {
        const input = (await readRequestBody(request)) as RunInput;
        let runId = "";
        let finalResponse = "";
        const baseMessages: Message[] = [
          ...(input.messages ?? []),
          { role: "user", content: input.task },
        ];
        for await (const event of harness.run(input)) {
          if (event.type === "run:started") {
            runId = event.runId;
          }
          if (event.type === "run:completed") {
            finalResponse = event.result.response ?? "";
          }
          await telemetry.emit(event);
          response.write(formatSseEvent(event));
        }
        if (runId) {
          await stateStore.set({
            runId,
            messages: [...baseMessages, { role: "assistant", content: finalResponse }],
            updatedAt: Date.now(),
          });
        }
      } catch (error) {
        response.write(
          formatSseEvent({
            type: "run:error",
            runId: "run_unknown",
            error: {
              code: "RUN_ERROR",
              message: error instanceof Error ? error.message : "Unknown error",
            },
          }),
        );
      } finally {
        response.end();
      }
      return;
    }

    if (pathname === "/continue" && request.method === "POST") {
      try {
        const body = (await readRequestBody(request)) as {
          runId?: string;
          message?: string;
          parameters?: Record<string, unknown>;
        };
        if (!body.runId || !body.message) {
          writeJson(response, 400, {
            code: "VALIDATION_ERROR",
            message: "Both runId and message are required",
          });
          return;
        }

        const state = await stateStore.get(body.runId);
        if (!state) {
          writeJson(response, 404, {
            code: "RUN_NOT_FOUND",
            message: `No conversation found for runId ${body.runId}`,
          });
          return;
        }

        const output = await harness.runToCompletion({
          task: body.message,
          parameters: body.parameters,
          messages: state.messages,
        });
        await stateStore.set({
          runId: output.runId,
          messages: output.messages,
          updatedAt: Date.now(),
        });
        for (const event of output.events) {
          await telemetry.emit(event);
        }
        writeJson(response, 200, {
          runId: output.runId,
          status: output.result.status,
          result: output.result,
        });
      } catch (error) {
        writeJson(response, 500, {
          code: "CONTINUE_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  });

  const actualPort = await listenOnAvailablePort(server, port);
  if (actualPort !== port) {
    process.stdout.write(
      `Port ${port} is in use, switched to ${actualPort}.\n`,
    );
  }
  process.stdout.write(`AgentL dev server running at http://localhost:${actualPort}\n`);
  return server;
};

export const runOnce = async (
  task: string,
  options: {
    params: Record<string, string>;
    json: boolean;
    filePaths: string[];
    workingDir?: string;
  },
): Promise<void> => {
  const workingDir = options.workingDir ?? process.cwd();
  dotenv.config({ path: resolve(workingDir, ".env") });
  const config = await loadAgentlConfig(workingDir);
  const harness = new AgentHarness({ workingDir });
  const telemetry = new TelemetryEmitter(config?.telemetry);
  await harness.initialize();

  const fileBlobs = await Promise.all(
    options.filePaths.map(async (path) => {
      const content = await readFile(resolve(workingDir, path), "utf8");
      return `# File: ${path}\n${content}`;
    }),
  );

  const input: RunInput = {
    task: fileBlobs.length > 0 ? `${task}\n\n${fileBlobs.join("\n\n")}` : task,
    parameters: options.params,
  };

  if (options.json) {
    const output = await harness.runToCompletion(input);
    for (const event of output.events) {
      await telemetry.emit(event);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  for await (const event of harness.run(input)) {
    await telemetry.emit(event);
    if (event.type === "model:chunk") {
      process.stdout.write(event.content);
    }
    if (event.type === "run:error") {
      process.stderr.write(`\nError: ${event.error.message}\n`);
    }
    if (event.type === "run:completed") {
      process.stdout.write("\n");
    }
  }
};

export const runInteractive = async (
  workingDir: string,
  params: Record<string, string>,
): Promise<void> => {
  dotenv.config({ path: resolve(workingDir, ".env") });

  // Approval bridge: the harness calls this handler which creates a pending
  // promise. The Ink UI picks up the pending request and shows a Y/N prompt.
  // The user's response resolves the promise.
  type ApprovalRequest = {
    tool: string;
    input: Record<string, unknown>;
    approvalId: string;
    resolve: (approved: boolean) => void;
  };
  let pendingApproval: ApprovalRequest | null = null;
  let onApprovalRequest: ((req: ApprovalRequest) => void) | null = null;

  const approvalHandler = async (request: {
    tool: string;
    input: Record<string, unknown>;
    runId: string;
    step: number;
    approvalId: string;
  }): Promise<boolean> => {
    return new Promise<boolean>((resolveApproval) => {
      const req: ApprovalRequest = {
        tool: request.tool,
        input: request.input,
        approvalId: request.approvalId,
        resolve: resolveApproval,
      };
      pendingApproval = req;
      if (onApprovalRequest) {
        onApprovalRequest(req);
      }
    });
  };

  const harness = new AgentHarness({
    workingDir,
    environment: resolveHarnessEnvironment(),
    approvalHandler,
  });
  await harness.initialize();
  try {
    const { runInteractiveInk } = await import("./run-interactive-ink.js");
    await runInteractiveInk({
      harness,
      params,
      workingDir,
      onSetApprovalCallback: (cb: (req: ApprovalRequest) => void) => {
        onApprovalRequest = cb;
        // If there's already a pending request, fire it immediately
        if (pendingApproval) {
          cb(pendingApproval);
        }
      },
    });
  } finally {
    await harness.shutdown();
  }
};

export const listTools = async (workingDir: string): Promise<void> => {
  dotenv.config({ path: resolve(workingDir, ".env") });
  const harness = new AgentHarness({ workingDir });
  await harness.initialize();
  const tools = harness.listTools();

  if (tools.length === 0) {
    process.stdout.write("No tools registered.\n");
    return;
  }

  process.stdout.write("Available tools:\n");
  for (const tool of tools) {
    process.stdout.write(`- ${tool.name}: ${tool.description}\n`);
  }
};

const runInstallCommand = async (
  workingDir: string,
  packageNameOrPath: string,
): Promise<void> =>
  await new Promise<void>((resolveInstall, rejectInstall) => {
    const child = spawn("pnpm", ["add", packageNameOrPath], {
      cwd: workingDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolveInstall();
        return;
      }
      rejectInstall(new Error(`pnpm add failed with exit code ${code ?? -1}`));
    });
  });

const validateSkillPackage = async (
  workingDir: string,
  packageNameOrPath: string,
): Promise<void> => {
  const packageJsonPath = packageNameOrPath.startsWith(".") || packageNameOrPath.startsWith("/")
    ? resolve(workingDir, packageNameOrPath, "package.json")
    : require.resolve(`${packageNameOrPath}/package.json`, {
        paths: [workingDir],
      });
  const skillRoot = resolve(packageJsonPath, "..");
  const skillManifest = resolve(skillRoot, "SKILL.md");
  try {
    await access(skillManifest);
  } catch {
    throw new Error(`Skill validation failed: missing SKILL.md in ${skillRoot}`);
  }
};

export const addSkill = async (workingDir: string, packageNameOrPath: string): Promise<void> => {
  await runInstallCommand(workingDir, packageNameOrPath);
  await validateSkillPackage(workingDir, packageNameOrPath);
  process.stdout.write(`Added skill: ${packageNameOrPath}\n`);
};

export const runTests = async (
  workingDir: string,
  filePath?: string,
): Promise<{ passed: number; failed: number }> => {
  dotenv.config({ path: resolve(workingDir, ".env") });
  const testFilePath = filePath ?? resolve(workingDir, "tests", "basic.yaml");
  const content = await readFile(testFilePath, "utf8");
  const parsed = YAML.parse(content) as {
    tests?: Array<{
      name: string;
      task: string;
      expect?: {
        contains?: string;
        refusal?: boolean;
        toolCalled?: string;
        maxSteps?: number;
        maxTokens?: number;
      };
    }>;
  };
  const tests = parsed.tests ?? [];

  const harness = new AgentHarness({ workingDir });
  await harness.initialize();

  let passed = 0;
  let failed = 0;

  for (const testCase of tests) {
    try {
      const output = await harness.runToCompletion({ task: testCase.task });
      const response = output.result.response ?? "";
      const events = output.events;
      const expectation = testCase.expect ?? {};
      const checks: boolean[] = [];

      if (expectation.contains) {
        checks.push(response.includes(expectation.contains));
      }
      if (typeof expectation.maxSteps === "number") {
        checks.push(output.result.steps <= expectation.maxSteps);
      }
      if (typeof expectation.maxTokens === "number") {
        checks.push(
          output.result.tokens.input + output.result.tokens.output <= expectation.maxTokens,
        );
      }
      if (expectation.refusal) {
        checks.push(
          response.toLowerCase().includes("can't") || response.toLowerCase().includes("cannot"),
        );
      }
      if (expectation.toolCalled) {
        checks.push(
          events.some(
            (event) => event.type === "tool:started" && event.tool === expectation.toolCalled,
          ),
        );
      }

      const ok = checks.length === 0 ? output.result.status === "completed" : checks.every(Boolean);
      if (ok) {
        passed += 1;
        process.stdout.write(`PASS ${testCase.name}\n`);
      } else {
        failed += 1;
        process.stdout.write(`FAIL ${testCase.name}\n`);
      }
    } catch (error) {
      failed += 1;
      process.stdout.write(
        `FAIL ${testCase.name} (${error instanceof Error ? error.message : "Unknown test error"})\n`,
      );
    }
  }

  process.stdout.write(`\nTest summary: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
};

export const buildTarget = async (workingDir: string, target: string): Promise<void> => {
  const outDir = resolve(workingDir, ".agentl-build", target);
  await mkdir(outDir, { recursive: true });
  const serverEntrypoint = `import { startDevServer } from "agentl";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
await startDevServer(Number.isNaN(port) ? 3000 : port, { workingDir: process.cwd() });
`;
  const runtimePackageJson = JSON.stringify(
    {
      name: "agentl-runtime-bundle",
      private: true,
      type: "module",
      scripts: {
        start: "node server.js",
      },
      dependencies: {
        agentl: "^0.1.0",
      },
    },
    null,
    2,
  );

  if (target === "vercel") {
    await mkdir(resolve(outDir, "api"), { recursive: true });
    await copyIfExists(resolve(workingDir, "AGENT.md"), resolve(outDir, "AGENT.md"));
    await copyIfExists(
      resolve(workingDir, "agentl.config.js"),
      resolve(outDir, "agentl.config.js"),
    );
    await copyIfExists(resolve(workingDir, "skills"), resolve(outDir, "skills"));
    await copyIfExists(resolve(workingDir, "tests"), resolve(outDir, "tests"));
    await writeFile(
      resolve(outDir, "vercel.json"),
      JSON.stringify(
        {
          version: 2,
          builds: [
            {
              src: "api/index.js",
              use: "@vercel/node@3.2.24",
              config: {
                includeFiles: [
                  "AGENT.md",
                  "agentl.config.js",
                  "skills/**",
                  "tests/**",
                ],
              },
            },
          ],
          routes: [{ src: "/(.*)", dest: "/api/index.js" }],
        },
        null,
        2,
      ),
      "utf8",
    );
    await buildVercelHandlerBundle(outDir);
    await writeFile(
      resolve(outDir, "package.json"),
      JSON.stringify(
        {
          private: true,
          type: "module",
          engines: {
            node: "20.x",
          },
          dependencies: VERCEL_RUNTIME_DEPENDENCIES,
        },
        null,
        2,
      ),
      "utf8",
    );
  } else if (target === "docker") {
    await writeFile(
      resolve(outDir, "Dockerfile"),
      `FROM node:20-slim
WORKDIR /app
COPY package.json package.json
COPY AGENT.md AGENT.md
COPY agentl.config.js agentl.config.js
COPY skills skills
COPY tests tests
COPY .env.example .env.example
RUN corepack enable && npm install -g agentl
COPY server.js server.js
EXPOSE 3000
CMD ["node","server.js"]
`,
      "utf8",
    );
    await writeFile(resolve(outDir, "server.js"), serverEntrypoint, "utf8");
    await writeFile(resolve(outDir, "package.json"), runtimePackageJson, "utf8");
  } else if (target === "lambda") {
    await writeFile(
      resolve(outDir, "lambda-handler.js"),
      `import { startDevServer } from "agentl";
let serverPromise;
export const handler = async (event = {}) => {
  if (!serverPromise) {
    serverPromise = startDevServer(0, { workingDir: process.cwd() });
  }
  const body = JSON.stringify({
    status: "ready",
    route: event.rawPath ?? event.path ?? "/",
  });
  return { statusCode: 200, headers: { "content-type": "application/json" }, body };
};
`,
      "utf8",
    );
    await writeFile(resolve(outDir, "package.json"), runtimePackageJson, "utf8");
  } else if (target === "fly") {
    await writeFile(
      resolve(outDir, "fly.toml"),
      `app = "agentl-app"
[env]
  PORT = "3000"
[http_service]
  internal_port = 3000
  force_https = true
  auto_start_machines = true
  auto_stop_machines = "stop"
  min_machines_running = 0
`,
      "utf8",
    );
    await writeFile(
      resolve(outDir, "Dockerfile"),
      `FROM node:20-slim
WORKDIR /app
COPY package.json package.json
COPY AGENT.md AGENT.md
COPY agentl.config.js agentl.config.js
COPY skills skills
COPY tests tests
RUN npm install -g agentl
COPY server.js server.js
EXPOSE 3000
CMD ["node","server.js"]
`,
      "utf8",
    );
    await writeFile(resolve(outDir, "server.js"), serverEntrypoint, "utf8");
    await writeFile(resolve(outDir, "package.json"), runtimePackageJson, "utf8");
  } else {
    throw new Error(`Unsupported build target: ${target}`);
  }

  process.stdout.write(`Build artifacts generated at ${outDir}\n`);
};

const normalizeMcpName = (entry: { url?: string; name?: string }): string =>
  entry.name ?? entry.url ?? `mcp_${Date.now()}`;

export const mcpAdd = async (
  workingDir: string,
  options: {
    url?: string;
    name?: string;
    envVars?: string[];
  },
): Promise<void> => {
  const config = (await loadAgentlConfig(workingDir)) ?? { mcp: [] };
  const mcp = [...(config.mcp ?? [])];
  if (!options.url) {
    throw new Error("Remote MCP only: provide --url for a remote MCP server.");
  }
  mcp.push({
    name: options.name ?? normalizeMcpName({ url: options.url }),
    url: options.url,
    env: options.envVars ?? [],
  });

  await writeConfigFile(workingDir, { ...config, mcp });
  process.stdout.write("MCP server added.\n");
};

export const mcpList = async (workingDir: string): Promise<void> => {
  const config = await loadAgentlConfig(workingDir);
  const mcp = config?.mcp ?? [];
  if (mcp.length === 0) {
    process.stdout.write("No MCP servers configured.\n");
    return;
  }
  process.stdout.write("Configured MCP servers:\n");
  for (const entry of mcp) {
    process.stdout.write(`- ${entry.name ?? entry.url} (remote: ${entry.url})\n`);
  }
};

export const mcpRemove = async (workingDir: string, name: string): Promise<void> => {
  const config = (await loadAgentlConfig(workingDir)) ?? { mcp: [] };
  const before = config.mcp ?? [];
  const filtered = before.filter((entry) => normalizeMcpName(entry) !== name);
  await writeConfigFile(workingDir, { ...config, mcp: filtered });
  process.stdout.write(`Removed MCP server: ${name}\n`);
};

export const buildCli = (): Command => {
  const program = new Command();
  program
    .name("agentl")
    .description("CLI for building and running AgentL agents")
    .version("0.1.0");

  program
    .command("init")
    .argument("<name>", "project name")
    .description("Scaffold a new AgentL project")
    .action(async (name: string) => {
      await initProject(name);
    });

  program
    .command("dev")
    .description("Run local development server")
    .option("--port <port>", "server port", "3000")
    .action(async (options: { port: string }) => {
      const port = Number.parseInt(options.port, 10);
      await startDevServer(Number.isNaN(port) ? 3000 : port);
    });

  program
    .command("run")
    .argument("[task]", "task to run")
    .description("Execute the agent once")
    .option("--param <keyValue>", "parameter key=value", (value, all: string[]) => {
      all.push(value);
      return all;
    }, [] as string[])
    .option("--file <path>", "include file contents", (value, all: string[]) => {
      all.push(value);
      return all;
    }, [] as string[])
    .option("--json", "output json", false)
    .option("--interactive", "run in interactive mode", false)
    .action(
      async (
        task: string | undefined,
        options: { param: string[]; file: string[]; json: boolean; interactive: boolean },
      ) => {
        const params = parseParams(options.param);
        if (options.interactive) {
          await runInteractive(process.cwd(), params);
          return;
        }
        if (!task) {
          throw new Error("Task is required unless --interactive is used.");
        }
        await runOnce(task, {
          params,
          json: options.json,
          filePaths: options.file,
        });
      },
    );

  program
    .command("tools")
    .description("List all tools available to the agent")
    .action(async () => {
      await listTools(process.cwd());
    });

  program
    .command("add")
    .argument("<packageOrPath>", "skill package name/path")
    .description("Add a skill package and validate SKILL.md")
    .action(async (packageOrPath: string) => {
      await addSkill(process.cwd(), packageOrPath);
    });

  program
    .command("update-agent")
    .description("Backfill latest default guidance into AGENT.md")
    .action(async () => {
      await updateAgentGuidance(process.cwd());
    });

  program
    .command("test")
    .argument("[file]", "test file path (yaml)")
    .description("Run yaml-defined agent tests")
    .action(async (file?: string) => {
      const testFile = file ? resolve(process.cwd(), file) : undefined;
      const result = await runTests(process.cwd(), testFile);
      if (result.failed > 0) {
        process.exitCode = 1;
      }
    });

  program
    .command("build")
    .argument("<target>", "vercel|docker|lambda|fly")
    .description("Generate build artifacts for deployment target")
    .action(async (target: string) => {
      await buildTarget(process.cwd(), target);
    });

  const mcpCommand = program.command("mcp").description("Manage MCP servers");
  mcpCommand
    .command("add")
    .requiredOption("--url <url>", "remote MCP url")
    .option("--name <name>", "server name")
    .option("--env <name>", "env variable (repeatable)", (value, all: string[]) => {
      all.push(value);
      return all;
    }, [] as string[])
    .action(
      async (
        options: {
          url?: string;
          name?: string;
          env: string[];
        },
      ) => {
        await mcpAdd(process.cwd(), {
          url: options.url,
          name: options.name,
          envVars: options.env,
        });
      },
    );

  mcpCommand
    .command("list")
    .description("List configured MCP servers")
    .action(async () => {
      await mcpList(process.cwd());
    });

  mcpCommand
    .command("remove")
    .argument("<name>", "server name")
    .description("Remove an MCP server by name")
    .action(async (name: string) => {
      await mcpRemove(process.cwd(), name);
    });

  return program;
};

export const main = async (argv: string[] = process.argv): Promise<void> => {
  try {
    await buildCli().parseAsync(argv);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "EADDRINUSE"
    ) {
      const message = "Port is already in use. Try `agentl dev --port 3001` or stop the process using port 3000.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : "Unknown CLI error"}\n`);
    process.exitCode = 1;
  }
};

export const packageRoot = resolve(__dirname, "..");
