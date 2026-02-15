import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  AgentHarness,
  LocalMcpBridge,
  TelemetryEmitter,
  createConversationStore,
  loadPonchoConfig,
  resolveStateConfig,
  type PonchoConfig,
  type ConversationStore,
} from "@poncho-ai/harness";
import type { AgentEvent, Message, RunInput } from "@poncho-ai/sdk";
import { Command } from "commander";
import dotenv from "dotenv";
import YAML from "yaml";
import {
  LoginRateLimiter,
  SessionStore,
  getRequestIp,
  inferConversationTitle,
  parseCookies,
  renderIconSvg,
  renderManifest,
  renderServiceWorker,
  renderWebUiHtml,
  setCookie,
  verifyPassphrase,
} from "./web-ui.js";
import { createInterface } from "node:readline/promises";
import {
  runInitOnboarding,
  type InitOnboardingOptions,
} from "./init-onboarding.js";
import {
  consumeFirstRunIntro,
  initializeOnboardingMarker,
} from "./init-feature-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const writeJson = (response: ServerResponse, statusCode: number, payload: unknown) => {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
};

const writeHtml = (response: ServerResponse, statusCode: number, payload: string) => {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(payload);
};

const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.length > 0 ? (JSON.parse(body) as unknown) : {};
};

/**
 * Detects the runtime environment from platform-specific or standard environment variables.
 * Priority: PONCHO_ENV > platform detection (Vercel, Railway, etc.) > NODE_ENV > "development"
 */
export const resolveHarnessEnvironment = (): "development" | "staging" | "production" => {
  // Check explicit Poncho environment variable first
  if (process.env.PONCHO_ENV) {
    const value = process.env.PONCHO_ENV.toLowerCase();
    if (value === "production" || value === "staging") {
      return value;
    }
    return "development";
  }

  // Detect platform-specific environment variables
  // Vercel
  if (process.env.VERCEL_ENV) {
    const vercelEnv = process.env.VERCEL_ENV.toLowerCase();
    if (vercelEnv === "production") return "production";
    if (vercelEnv === "preview") return "staging";
    return "development";
  }

  // Railway
  if (process.env.RAILWAY_ENVIRONMENT) {
    const railwayEnv = process.env.RAILWAY_ENVIRONMENT.toLowerCase();
    if (railwayEnv === "production") return "production";
    return "staging";
  }

  // Render
  if (process.env.RENDER) {
    // Render sets IS_PULL_REQUEST for preview deploys
    if (process.env.IS_PULL_REQUEST === "true") return "staging";
    return "production";
  }

  // AWS Lambda
  if (process.env.AWS_EXECUTION_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return "production";
  }

  // Fly.io
  if (process.env.FLY_APP_NAME) {
    return "production";
  }

  // Fall back to NODE_ENV
  if (process.env.NODE_ENV) {
    const value = process.env.NODE_ENV.toLowerCase();
    if (value === "production" || value === "staging") {
      return value;
    }
    return "development";
  }

  // Default to development
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
        const address = server.address();
        if (address && typeof address === "object" && typeof address.port === "number") {
          resolveListen(address.port);
          return;
        }
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

const AGENT_TEMPLATE = (
  name: string,
  options: { modelProvider: "anthropic" | "openai"; modelName: string },
): string => `---
name: ${name}
description: A helpful Poncho assistant
model:
  provider: ${options.modelProvider}
  name: ${options.modelName}
  temperature: 0.2
limits:
  maxSteps: 50
  timeout: 300
---

# {{name}}

You are **{{name}}**, a helpful assistant built with Poncho.

Working directory: {{runtime.workingDir}}
Environment: {{runtime.environment}}

## Task Guidance

- Use tools when needed
- Explain your reasoning clearly
- Ask clarifying questions when requirements are ambiguous
- Never claim a file/tool change unless the corresponding tool call actually succeeded
`;

/**
 * Resolve the monorepo packages root if we're running from a local dev build.
 * Returns the absolute path to the `packages/` directory, or null when
 * running from an npm-installed copy.
 */
const resolveLocalPackagesRoot = (): string | null => {
  // __dirname is packages/cli/dist — the monorepo root is three levels up
  const candidate = resolve(__dirname, "..", "..", "harness", "package.json");
  if (existsSync(candidate)) {
    return resolve(__dirname, "..", "..");
  }
  return null;
};

/**
 * Build dependency specifiers for the scaffolded project.
 * In dev mode we use `file:` paths so pnpm can resolve local packages;
 * in production we point at the npm registry.
 */
const resolveCoreDeps = (
  projectDir: string,
): { harness: string; sdk: string } => {
  const packagesRoot = resolveLocalPackagesRoot();
  if (packagesRoot) {
    const harnessAbs = resolve(packagesRoot, "harness");
    const sdkAbs = resolve(packagesRoot, "sdk");
    return {
      harness: `link:${relative(projectDir, harnessAbs)}`,
      sdk: `link:${relative(projectDir, sdkAbs)}`,
    };
  }
  return { harness: "^0.1.0", sdk: "^0.1.0" };
};

const PACKAGE_TEMPLATE = (name: string, projectDir: string): string => {
  const deps = resolveCoreDeps(projectDir);
  return JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      dependencies: {
        "@poncho-ai/harness": deps.harness,
        "@poncho-ai/sdk": deps.sdk,
      },
    },
    null,
    2,
  );
};

const README_TEMPLATE = (name: string): string => `# ${name}

An AI agent built with [Poncho](https://github.com/cesr/poncho-ai).

## Prerequisites

- Node.js 20+
- npm (or pnpm/yarn)
- Anthropic or OpenAI API key

## Quick Start

\`\`\`bash
npm install
# If you didn't enter an API key during init:
cp .env.example .env
# Then edit .env and add your API key
poncho dev
\`\`\`

Open \`http://localhost:3000\` for the web UI.

On your first interactive session, the agent introduces its configurable capabilities.

## Common Commands

\`\`\`bash
# Local web UI + API server
poncho dev

# Local interactive CLI
poncho run --interactive

# One-off run
poncho run "Your task here"

# Run tests
poncho test

# List available tools
poncho tools
\`\`\`

## Add Skills

Install skills from a local path or remote repository, then verify discovery:

\`\`\`bash
# Install skills into ./skills
poncho add <repo-or-path>

# Verify loaded tools
poncho tools
\`\`\`

After adding skills, run \`poncho dev\` or \`poncho run --interactive\` and ask the agent to use them.

## Configure MCP Servers (Remote)

Connect remote MCP servers and expose their tools to the agent:

\`\`\`bash
# Add remote MCP server
poncho mcp add --url https://mcp.example.com/github --name github --auth-bearer-env GITHUB_TOKEN

# List configured servers
poncho mcp list

# Discover and select MCP tools into config allowlist
poncho mcp tools list github
poncho mcp tools select github

# Remove a server
poncho mcp remove github
\`\`\`

Set required secrets in \`.env\` (for example, \`GITHUB_TOKEN=...\`).

## Tool Intent in Frontmatter

Declare tool intent directly in \`AGENT.md\` and \`SKILL.md\` frontmatter:

\`\`\`yaml
tools:
  mcp:
    - github/list_issues
    - github/*
  scripts:
    - starter/scripts/*
\`\`\`

How it works:

- \`AGENT.md\` provides fallback MCP intent when no skill is active.
- \`SKILL.md\` intent applies when you activate that skill (\`activate_skill\`).
- Skill scripts are accessible by default from each skill's \`scripts/\` directory.
- \`AGENT.md\` \`tools.scripts\` can still be used to narrow script access when active skills do not set script intent.
- Active skills are unioned, then filtered by policy in \`poncho.config.js\`.
- Deactivating a skill (\`deactivate_skill\`) removes its MCP tools from runtime registration.

Pattern format is strict slash-only:

- MCP: \`server/tool\`, \`server/*\`
- Scripts: \`skill/scripts/file.ts\`, \`skill/scripts/*\`

## Configuration

Core files:

- \`AGENT.md\`: behavior, model selection, runtime guidance
- \`poncho.config.js\`: runtime config (storage, auth, telemetry, MCP, tools)
- \`.env\`: secrets and environment variables

Example \`poncho.config.js\`:

\`\`\`javascript
export default {
  storage: {
    provider: "local", // local | memory | redis | upstash | dynamodb
    memory: {
      enabled: true,
      maxRecallConversations: 20,
    },
  },
  auth: {
    required: false,
  },
  telemetry: {
    enabled: true,
  },
  mcp: [
    {
      name: "github",
      url: "https://mcp.example.com/github",
      auth: { type: "bearer", tokenEnv: "GITHUB_TOKEN" },
      tools: {
        mode: "allowlist",
        include: ["github/list_issues", "github/get_issue"],
      },
    },
  ],
  scripts: {
    mode: "allowlist",
    include: ["starter/scripts/*"],
  },
  tools: {
    defaults: {
      list_directory: true,
      read_file: true,
      write_file: true, // still gated by environment/policy
    },
    byEnvironment: {
      production: {
        read_file: false, // example override
      },
    },
  },
};
\`\`\`

## Project Structure

\`\`\`
${name}/
├── AGENT.md           # Agent definition and system prompt
├── poncho.config.js   # Configuration (MCP servers, auth, etc.)
├── package.json       # Dependencies
├── .env.example       # Environment variables template
├── tests/
│   └── basic.yaml     # Test suite
└── skills/
    └── starter/
        ├── SKILL.md
        └── scripts/
            └── starter-echo.ts
\`\`\`

## Deployment

\`\`\`bash
# Build for Vercel
poncho build vercel
cd .poncho-build/vercel && vercel deploy --prod

# Build for Docker
poncho build docker
docker build -t ${name} .
\`\`\`

For full reference:
https://github.com/cesr/poncho-ai
`;

const ENV_TEMPLATE = "ANTHROPIC_API_KEY=sk-ant-...\n";
const GITIGNORE_TEMPLATE =
  ".env\nnode_modules\ndist\n.poncho-build\n.poncho/\ninteractive-session.json\n";
const VERCEL_RUNTIME_DEPENDENCIES: Record<string, string> = {
  "@anthropic-ai/sdk": "^0.74.0",
  "@aws-sdk/client-dynamodb": "^3.988.0",
  "@latitude-data/telemetry": "^2.0.2",
  commander: "^12.0.0",
  dotenv: "^16.4.0",
  jiti: "^2.6.1",
  mustache: "^4.2.0",
  openai: "^6.3.0",
  redis: "^5.10.0",
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
description: Starter local skill template
---

# Starter Skill

This is a starter local skill created by \`poncho init\`.

## Authoring Notes

- Put executable JavaScript/TypeScript files in \`scripts/\`.
- Ask the agent to call \`run_skill_script\` with \`skill\`, \`script\`, and optional \`input\`.
`;

const SKILL_TOOL_TEMPLATE = `export default async function run(input) {
  const message = typeof input?.message === "string" ? input.message : "";
  return { echoed: message };
}
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
    `import { createRequestHandler } from ${JSON.stringify(cliEntrypoint)};
let handlerPromise;
export default async function handler(req, res) {
  try {
    if (!handlerPromise) {
      handlerPromise = createRequestHandler({ workingDir: process.cwd() });
    }
    const requestHandler = await handlerPromise;
    await requestHandler(req, res);
  } catch (error) {
    console.error("Handler error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error", message: error?.message || "Unknown error" }));
    }
  }
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

const renderConfigFile = (config: PonchoConfig): string =>
  `export default ${JSON.stringify(config, null, 2)}\n`;

const writeConfigFile = async (workingDir: string, config: PonchoConfig): Promise<void> => {
  const serialized = renderConfigFile(config);
  await writeFile(resolve(workingDir, "poncho.config.js"), serialized, "utf8");
};

const ensureEnvPlaceholder = async (filePath: string, key: string): Promise<boolean> => {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return false;
  }
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    await writeFile(filePath, `${normalizedKey}=\n`, "utf8");
    return true;
  }
  const present = content
    .split(/\r?\n/)
    .some((line) => line.trimStart().startsWith(`${normalizedKey}=`));
  if (present) {
    return false;
  }
  const withTrailingNewline = content.length === 0 || content.endsWith("\n")
    ? content
    : `${content}\n`;
  await writeFile(filePath, `${withTrailingNewline}${normalizedKey}=\n`, "utf8");
  return true;
};

const removeEnvPlaceholder = async (filePath: string, key: string): Promise<boolean> => {
  const normalizedKey = key.trim();
  if (!normalizedKey) {
    return false;
  }
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return false;
  }
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter((line) => !line.trimStart().startsWith(`${normalizedKey}=`));
  if (filtered.length === lines.length) {
    return false;
  }
  const nextContent = filtered.join("\n").replace(/\n+$/, "");
  await writeFile(filePath, nextContent.length > 0 ? `${nextContent}\n` : "", "utf8");
  return true;
};

const gitInit = (cwd: string): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn("git", ["init"], { cwd, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

export const initProject = async (
  projectName: string,
  options?: {
    workingDir?: string;
    onboarding?: InitOnboardingOptions;
    envExampleOverride?: string;
  },
): Promise<void> => {
  const baseDir = options?.workingDir ?? process.cwd();
  const projectDir = resolve(baseDir, projectName);
  await mkdir(projectDir, { recursive: true });

  const onboardingOptions: InitOnboardingOptions = options?.onboarding ?? {
    yes: true,
    interactive: false,
  };
  const onboarding = await runInitOnboarding(onboardingOptions);

  const G = "\x1b[32m";
  const D = "\x1b[2m";
  const B = "\x1b[1m";
  const CY = "\x1b[36m";
  const YW = "\x1b[33m";
  const R = "\x1b[0m";

  process.stdout.write("\n");

  const scaffoldFiles: Array<{ path: string; content: string }> = [
    { path: "AGENT.md", content: AGENT_TEMPLATE(projectName, { modelProvider: onboarding.agentModel.provider, modelName: onboarding.agentModel.name }) },
    { path: "poncho.config.js", content: renderConfigFile(onboarding.config) },
    { path: "package.json", content: PACKAGE_TEMPLATE(projectName, projectDir) },
    { path: "README.md", content: README_TEMPLATE(projectName) },
    { path: ".env.example", content: options?.envExampleOverride ?? onboarding.envExample ?? ENV_TEMPLATE },
    { path: ".gitignore", content: GITIGNORE_TEMPLATE },
    { path: "tests/basic.yaml", content: TEST_TEMPLATE },
    { path: "skills/starter/SKILL.md", content: SKILL_TEMPLATE },
    { path: "skills/starter/scripts/starter-echo.ts", content: SKILL_TOOL_TEMPLATE },
  ];
  if (onboarding.envFile) {
    scaffoldFiles.push({ path: ".env", content: onboarding.envFile });
  }

  for (const file of scaffoldFiles) {
    await ensureFile(resolve(projectDir, file.path), file.content);
    process.stdout.write(`  ${D}+${R} ${D}${file.path}${R}\n`);
  }

  await initializeOnboardingMarker(projectDir, {
    allowIntro: !(onboardingOptions.yes ?? false),
  });

  process.stdout.write("\n");

  // Install dependencies so subsequent commands (e.g. `poncho add`) succeed.
  try {
    await runPnpmInstall(projectDir);
    process.stdout.write(`  ${G}✓${R} ${D}Installed dependencies${R}\n`);
  } catch {
    process.stdout.write(
      `  ${YW}!${R} Could not install dependencies — run ${D}pnpm install${R} manually\n`,
    );
  }

  const gitOk = await gitInit(projectDir);
  if (gitOk) {
    process.stdout.write(`  ${G}✓${R} ${D}Initialized git${R}\n`);
  }

  process.stdout.write(`  ${G}✓${R} ${B}${projectName}${R} is ready\n`);
  process.stdout.write("\n");
  process.stdout.write(`  ${B}Get started${R}\n`);
  process.stdout.write("\n");
  process.stdout.write(`    ${D}$${R} cd ${projectName}\n`);
  process.stdout.write("\n");
  process.stdout.write(`    ${CY}Web UI${R}          ${D}$${R} poncho dev\n`);
  process.stdout.write(`    ${CY}CLI interactive${R}  ${D}$${R} poncho run --interactive\n`);
  process.stdout.write("\n");
  if (onboarding.envNeedsUserInput) {
    process.stdout.write(
      `  ${YW}!${R} Make sure you add your keys to the ${B}.env${R} file.\n`,
    );
  }
  process.stdout.write(`  ${D}The agent will introduce itself on your first session.${R}\n`);
  process.stdout.write("\n");
};

export const updateAgentGuidance = async (workingDir: string): Promise<boolean> => {
  const agentPath = resolve(workingDir, "AGENT.md");
  const content = await readFile(agentPath, "utf8");
  const guidanceSectionPattern =
    /\n## Configuration Assistant Context[\s\S]*?(?=\n## |\n# |$)|\n## Skill Authoring Guidance[\s\S]*?(?=\n## |\n# |$)/g;
  const normalized = content.replace(/\s+$/g, "");
  const updated = normalized.replace(guidanceSectionPattern, "").replace(/\n{3,}/g, "\n\n");
  if (updated === normalized) {
    process.stdout.write("AGENT.md does not contain deprecated embedded local guidance.\n");
    return false;
  }
  await writeFile(agentPath, `${updated}\n`, "utf8");
  process.stdout.write("Removed deprecated embedded local guidance from AGENT.md.\n");
  return true;
};

const formatSseEvent = (event: AgentEvent): string =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

export type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

export const createRequestHandler = async (options?: {
  workingDir?: string;
}): Promise<RequestHandler> => {
  const workingDir = options?.workingDir ?? process.cwd();
  dotenv.config({ path: resolve(workingDir, ".env") });
  const config = await loadPonchoConfig(workingDir);
  let agentName = "Agent";
  let agentModelProvider = "anthropic";
  let agentModelName = "claude-opus-4-5";
  try {
    const agentMd = await readFile(resolve(workingDir, "AGENT.md"), "utf8");
    const nameMatch = agentMd.match(/^name:\s*(.+)$/m);
    const providerMatch = agentMd.match(/^\s{2}provider:\s*(.+)$/m);
    const modelMatch = agentMd.match(/^\s{2}name:\s*(.+)$/m);
    if (nameMatch?.[1]) {
      agentName = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    if (providerMatch?.[1]) {
      agentModelProvider = providerMatch[1].trim().replace(/^["']|["']$/g, "");
    }
    if (modelMatch?.[1]) {
      agentModelName = modelMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  const harness = new AgentHarness({ workingDir });
  await harness.initialize();
  const telemetry = new TelemetryEmitter(config?.telemetry);
  const conversationStore = createConversationStore(resolveStateConfig(config), { workingDir });
  const sessionStore = new SessionStore();
  const loginRateLimiter = new LoginRateLimiter();
  const passphrase = process.env.AGENT_UI_PASSPHRASE ?? "";
  const isProduction = resolveHarnessEnvironment() === "production";
  const requireUiAuth = passphrase.length > 0;
  const secureCookies = isProduction;

  return async (request: IncomingMessage, response: ServerResponse) => {
    if (!request.url || !request.method) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }
    const [pathname] = request.url.split("?");

    if (request.method === "GET" && (pathname === "/" || pathname.startsWith("/c/"))) {
      writeHtml(response, 200, renderWebUiHtml({ agentName }));
      return;
    }

    if (pathname === "/manifest.json" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/manifest+json" });
      response.end(renderManifest({ agentName }));
      return;
    }

    if (pathname === "/sw.js" && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": "application/javascript",
        "Service-Worker-Allowed": "/",
      });
      response.end(renderServiceWorker());
      return;
    }

    if (pathname === "/icon.svg" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "image/svg+xml" });
      response.end(renderIconSvg({ agentName }));
      return;
    }

    if ((pathname === "/icon-192.png" || pathname === "/icon-512.png") && request.method === "GET") {
      // Redirect to SVG — browsers that support PWA icons will use the SVG
      response.writeHead(302, { Location: "/icon.svg" });
      response.end();
      return;
    }

    if (pathname === "/health" && request.method === "GET") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    const cookies = parseCookies(request);
    const sessionId = cookies.poncho_session;
    const session = sessionId ? sessionStore.get(sessionId) : undefined;
    const ownerId = session?.ownerId ?? "local-owner";
    const requiresCsrfValidation =
      request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";

    if (pathname === "/api/auth/session" && request.method === "GET") {
      if (!requireUiAuth) {
        writeJson(response, 200, { authenticated: true, csrfToken: "" });
        return;
      }
      if (!session) {
        writeJson(response, 200, { authenticated: false });
        return;
      }
      writeJson(response, 200, {
        authenticated: true,
        sessionId: session.sessionId,
        ownerId: session.ownerId,
        csrfToken: session.csrfToken,
      });
      return;
    }

    if (pathname === "/api/auth/login" && request.method === "POST") {
      if (!requireUiAuth) {
        writeJson(response, 200, { authenticated: true, csrfToken: "" });
        return;
      }
      const ip = getRequestIp(request);
      const canAttempt = loginRateLimiter.canAttempt(ip);
      if (!canAttempt.allowed) {
        writeJson(response, 429, {
          code: "AUTH_RATE_LIMIT",
          message: "Too many failed login attempts. Try again later.",
          retryAfterSeconds: canAttempt.retryAfterSeconds,
        });
        return;
      }
      const body = (await readRequestBody(request)) as { passphrase?: string };
      const provided = body.passphrase ?? "";
      if (!verifyPassphrase(provided, passphrase)) {
        const failure = loginRateLimiter.registerFailure(ip);
        writeJson(response, 401, {
          code: "AUTH_ERROR",
          message: "Invalid passphrase",
          retryAfterSeconds: failure.retryAfterSeconds,
        });
        return;
      }
      loginRateLimiter.registerSuccess(ip);
      const createdSession = sessionStore.create(ownerId);
      setCookie(response, "poncho_session", createdSession.sessionId, {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 8,
      });
      writeJson(response, 200, {
        authenticated: true,
        csrfToken: createdSession.csrfToken,
      });
      return;
    }

    if (pathname === "/api/auth/logout" && request.method === "POST") {
      if (session?.sessionId) {
        sessionStore.delete(session.sessionId);
      }
      setCookie(response, "poncho_session", "", {
        httpOnly: true,
        secure: secureCookies,
        sameSite: "Lax",
        path: "/",
        maxAge: 0,
      });
      writeJson(response, 200, { ok: true });
      return;
    }

    if (pathname.startsWith("/api/")) {
      if (requireUiAuth && !session) {
        writeJson(response, 401, {
          code: "AUTH_ERROR",
          message: "Authentication required",
        });
        return;
      }
      if (
        requireUiAuth &&
        requiresCsrfValidation &&
        pathname !== "/api/auth/login" &&
        request.headers["x-csrf-token"] !== session?.csrfToken
      ) {
        writeJson(response, 403, {
          code: "CSRF_ERROR",
          message: "Invalid CSRF token",
        });
        return;
      }
    }

    if (pathname === "/api/conversations" && request.method === "GET") {
      const conversations = await conversationStore.list(ownerId);
      writeJson(response, 200, {
        conversations: conversations.map((conversation) => ({
          conversationId: conversation.conversationId,
          title: conversation.title,
          runtimeRunId: conversation.runtimeRunId,
          ownerId: conversation.ownerId,
          tenantId: conversation.tenantId,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          messageCount: conversation.messages.length,
        })),
      });
      return;
    }

    if (pathname === "/api/conversations" && request.method === "POST") {
      const body = (await readRequestBody(request)) as { title?: string };
      const conversation = await conversationStore.create(ownerId, body.title);
      const introMessage = await consumeFirstRunIntro(workingDir, {
        agentName,
        provider: agentModelProvider,
        model: agentModelName,
        config,
      });
      if (introMessage) {
        conversation.messages = [{ role: "assistant", content: introMessage }];
        await conversationStore.update(conversation);
      }
      writeJson(response, 201, { conversation });
      return;
    }

    const conversationPathMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (conversationPathMatch) {
      const conversationId = decodeURIComponent(conversationPathMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      if (request.method === "GET") {
        writeJson(response, 200, { conversation });
        return;
      }
      if (request.method === "PATCH") {
        const body = (await readRequestBody(request)) as { title?: string };
        if (!body.title || body.title.trim().length === 0) {
          writeJson(response, 400, {
            code: "VALIDATION_ERROR",
            message: "title is required",
          });
          return;
        }
        const updated = await conversationStore.rename(conversationId, body.title);
        writeJson(response, 200, { conversation: updated });
        return;
      }
      if (request.method === "DELETE") {
        await conversationStore.delete(conversationId);
        writeJson(response, 200, { ok: true });
        return;
      }
    }

    const conversationMessageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (conversationMessageMatch && request.method === "POST") {
      const conversationId = decodeURIComponent(conversationMessageMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      const body = (await readRequestBody(request)) as {
        message?: string;
        parameters?: Record<string, unknown>;
      };
      const messageText = body.message?.trim() ?? "";
      if (!messageText) {
        writeJson(response, 400, {
          code: "VALIDATION_ERROR",
          message: "message is required",
        });
        return;
      }
      if (
        conversation.messages.length === 0 &&
        (conversation.title === "New conversation" || conversation.title.trim().length === 0)
      ) {
        conversation.title = inferConversationTitle(messageText);
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      let latestRunId = conversation.runtimeRunId ?? "";
      let assistantResponse = "";
      const toolTimeline: string[] = [];
      try {
        const recallCorpus = (await conversationStore.list(ownerId))
          .filter((item) => item.conversationId !== conversationId)
          .slice(0, 20)
          .map((item) => ({
            conversationId: item.conversationId,
            title: item.title,
            updatedAt: item.updatedAt,
            content: item.messages
              .slice(-6)
              .map((message) => `${message.role}: ${message.content}`)
              .join("\n")
              .slice(0, 2000),
          }))
          .filter((item) => item.content.length > 0);

        for await (const event of harness.run({
          task: messageText,
          parameters: {
            ...(body.parameters ?? {}),
            __conversationRecallCorpus: recallCorpus,
            __activeConversationId: conversationId,
          },
          messages: conversation.messages,
        })) {
          if (event.type === "run:started") {
            latestRunId = event.runId;
          }
          if (event.type === "model:chunk") {
            assistantResponse += event.content;
          }
          if (event.type === "tool:started") {
            toolTimeline.push(`- start \`${event.tool}\``);
          }
          if (event.type === "tool:completed") {
            toolTimeline.push(`- done \`${event.tool}\` (${event.duration}ms)`);
          }
          if (event.type === "tool:error") {
            toolTimeline.push(`- error \`${event.tool}\`: ${event.error}`);
          }
          if (event.type === "tool:approval:required") {
            toolTimeline.push(`- approval required \`${event.tool}\``);
          }
          if (event.type === "tool:approval:granted") {
            toolTimeline.push(`- approval granted (${event.approvalId})`);
          }
          if (event.type === "tool:approval:denied") {
            toolTimeline.push(`- approval denied (${event.approvalId})`);
          }
          if (
            event.type === "run:completed" &&
            assistantResponse.length === 0 &&
            event.result.response
          ) {
            assistantResponse = event.result.response;
          }
          await telemetry.emit(event);
          response.write(formatSseEvent(event));
        }
        conversation.messages = [
          ...conversation.messages,
          { role: "user", content: messageText },
          {
            role: "assistant",
            content: assistantResponse,
            metadata:
              toolTimeline.length > 0
                ? ({ toolActivity: toolTimeline } as Message["metadata"])
                : undefined,
          },
        ];
        conversation.runtimeRunId = latestRunId || conversation.runtimeRunId;
        conversation.updatedAt = Date.now();
        await conversationStore.update(conversation);
      } catch (error) {
        response.write(
          formatSseEvent({
            type: "run:error",
            runId: latestRunId || "run_unknown",
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

    writeJson(response, 404, { error: "Not found" });
  };
};

export const startDevServer = async (
  port: number,
  options?: { workingDir?: string },
): Promise<Server> => {
  const handler = await createRequestHandler(options);
  const server = createServer(handler);
  const actualPort = await listenOnAvailablePort(server, port);
  if (actualPort !== port) {
    process.stdout.write(`Port ${port} is in use, switched to ${actualPort}.\n`);
  }
  process.stdout.write(`Poncho dev server running at http://localhost:${actualPort}\n`);

  const shutdown = () => {
    server.close();
    // Force-close any lingering connections so the port is freed immediately
    server.closeAllConnections?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
  const config = await loadPonchoConfig(workingDir);
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
  const config = await loadPonchoConfig(workingDir);

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
    await (
      runInteractiveInk as (input: {
        harness: AgentHarness;
        params: Record<string, string>;
        workingDir: string;
        config?: PonchoConfig;
        conversationStore: ConversationStore;
        onSetApprovalCallback?: (cb: (req: ApprovalRequest) => void) => void;
      }) => Promise<void>
    )({
      harness,
      params,
      workingDir,
      config,
      conversationStore: createConversationStore(resolveStateConfig(config), { workingDir }),
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

const runPnpmInstall = async (workingDir: string): Promise<void> =>
  await new Promise<void>((resolveInstall, rejectInstall) => {
    const child = spawn("pnpm", ["install"], {
      cwd: workingDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolveInstall();
        return;
      }
      rejectInstall(new Error(`pnpm install failed with exit code ${code ?? -1}`));
    });
  });

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

/**
 * Resolve the installed npm package name from a package specifier.
 * Handles local paths, scoped packages, and GitHub shorthand (e.g.
 * "vercel-labs/agent-skills" installs as "agent-skills").
 */
const resolveInstalledPackageName = (packageNameOrPath: string): string | null => {
  if (packageNameOrPath.startsWith(".") || packageNameOrPath.startsWith("/")) {
    return null; // local path — handled separately
  }
  // Scoped package: @scope/name
  if (packageNameOrPath.startsWith("@")) {
    return packageNameOrPath;
  }
  // GitHub shorthand: owner/repo — npm installs as the repo name
  if (packageNameOrPath.includes("/")) {
    return packageNameOrPath.split("/").pop() ?? packageNameOrPath;
  }
  return packageNameOrPath;
};

/**
 * Locate the root directory of an installed skill package.
 * Handles local paths, normal npm packages, and GitHub repos (which may
 * lack a root package.json).
 */
const resolveSkillRoot = (
  workingDir: string,
  packageNameOrPath: string,
): string => {
  // Local path
  if (packageNameOrPath.startsWith(".") || packageNameOrPath.startsWith("/")) {
    return resolve(workingDir, packageNameOrPath);
  }

  const moduleName =
    resolveInstalledPackageName(packageNameOrPath) ?? packageNameOrPath;

  // Try require.resolve first (works for packages with a package.json)
  try {
    const packageJsonPath = require.resolve(`${moduleName}/package.json`, {
      paths: [workingDir],
    });
    return resolve(packageJsonPath, "..");
  } catch {
    // Fall back to looking in node_modules directly (GitHub repos may lack
    // a root package.json)
    const candidate = resolve(workingDir, "node_modules", moduleName);
    if (existsSync(candidate)) {
      return candidate;
    }
    throw new Error(
      `Could not locate installed package "${moduleName}" in ${workingDir}`,
    );
  }
};

/**
 * Recursively check whether a directory (or any immediate sub-directory
 * tree) contains at least one SKILL.md file.
 */
const findSkillManifest = async (dir: string, depth = 2): Promise<boolean> => {
  try {
    await access(resolve(dir, "SKILL.md"));
    return true;
  } catch {
    // Not found at this level — look one level deeper (e.g. skills/<name>/SKILL.md)
  }
  if (depth <= 0) return false;
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        const found = await findSkillManifest(resolve(dir, entry.name), depth - 1);
        if (found) return true;
      }
    }
  } catch {
    // ignore read errors
  }
  return false;
};

const validateSkillPackage = async (
  workingDir: string,
  packageNameOrPath: string,
): Promise<void> => {
  const skillRoot = resolveSkillRoot(workingDir, packageNameOrPath);
  const hasSkill = await findSkillManifest(skillRoot);
  if (!hasSkill) {
    throw new Error(`Skill validation failed: no SKILL.md found in ${skillRoot}`);
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
  const outDir = resolve(workingDir, ".poncho-build", target);
  await mkdir(outDir, { recursive: true });
  const serverEntrypoint = `import { startDevServer } from "@poncho-ai/cli";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
await startDevServer(Number.isNaN(port) ? 3000 : port, { workingDir: process.cwd() });
`;
  const runtimePackageJson = JSON.stringify(
    {
      name: "poncho-runtime-bundle",
      private: true,
      type: "module",
      scripts: {
        start: "node server.js",
      },
      dependencies: {
        "@poncho-ai/cli": "^0.1.0",
      },
    },
    null,
    2,
  );

  if (target === "vercel") {
    await mkdir(resolve(outDir, "api"), { recursive: true });
    await copyIfExists(resolve(workingDir, "AGENT.md"), resolve(outDir, "AGENT.md"));
    await copyIfExists(
      resolve(workingDir, "poncho.config.js"),
      resolve(outDir, "poncho.config.js"),
    );
    await copyIfExists(resolve(workingDir, "skills"), resolve(outDir, "skills"));
    await copyIfExists(resolve(workingDir, "tests"), resolve(outDir, "tests"));
    await writeFile(
      resolve(outDir, "vercel.json"),
      JSON.stringify(
        {
          version: 2,
          functions: {
            "api/index.js": {
              includeFiles: "{AGENT.md,poncho.config.js,skills/**,tests/**}",
            },
          },
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
COPY poncho.config.js poncho.config.js
COPY skills skills
COPY tests tests
COPY .env.example .env.example
RUN corepack enable && npm install -g @poncho-ai/cli
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
      `import { startDevServer } from "@poncho-ai/cli";
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
      `app = "poncho-app"
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
COPY poncho.config.js poncho.config.js
COPY skills skills
COPY tests tests
RUN npm install -g @poncho-ai/cli
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
    authBearerEnv?: string;
  },
): Promise<void> => {
  const config = (await loadPonchoConfig(workingDir)) ?? { mcp: [] };
  const mcp = [...(config.mcp ?? [])];
  if (!options.url) {
    throw new Error("Remote MCP only: provide --url for a remote MCP server.");
  }
  if (options.url.startsWith("ws://") || options.url.startsWith("wss://")) {
    throw new Error("WebSocket MCP URLs are no longer supported. Use an HTTP MCP endpoint.");
  }
  if (!options.url.startsWith("http://") && !options.url.startsWith("https://")) {
    throw new Error("Invalid MCP URL. Expected http:// or https://.");
  }
  const serverName = options.name ?? normalizeMcpName({ url: options.url });
  mcp.push({
    name: serverName,
    url: options.url,
    env: options.envVars ?? [],
    auth: options.authBearerEnv
      ? {
          type: "bearer",
          tokenEnv: options.authBearerEnv,
        }
      : undefined,
  });

  await writeConfigFile(workingDir, { ...config, mcp });
  let envSeedMessage: string | undefined;
  if (options.authBearerEnv) {
    const envPath = resolve(workingDir, ".env");
    const envExamplePath = resolve(workingDir, ".env.example");
    const addedEnv = await ensureEnvPlaceholder(envPath, options.authBearerEnv);
    const addedEnvExample = await ensureEnvPlaceholder(envExamplePath, options.authBearerEnv);
    if (addedEnv || addedEnvExample) {
      envSeedMessage = `Added ${options.authBearerEnv}= to ${addedEnv ? ".env" : ""}${addedEnv && addedEnvExample ? " and " : ""}${addedEnvExample ? ".env.example" : ""}.`;
    }
  }
  const nextSteps: string[] = [];
  let step = 1;
  if (options.authBearerEnv) {
    nextSteps.push(`  ${step}) Set token in .env: ${options.authBearerEnv}=...`);
    step += 1;
  }
  nextSteps.push(`  ${step}) Discover tools: poncho mcp tools list ${serverName}`);
  step += 1;
  nextSteps.push(`  ${step}) Select tools:   poncho mcp tools select ${serverName}`);
  step += 1;
  nextSteps.push(`  ${step}) Verify config:  poncho mcp list`);
  process.stdout.write(
    [
      `MCP server added: ${serverName}`,
      ...(envSeedMessage ? [envSeedMessage] : []),
      "Next steps:",
      ...nextSteps,
      "",
    ].join("\n"),
  );
};

export const mcpList = async (workingDir: string): Promise<void> => {
  const config = await loadPonchoConfig(workingDir);
  const mcp = config?.mcp ?? [];
  if (mcp.length === 0) {
    process.stdout.write("No MCP servers configured.\n");
    if (config?.scripts) {
      process.stdout.write(
        `Script policy: mode=${config.scripts.mode ?? "all"} include=${config.scripts.include?.length ?? 0} exclude=${config.scripts.exclude?.length ?? 0}\n`,
      );
    }
    return;
  }
  process.stdout.write("Configured MCP servers:\n");
  for (const entry of mcp) {
    const auth =
      entry.auth?.type === "bearer" ? `auth=bearer:${entry.auth.tokenEnv}` : "auth=none";
    const mode = entry.tools?.mode ?? "all";
    process.stdout.write(
      `- ${entry.name ?? entry.url} (remote: ${entry.url}, ${auth}, mode=${mode})\n`,
    );
  }
  if (config?.scripts) {
    process.stdout.write(
      `Script policy: mode=${config.scripts.mode ?? "all"} include=${config.scripts.include?.length ?? 0} exclude=${config.scripts.exclude?.length ?? 0}\n`,
    );
  }
};

export const mcpRemove = async (workingDir: string, name: string): Promise<void> => {
  const config = (await loadPonchoConfig(workingDir)) ?? { mcp: [] };
  const before = config.mcp ?? [];
  const removed = before.filter((entry) => normalizeMcpName(entry) === name);
  const filtered = before.filter((entry) => normalizeMcpName(entry) !== name);
  await writeConfigFile(workingDir, { ...config, mcp: filtered });
  const removedTokenEnvNames = new Set(
    removed
      .map((entry) =>
        entry.auth?.type === "bearer" ? entry.auth.tokenEnv?.trim() ?? "" : "",
      )
      .filter((value) => value.length > 0),
  );
  const stillUsedTokenEnvNames = new Set(
    filtered
      .map((entry) =>
        entry.auth?.type === "bearer" ? entry.auth.tokenEnv?.trim() ?? "" : "",
      )
      .filter((value) => value.length > 0),
  );
  const removedFromExample: string[] = [];
  for (const tokenEnv of removedTokenEnvNames) {
    if (stillUsedTokenEnvNames.has(tokenEnv)) {
      continue;
    }
    const changed = await removeEnvPlaceholder(resolve(workingDir, ".env.example"), tokenEnv);
    if (changed) {
      removedFromExample.push(tokenEnv);
    }
  }
  process.stdout.write(`Removed MCP server: ${name}\n`);
  if (removedFromExample.length > 0) {
    process.stdout.write(
      `Removed unused token placeholder(s) from .env.example: ${removedFromExample.join(", ")}\n`,
    );
  }
};

const resolveMcpEntry = async (
  workingDir: string,
  serverName: string,
): Promise<{ config: PonchoConfig; index: number }> => {
  const config = (await loadPonchoConfig(workingDir)) ?? { mcp: [] };
  const entries = config.mcp ?? [];
  const index = entries.findIndex((entry) => normalizeMcpName(entry) === serverName);
  if (index < 0) {
    throw new Error(`MCP server "${serverName}" is not configured.`);
  }
  return { config, index };
};

const discoverMcpTools = async (
  workingDir: string,
  serverName: string,
): Promise<string[]> => {
  dotenv.config({ path: resolve(workingDir, ".env") });
  const { config, index } = await resolveMcpEntry(workingDir, serverName);
  const entry = (config.mcp ?? [])[index];
  const bridge = new LocalMcpBridge({ mcp: [entry] });
  try {
    await bridge.startLocalServers();
    await bridge.discoverTools();
    return bridge.listDiscoveredTools(normalizeMcpName(entry));
  } finally {
    await bridge.stopLocalServers();
  }
};

export const mcpToolsList = async (
  workingDir: string,
  serverName: string,
): Promise<void> => {
  const discovered = await discoverMcpTools(workingDir, serverName);
  if (discovered.length === 0) {
    process.stdout.write(`No tools discovered for MCP server "${serverName}".\n`);
    return;
  }
  process.stdout.write(`Discovered tools for "${serverName}":\n`);
  for (const tool of discovered) {
    process.stdout.write(`- ${tool}\n`);
  }
};

export const mcpToolsSelect = async (
  workingDir: string,
  serverName: string,
  options: {
    all?: boolean;
    toolsCsv?: string;
  },
): Promise<void> => {
  const discovered = await discoverMcpTools(workingDir, serverName);
  if (discovered.length === 0) {
    process.stdout.write(`No tools discovered for MCP server "${serverName}".\n`);
    return;
  }
  let selected: string[] = [];
  if (options.all) {
    selected = [...discovered];
  } else if (options.toolsCsv && options.toolsCsv.trim().length > 0) {
    const requested = options.toolsCsv
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    selected = discovered.filter((tool) => requested.includes(tool));
  } else {
    process.stdout.write(`Discovered tools for "${serverName}":\n`);
    discovered.forEach((tool, idx) => {
      process.stdout.write(`${idx + 1}. ${tool}\n`);
    });
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      "Enter comma-separated tool numbers/names to allow (or * for all): ",
    );
    rl.close();
    const raw = answer.trim();
    if (raw === "*") {
      selected = [...discovered];
    } else {
      const tokens = raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      const fromIndex = tokens
        .map((token) => Number.parseInt(token, 10))
        .filter((value) => !Number.isNaN(value))
        .map((index) => discovered[index - 1])
        .filter((value): value is string => typeof value === "string");
      const byName = discovered.filter((tool) => tokens.includes(tool));
      selected = [...new Set([...fromIndex, ...byName])];
    }
  }
  if (selected.length === 0) {
    throw new Error("No valid tools selected.");
  }
  const includePatterns =
    selected.length === discovered.length
      ? [`${serverName}/*`]
      : selected.sort();
  const { config, index } = await resolveMcpEntry(workingDir, serverName);
  const mcp = [...(config.mcp ?? [])];
  const existing = mcp[index];
  mcp[index] = {
    ...existing,
    tools: {
      ...(existing.tools ?? {}),
      mode: "allowlist",
      include: includePatterns,
    },
  };
  await writeConfigFile(workingDir, { ...config, mcp });
  process.stdout.write(
    `Updated ${serverName} to allowlist ${includePatterns.join(", ")} in poncho.config.js.\n`,
  );
  process.stdout.write(
    "\nRequired next step: add MCP intent in AGENT.md or SKILL.md. Without this, these MCP tools will not be registered for the model.\n",
  );
  process.stdout.write(
    "\nOption A: AGENT.md (global fallback intent)\n" +
      "Paste this into AGENT.md frontmatter:\n" +
      "---\n" +
      "tools:\n" +
      "  mcp:\n" +
      includePatterns.map((tool) => `    - ${tool}`).join("\n") +
      "\n---\n",
  );
  process.stdout.write(
    "\nOption B: SKILL.md (only when that skill is activated)\n" +
      "Paste this into SKILL.md frontmatter:\n" +
      "---\n" +
      "tools:\n" +
      "  mcp:\n" +
      includePatterns.map((tool) => `    - ${tool}`).join("\n") +
      "\n---\n",
  );
};

export const buildCli = (): Command => {
  const program = new Command();
  program
    .name("poncho")
    .description("CLI for building and running Poncho agents")
    .version("0.1.0");

  program
    .command("init")
    .argument("<name>", "project name")
    .option("--yes", "accept defaults and skip prompts", false)
    .description("Scaffold a new Poncho project")
    .action(async (name: string, options: { yes: boolean }) => {
      await initProject(name, {
        onboarding: {
          yes: options.yes,
          interactive:
            !options.yes && process.stdin.isTTY === true && process.stdout.isTTY === true,
        },
      });
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
    .description("Remove deprecated embedded local guidance from AGENT.md")
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
    .option(
      "--auth-bearer-env <name>",
      "env var name containing bearer token for this MCP server",
    )
    .option("--env <name>", "env variable (repeatable)", (value, all: string[]) => {
      all.push(value);
      return all;
    }, [] as string[])
    .action(
      async (
        options: {
          url?: string;
          name?: string;
          authBearerEnv?: string;
          env: string[];
        },
      ) => {
        await mcpAdd(process.cwd(), {
          url: options.url,
          name: options.name,
          envVars: options.env,
          authBearerEnv: options.authBearerEnv,
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

  const mcpToolsCommand = mcpCommand
    .command("tools")
    .description("Discover and curate tools for a configured MCP server");

  mcpToolsCommand
    .command("list")
    .argument("<name>", "server name")
    .description("Discover and list tools from a configured MCP server")
    .action(async (name: string) => {
      await mcpToolsList(process.cwd(), name);
    });

  mcpToolsCommand
    .command("select")
    .argument("<name>", "server name")
    .description("Select MCP tools and store as config allowlist")
    .option("--all", "select all discovered tools", false)
    .option("--tools <csv>", "comma-separated discovered tool names")
    .action(
      async (
        name: string,
        options: {
          all: boolean;
          tools?: string;
        },
      ) => {
        await mcpToolsSelect(process.cwd(), name, {
          all: options.all,
          toolsCsv: options.tools,
        });
      },
    );

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
      const message = "Port is already in use. Try `poncho dev --port 3001` or stop the process using port 3000.";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : "Unknown CLI error"}\n`);
    process.exitCode = 1;
  }
};

export const packageRoot = resolve(__dirname, "..");
