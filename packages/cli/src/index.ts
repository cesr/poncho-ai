import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { basename, dirname, normalize, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  AgentHarness,
  LocalMcpBridge,
  TelemetryEmitter,
  createConversationStore,
  ensureAgentIdentity,
  generateAgentId,
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
  type DeployTarget,
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
  id: string,
  options: { modelProvider: "anthropic" | "openai"; modelName: string },
): string => `---
name: ${name}
id: ${id}
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
const resolveCoreDeps = async (
  projectDir: string,
): Promise<{ harness: string; sdk: string }> => {
  const packagesRoot = resolveLocalPackagesRoot();
  if (packagesRoot) {
    const harnessAbs = resolve(packagesRoot, "harness");
    const sdkAbs = resolve(packagesRoot, "sdk");
    return {
      harness: `link:${relative(projectDir, harnessAbs)}`,
      sdk: `link:${relative(projectDir, sdkAbs)}`,
    };
  }
  return {
    harness: await readCliDependencyVersion("@poncho-ai/harness", "^0.6.0"),
    sdk: await readCliDependencyVersion("@poncho-ai/sdk", "^0.6.0"),
  };
};

const PACKAGE_TEMPLATE = async (name: string, projectDir: string): Promise<string> => {
  const deps = await resolveCoreDeps(projectDir);
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
While a response is streaming, you can stop it:
- Web UI: click the send button again (it switches to a stop icon)
- Interactive CLI: press \`Ctrl+C\`

Stopping is best-effort and keeps partial assistant output/tool activity already produced.

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
# Install all skills from a source package/repo
poncho skills add <repo-or-path>

# Install one specific skill path from a source
poncho skills add <repo-or-path> <relative-skill-path>

# Remove all installed skills from a source
poncho skills remove <repo-or-path>

# Remove one installed skill path from a source
poncho skills remove <repo-or-path> <relative-skill-path>

# List installed skills
poncho skills list

# Verify loaded tools
poncho tools
\`\`\`

\`poncho skills add\` copies discovered skill directories (folders that contain \`SKILL.md\`) into \`skills/<source>/...\`.
If a destination folder already exists, the command fails instead of overwriting files.
\`poncho add\` and \`poncho remove\` remain available as aliases.

After adding skills, run \`poncho dev\` or \`poncho run --interactive\` and ask the agent to use them.

## Configure MCP Servers (Remote)

Connect remote MCP servers and expose their tools to the agent:

\`\`\`bash
# Add remote MCP server
poncho mcp add --url https://mcp.example.com/github --name github --auth-bearer-env GITHUB_TOKEN

# List configured servers
poncho mcp list

# Discover MCP tools and print frontmatter intent snippets
poncho mcp tools list github
poncho mcp tools select github

# Remove a server
poncho mcp remove github
\`\`\`

Set required secrets in \`.env\` (for example, \`GITHUB_TOKEN=...\`).

## Tool Intent and Approvals in Frontmatter

Declare tool intent directly in \`AGENT.md\` and \`SKILL.md\` frontmatter:

\`\`\`yaml
allowed-tools:
  - mcp:github/list_issues
  - mcp:github/*
approval-required:
  - mcp:github/create_issue
  - ./scripts/deploy.ts
\`\`\`

How it works:

- \`AGENT.md\` provides fallback MCP intent when no skill is active.
- \`SKILL.md\` intent applies when you activate that skill (\`activate_skill\`).
- Scripts in a sibling \`scripts/\` directory are available by convention.
- For non-standard script folders (for example \`tools/\`), add explicit relative entries in \`allowed-tools\`.
- Use \`approval-required\` to require human approval for specific MCP calls or script files.
- Deactivating a skill (\`deactivate_skill\`) removes its MCP tools from runtime registration.

Pattern format is strict slash-only:

- MCP: \`server/tool\`, \`server/*\`
- Scripts: relative paths such as \`./scripts/file.ts\`, \`./scripts/*\`, \`./tools/deploy.ts\`

Skill authoring guardrails:

- Every \`SKILL.md\` must include YAML frontmatter between \`---\` markers.
- Include at least \`name\` (required for discovery) and \`description\`.
- Put tool intent in frontmatter using \`allowed-tools\` and \`approval-required\`.
- \`approval-required\` is stricter than allowed access:
  - MCP entries in \`approval-required\` must also appear in \`allowed-tools\`.
  - Script entries outside \`./scripts/\` must also appear in \`allowed-tools\`.
- Keep MCP server connection details in \`poncho.config.js\`, not in \`SKILL.md\`.

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
    },
  ],
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
    ├── starter/
    │   ├── SKILL.md
    │   └── scripts/
    │       └── starter-echo.ts
    └── fetch-page/
        ├── SKILL.md
        └── scripts/
            └── fetch-page.ts
\`\`\`

## Deployment

\`\`\`bash
# Build for Vercel
poncho build vercel
vercel deploy --prod

# Build for Docker
poncho build docker
docker build -t ${name} .
\`\`\`

## Troubleshooting

### Vercel deploy issues

- After upgrading \`@poncho-ai/cli\`, re-run \`poncho build vercel --force\` to refresh generated deploy files.
- If Vercel fails during \`pnpm install\` due to a lockfile mismatch, run \`pnpm install --no-frozen-lockfile\` locally and commit \`pnpm-lock.yaml\`.
- Deploy from the project root: \`vercel deploy --prod\`.

For full reference:
https://github.com/cesr/poncho-ai
`;

const ENV_TEMPLATE = "ANTHROPIC_API_KEY=sk-ant-...\n";
const GITIGNORE_TEMPLATE =
  ".env\nnode_modules\ndist\n.poncho/\ninteractive-session.json\n.vercel\n";
const TEST_TEMPLATE = `tests:
  - name: "Basic sanity"
    task: "What is 2 + 2?"
    expect:
      contains: "4"
`;

const SKILL_TEMPLATE = `---
name: starter-skill
description: Starter local skill template
allowed-tools:
  - ./scripts/starter-echo.ts
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

const FETCH_PAGE_SKILL_TEMPLATE = `---
name: fetch-page
description: Fetch a web page and return its text content
allowed-tools:
  - ./scripts/fetch-page.ts
---

# Fetch Page

Fetches a URL and returns the page body as plain text (HTML tags stripped).

## Usage

Call \`run_skill_script\` with:
- **skill**: \`fetch-page\`
- **script**: \`./scripts/fetch-page.ts\`
- **input**: \`{ "url": "https://example.com" }\`

The script returns \`{ url, status, content }\` where \`content\` is the
text-only body (capped at ~32 000 chars to stay context-friendly).
`;

const FETCH_PAGE_SCRIPT_TEMPLATE = `export default async function run(input) {
  const url = typeof input?.url === "string" ? input.url.trim() : "";
  if (!url) {
    return { error: "A \\"url\\" string is required." };
  }

  const MAX_LENGTH = 32_000;

  const response = await fetch(url, {
    headers: { "User-Agent": "poncho-fetch-page/1.0" },
    redirect: "follow",
  });

  if (!response.ok) {
    return { url, status: response.status, error: response.statusText };
  }

  const html = await response.text();

  // Lightweight HTML-to-text: strip tags, collapse whitespace.
  const text = html
    .replace(/<script[\\s\\S]*?<\\/script>/gi, "")
    .replace(/<style[\\s\\S]*?<\\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\\s+/g, " ")
    .trim();

  const content = text.length > MAX_LENGTH
    ? text.slice(0, MAX_LENGTH) + "… (truncated)"
    : text;

  return { url, status: response.status, content };
}
`;

const ensureFile = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
};

type DeployScaffoldTarget = Exclude<DeployTarget, "none">;

const normalizeDeployTarget = (target: string): DeployScaffoldTarget => {
  const normalized = target.toLowerCase();
  if (
    normalized === "vercel" ||
    normalized === "docker" ||
    normalized === "lambda" ||
    normalized === "fly"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported build target: ${target}`);
};

const readCliVersion = async (): Promise<string> => {
  const fallback = "0.1.0";
  try {
    const packageJsonPath = resolve(packageRoot, "package.json");
    const content = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(content) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version;
    }
  } catch {
    // Use fallback when package metadata cannot be read.
  }
  return fallback;
};

const readCliDependencyVersion = async (
  dependencyName: string,
  fallback: string,
): Promise<string> => {
  try {
    const packageJsonPath = resolve(packageRoot, "package.json");
    const content = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(content) as { dependencies?: Record<string, unknown> };
    const value = parsed.dependencies?.[dependencyName];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  } catch {
    // Use fallback when package metadata cannot be read.
  }
  return fallback;
};

const writeScaffoldFile = async (
  filePath: string,
  content: string,
  options: { force?: boolean; writtenPaths: string[]; baseDir: string },
): Promise<void> => {
  if (!options.force) {
    try {
      await access(filePath);
      throw new Error(
        `Refusing to overwrite existing file: ${relative(options.baseDir, filePath)}. Re-run with --force to overwrite.`,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Refusing to overwrite")) {
        // File does not exist, safe to continue.
      } else {
        throw error;
      }
    }
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  options.writtenPaths.push(relative(options.baseDir, filePath));
};

const ensureRuntimeCliDependency = async (
  projectDir: string,
  cliVersion: string,
): Promise<string[]> => {
  const packageJsonPath = resolve(projectDir, "package.json");
  const content = await readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = { ...(parsed.dependencies ?? {}) };
  const isLocalOnlySpecifier = (value: string | undefined): boolean =>
    typeof value === "string" &&
    (value.startsWith("link:") || value.startsWith("workspace:") || value.startsWith("file:"));

  // Deployment projects should not depend on local monorepo paths.
  if (isLocalOnlySpecifier(dependencies["@poncho-ai/harness"])) {
    delete dependencies["@poncho-ai/harness"];
  }
  if (isLocalOnlySpecifier(dependencies["@poncho-ai/sdk"])) {
    delete dependencies["@poncho-ai/sdk"];
  }
  dependencies.marked = await readCliDependencyVersion("marked", "^17.0.2");
  dependencies["@poncho-ai/cli"] = `^${cliVersion}`;
  parsed.dependencies = dependencies;
  await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return [relative(projectDir, packageJsonPath)];
};

const scaffoldDeployTarget = async (
  projectDir: string,
  target: DeployScaffoldTarget,
  options?: { force?: boolean },
): Promise<string[]> => {
  const writtenPaths: string[] = [];
  const cliVersion = await readCliVersion();
  const sharedServerEntrypoint = `import { startDevServer } from "@poncho-ai/cli";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
await startDevServer(Number.isNaN(port) ? 3000 : port, { workingDir: process.cwd() });
`;

  if (target === "vercel") {
    const entryPath = resolve(projectDir, "api", "index.mjs");
    await writeScaffoldFile(
      entryPath,
      `import "marked";
import { createRequestHandler } from "@poncho-ai/cli";
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
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
    const vercelConfigPath = resolve(projectDir, "vercel.json");
    await writeScaffoldFile(
      vercelConfigPath,
      `${JSON.stringify(
        {
          version: 2,
          functions: {
            "api/index.mjs": {
              includeFiles:
                "{AGENT.md,poncho.config.js,skills/**,tests/**,node_modules/.pnpm/marked@*/node_modules/marked/lib/marked.umd.js}",
            },
          },
          routes: [{ src: "/(.*)", dest: "/api/index.mjs" }],
        },
        null,
        2,
      )}\n`,
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
  } else if (target === "docker") {
    const dockerfilePath = resolve(projectDir, "Dockerfile");
    await writeScaffoldFile(
      dockerfilePath,
      `FROM node:20-slim
WORKDIR /app
COPY package.json package.json
COPY AGENT.md AGENT.md
COPY poncho.config.js poncho.config.js
COPY skills skills
COPY tests tests
COPY .env.example .env.example
RUN corepack enable && npm install -g @poncho-ai/cli@^${cliVersion}
COPY server.js server.js
EXPOSE 3000
CMD ["node","server.js"]
`,
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
    await writeScaffoldFile(resolve(projectDir, "server.js"), sharedServerEntrypoint, {
      force: options?.force,
      writtenPaths,
      baseDir: projectDir,
    });
  } else if (target === "lambda") {
    await writeScaffoldFile(
      resolve(projectDir, "lambda-handler.js"),
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
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
  } else if (target === "fly") {
    await writeScaffoldFile(
      resolve(projectDir, "fly.toml"),
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
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
    await writeScaffoldFile(
      resolve(projectDir, "Dockerfile"),
      `FROM node:20-slim
WORKDIR /app
COPY package.json package.json
COPY AGENT.md AGENT.md
COPY poncho.config.js poncho.config.js
COPY skills skills
COPY tests tests
RUN npm install -g @poncho-ai/cli@^${cliVersion}
COPY server.js server.js
EXPOSE 3000
CMD ["node","server.js"]
`,
      { force: options?.force, writtenPaths, baseDir: projectDir },
    );
    await writeScaffoldFile(resolve(projectDir, "server.js"), sharedServerEntrypoint, {
      force: options?.force,
      writtenPaths,
      baseDir: projectDir,
    });
  }

  const packagePaths = await ensureRuntimeCliDependency(projectDir, cliVersion);
  for (const path of packagePaths) {
    if (!writtenPaths.includes(path)) {
      writtenPaths.push(path);
    }
  }

  return writtenPaths;
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
  const agentId = generateAgentId();

  const G = "\x1b[32m";
  const D = "\x1b[2m";
  const B = "\x1b[1m";
  const CY = "\x1b[36m";
  const YW = "\x1b[33m";
  const R = "\x1b[0m";

  process.stdout.write("\n");

  const scaffoldFiles: Array<{ path: string; content: string }> = [
    {
      path: "AGENT.md",
      content: AGENT_TEMPLATE(projectName, agentId, {
        modelProvider: onboarding.agentModel.provider,
        modelName: onboarding.agentModel.name,
      }),
    },
    { path: "poncho.config.js", content: renderConfigFile(onboarding.config) },
    { path: "package.json", content: await PACKAGE_TEMPLATE(projectName, projectDir) },
    { path: "README.md", content: README_TEMPLATE(projectName) },
    { path: ".env.example", content: options?.envExampleOverride ?? onboarding.envExample ?? ENV_TEMPLATE },
    { path: ".gitignore", content: GITIGNORE_TEMPLATE },
    { path: "tests/basic.yaml", content: TEST_TEMPLATE },
    { path: "skills/starter/SKILL.md", content: SKILL_TEMPLATE },
    { path: "skills/starter/scripts/starter-echo.ts", content: SKILL_TOOL_TEMPLATE },
    { path: "skills/fetch-page/SKILL.md", content: FETCH_PAGE_SKILL_TEMPLATE },
    { path: "skills/fetch-page/scripts/fetch-page.ts", content: FETCH_PAGE_SCRIPT_TEMPLATE },
  ];
  if (onboarding.envFile) {
    scaffoldFiles.push({ path: ".env", content: onboarding.envFile });
  }

  for (const file of scaffoldFiles) {
    await ensureFile(resolve(projectDir, file.path), file.content);
    process.stdout.write(`  ${D}+${R} ${D}${file.path}${R}\n`);
  }

  if (onboarding.deployTarget !== "none") {
    const deployFiles = await scaffoldDeployTarget(projectDir, onboarding.deployTarget);
    for (const filePath of deployFiles) {
      process.stdout.write(`  ${D}+${R} ${D}${filePath}${R}\n`);
    }
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
  const runOwners = new Map<string, string>();
  const runConversations = new Map<string, string>();
  type ActiveConversationRun = {
    ownerId: string;
    abortController: AbortController;
    runId: string | null;
  };
  const activeConversationRuns = new Map<string, ActiveConversationRun>();
  type PendingApproval = {
    ownerId: string;
    runId: string;
    conversationId: string | null;
    tool: string;
    input: Record<string, unknown>;
    resolve: (approved: boolean) => void;
  };
  const pendingApprovals = new Map<string, PendingApproval>();

  // Per-conversation event streaming: buffer events and allow SSE subscribers
  type ConversationEventStream = {
    buffer: AgentEvent[];
    subscribers: Set<ServerResponse>;
    finished: boolean;
  };
  const conversationEventStreams = new Map<string, ConversationEventStream>();
  const broadcastEvent = (conversationId: string, event: AgentEvent): void => {
    let stream = conversationEventStreams.get(conversationId);
    if (!stream) {
      stream = { buffer: [], subscribers: new Set(), finished: false };
      conversationEventStreams.set(conversationId, stream);
    }
    stream.buffer.push(event);
    for (const subscriber of stream.subscribers) {
      try {
        subscriber.write(formatSseEvent(event));
      } catch {
        stream.subscribers.delete(subscriber);
      }
    }
  };
  const finishConversationStream = (conversationId: string): void => {
    const stream = conversationEventStreams.get(conversationId);
    if (stream) {
      stream.finished = true;
      for (const subscriber of stream.subscribers) {
        try {
          subscriber.write("event: stream:end\ndata: {}\n\n");
          subscriber.end();
        } catch {
          // Already closed.
        }
      }
      stream.subscribers.clear();
      // Keep buffer for a short time so late-joining clients get replay
      setTimeout(() => conversationEventStreams.delete(conversationId), 30_000);
    }
  };
  const persistConversationPendingApprovals = async (conversationId: string): Promise<void> => {
    const conversation = await conversationStore.get(conversationId);
    if (!conversation) {
      return;
    }
    conversation.pendingApprovals = Array.from(pendingApprovals.entries())
      .filter(
        ([, pending]) =>
          pending.ownerId === conversation.ownerId && pending.conversationId === conversationId,
      )
      .map(([approvalId, pending]) => ({
        approvalId,
        runId: pending.runId,
        tool: pending.tool,
        input: pending.input,
      }));
    await conversationStore.update(conversation);
  };
  const clearPendingApprovalsForConversation = async (conversationId: string): Promise<void> => {
    for (const [approvalId, pending] of pendingApprovals.entries()) {
      if (pending.conversationId !== conversationId) {
        continue;
      }
      pendingApprovals.delete(approvalId);
      pending.resolve(false);
    }
    await persistConversationPendingApprovals(conversationId);
  };
  const harness = new AgentHarness({
    workingDir,
    environment: resolveHarnessEnvironment(),
    approvalHandler: async (request) =>
      new Promise<boolean>((resolveApproval) => {
        const ownerIdForRun = runOwners.get(request.runId) ?? "local-owner";
        const conversationIdForRun = runConversations.get(request.runId) ?? null;
        pendingApprovals.set(request.approvalId, {
          ownerId: ownerIdForRun,
          runId: request.runId,
          conversationId: conversationIdForRun,
          tool: request.tool,
          input: request.input,
          resolve: resolveApproval,
        });
        if (conversationIdForRun) {
          void persistConversationPendingApprovals(conversationIdForRun);
        }
      }),
  });
  await harness.initialize();
  const telemetry = new TelemetryEmitter(config?.telemetry);
  const identity = await ensureAgentIdentity(workingDir);
  const conversationStore = createConversationStore(resolveStateConfig(config), {
    workingDir,
    agentId: identity.id,
  });
  const sessionStore = new SessionStore();
  const loginRateLimiter = new LoginRateLimiter();

  // Unified authentication using PONCHO_AUTH_TOKEN for both Web UI and API
  const authToken = process.env.PONCHO_AUTH_TOKEN ?? "";
  const authRequired = config?.auth?.required ?? false;
  const requireAuth = authRequired && authToken.length > 0;

  const isProduction = resolveHarnessEnvironment() === "production";
  const secureCookies = isProduction;

  // Helper to extract and validate Bearer token from Authorization header
  const validateBearerToken = (authHeader: string | string[] | undefined): boolean => {
    if (!requireAuth || !authToken) {
      return true; // No auth required
    }
    if (!authHeader || typeof authHeader !== "string") {
      return false;
    }
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || !match[1]) {
      return false;
    }
    return verifyPassphrase(match[1], authToken);
  };

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
      if (!requireAuth) {
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
      if (!requireAuth) {
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
      if (!verifyPassphrase(provided, authToken)) {
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
      // Check authentication: either valid session (Web UI) or valid Bearer token (API)
      const hasBearerToken = request.headers.authorization?.startsWith("Bearer ");
      const isAuthenticated = !requireAuth || session || validateBearerToken(request.headers.authorization);

      if (!isAuthenticated) {
        writeJson(response, 401, {
          code: "AUTH_ERROR",
          message: "Authentication required",
        });
        return;
      }

      // CSRF validation only for session-based requests (not Bearer token requests)
      if (
        requireAuth &&
        session &&
        !hasBearerToken &&
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

    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (approvalMatch && request.method === "POST") {
      const approvalId = decodeURIComponent(approvalMatch[1] ?? "");
      const pending = pendingApprovals.get(approvalId);
      if (!pending || pending.ownerId !== ownerId) {
        // If the server restarted, an old pending approval can remain in
        // conversation history without an active resolver. Prune stale entries.
        const conversations = await conversationStore.list(ownerId);
        let prunedStale = false;
        for (const conversation of conversations) {
          if (!Array.isArray(conversation.pendingApprovals)) {
            continue;
          }
          const next = conversation.pendingApprovals.filter(
            (approval) => approval.approvalId !== approvalId,
          );
          if (next.length !== conversation.pendingApprovals.length) {
            conversation.pendingApprovals = next;
            await conversationStore.update(conversation);
            prunedStale = true;
          }
        }
        writeJson(response, 404, {
          code: "APPROVAL_NOT_FOUND",
          message: prunedStale
            ? "Approval request is no longer active"
            : "Approval request not found",
        });
        return;
      }
      const body = (await readRequestBody(request)) as { approved?: boolean };
      const approved = body.approved === true;
      pendingApprovals.delete(approvalId);
      if (pending.conversationId) {
        await persistConversationPendingApprovals(pending.conversationId);
      }
      pending.resolve(approved);
      writeJson(response, 200, { ok: true, approvalId, approved });
      return;
    }

    const conversationEventsMatch = pathname.match(
      /^\/api\/conversations\/([^/]+)\/events$/,
    );
    if (conversationEventsMatch && request.method === "GET") {
      const conversationId = decodeURIComponent(conversationEventsMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const stream = conversationEventStreams.get(conversationId);
      if (!stream) {
        // No active run — close immediately
        response.write("event: stream:end\ndata: {}\n\n");
        response.end();
        return;
      }
      // Replay buffered events
      for (const bufferedEvent of stream.buffer) {
        try {
          response.write(formatSseEvent(bufferedEvent));
        } catch {
          response.end();
          return;
        }
      }
      if (stream.finished) {
        response.write("event: stream:end\ndata: {}\n\n");
        response.end();
        return;
      }
      // Subscribe to live events
      stream.subscribers.add(response);
      request.on("close", () => {
        stream.subscribers.delete(response);
      });
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
        const storedPending = Array.isArray(conversation.pendingApprovals)
          ? conversation.pendingApprovals
          : [];
        const livePending = Array.from(pendingApprovals.entries())
          .filter(
            ([, pending]) =>
              pending.ownerId === ownerId && pending.conversationId === conversationId,
          )
          .map(([approvalId, pending]) => ({
            approvalId,
            runId: pending.runId,
            tool: pending.tool,
            input: pending.input,
          }));
        const mergedPendingById = new Map<string, (typeof livePending)[number]>();
        for (const approval of storedPending) {
          if (approval && typeof approval.approvalId === "string") {
            mergedPendingById.set(approval.approvalId, approval);
          }
        }
        for (const approval of livePending) {
          mergedPendingById.set(approval.approvalId, approval);
        }
        writeJson(response, 200, {
          conversation: {
            ...conversation,
            pendingApprovals: Array.from(mergedPendingById.values()),
          },
        });
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

    const conversationStopMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/stop$/);
    if (conversationStopMatch && request.method === "POST") {
      const conversationId = decodeURIComponent(conversationStopMatch[1] ?? "");
      const body = (await readRequestBody(request)) as { runId?: string };
      const requestedRunId = typeof body.runId === "string" ? body.runId.trim() : "";
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || conversation.ownerId !== ownerId) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      const activeRun = activeConversationRuns.get(conversationId);
      if (!activeRun || activeRun.ownerId !== ownerId) {
        writeJson(response, 200, {
          ok: true,
          stopped: false,
        });
        return;
      }
      if (activeRun.abortController.signal.aborted) {
        activeConversationRuns.delete(conversationId);
        writeJson(response, 200, {
          ok: true,
          stopped: false,
        });
        return;
      }
      if (requestedRunId && activeRun.runId !== requestedRunId) {
        writeJson(response, 200, {
          ok: true,
          stopped: false,
          runId: activeRun.runId ?? undefined,
        });
        return;
      }
      if (!requestedRunId) {
        writeJson(response, 200, {
          ok: true,
          stopped: false,
          runId: activeRun.runId ?? undefined,
        });
        return;
      }
      activeRun.abortController.abort();
      await clearPendingApprovalsForConversation(conversationId);
      writeJson(response, 200, {
        ok: true,
        stopped: true,
        runId: activeRun.runId ?? undefined,
      });
      return;
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
      const activeRun = activeConversationRuns.get(conversationId);
      if (activeRun && activeRun.ownerId === ownerId) {
        if (activeRun.abortController.signal.aborted) {
          activeConversationRuns.delete(conversationId);
        } else {
          writeJson(response, 409, {
            code: "RUN_IN_PROGRESS",
            message: "A run is already active for this conversation",
          });
          return;
        }
      }
      const abortController = new AbortController();
      activeConversationRuns.set(conversationId, {
        ownerId,
        abortController,
        runId: null,
      });
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
      const historyMessages = [...conversation.messages];
      let latestRunId = conversation.runtimeRunId ?? "";
      let assistantResponse = "";
      const toolTimeline: string[] = [];
      const sections: Array<{ type: "text" | "tools"; content: string | string[] }> = [];
      let currentText = "";
      let currentTools: string[] = [];
      let runCancelled = false;
      try {
        // Persist the user turn immediately so refreshing mid-run keeps chat context.
        conversation.messages = [...historyMessages, { role: "user", content: messageText }];
        conversation.updatedAt = Date.now();
        await conversationStore.update(conversation);

        const persistDraftAssistantTurn = async (): Promise<void> => {
          const draftSections: Array<{ type: "text" | "tools"; content: string | string[] }> = [
            ...sections.map((section) => ({
              type: section.type,
              content: Array.isArray(section.content) ? [...section.content] : section.content,
            })),
          ];
          if (currentTools.length > 0) {
            draftSections.push({ type: "tools", content: [...currentTools] });
          }
          if (currentText.length > 0) {
            draftSections.push({ type: "text", content: currentText });
          }
          const hasDraftContent =
            assistantResponse.length > 0 || toolTimeline.length > 0 || draftSections.length > 0;
          if (!hasDraftContent) {
            return;
          }
          conversation.messages = [
            ...historyMessages,
            { role: "user", content: messageText },
            {
              role: "assistant",
              content: assistantResponse,
              metadata:
                toolTimeline.length > 0 || draftSections.length > 0
                  ? ({
                      toolActivity: [...toolTimeline],
                      sections: draftSections.length > 0 ? draftSections : undefined,
                    } as Message["metadata"])
                  : undefined,
            },
          ];
          conversation.updatedAt = Date.now();
          await conversationStore.update(conversation);
        };

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

        for await (const event of harness.runWithTelemetry({
          task: messageText,
          parameters: {
            ...(body.parameters ?? {}),
            __conversationRecallCorpus: recallCorpus,
            __activeConversationId: conversationId,
          },
          messages: historyMessages,
          abortSignal: abortController.signal,
        })) {
          if (event.type === "run:started") {
            latestRunId = event.runId;
            runOwners.set(event.runId, ownerId);
            runConversations.set(event.runId, conversationId);
            const active = activeConversationRuns.get(conversationId);
            if (active && active.abortController === abortController) {
              active.runId = event.runId;
            }
          }
          if (event.type === "run:cancelled") {
            runCancelled = true;
          }
          if (event.type === "model:chunk") {
            // If we have tools accumulated and text starts again, push tools as a section
            if (currentTools.length > 0) {
              sections.push({ type: "tools", content: currentTools });
              currentTools = [];
            }
            assistantResponse += event.content;
            currentText += event.content;
          }
          if (event.type === "tool:started") {
            // If we have text accumulated, push it as a text section
            if (currentText.length > 0) {
              sections.push({ type: "text", content: currentText });
              currentText = "";
            }
            const toolText = `- start \`${event.tool}\``;
            toolTimeline.push(toolText);
            currentTools.push(toolText);
          }
          if (event.type === "tool:completed") {
            const toolText = `- done \`${event.tool}\` (${event.duration}ms)`;
            toolTimeline.push(toolText);
            currentTools.push(toolText);
          }
          if (event.type === "tool:error") {
            const toolText = `- error \`${event.tool}\`: ${event.error}`;
            toolTimeline.push(toolText);
            currentTools.push(toolText);
          }
          if (event.type === "step:completed") {
            await persistDraftAssistantTurn();
          }
          if (event.type === "tool:approval:required") {
            const toolText = `- approval required \`${event.tool}\``;
            toolTimeline.push(toolText);
            currentTools.push(toolText);
            await persistDraftAssistantTurn();
          }
          if (event.type === "tool:approval:granted") {
            const toolText = `- approval granted (${event.approvalId})`;
            toolTimeline.push(toolText);
            currentTools.push(toolText);
            await persistDraftAssistantTurn();
          }
          if (event.type === "tool:approval:denied") {
            const toolText = `- approval denied (${event.approvalId})`;
            toolTimeline.push(toolText);
            currentTools.push(toolText);
            await persistDraftAssistantTurn();
          }
          if (
            event.type === "run:completed" &&
            assistantResponse.length === 0 &&
            event.result.response
          ) {
            assistantResponse = event.result.response;
          }
          await telemetry.emit(event);
          broadcastEvent(conversationId, event);
          try {
            response.write(formatSseEvent(event));
          } catch {
            // Client disconnected (e.g. browser refresh). Continue processing
            // so the run completes and conversation is persisted.
          }
        }
        // Finalize sections
        if (currentTools.length > 0) {
          sections.push({ type: "tools", content: currentTools });
        }
        if (currentText.length > 0) {
          sections.push({ type: "text", content: currentText });
        }
        const hasAssistantContent =
          assistantResponse.length > 0 || toolTimeline.length > 0 || sections.length > 0;
        conversation.messages = hasAssistantContent
          ? [
              ...historyMessages,
              { role: "user", content: messageText },
              {
                role: "assistant",
                content: assistantResponse,
                metadata:
                  toolTimeline.length > 0 || sections.length > 0
                    ? ({
                        toolActivity: toolTimeline,
                        sections: sections.length > 0 ? sections : undefined,
                      } as Message["metadata"])
                    : undefined,
              },
            ]
          : [...historyMessages, { role: "user", content: messageText }];
        conversation.runtimeRunId = latestRunId || conversation.runtimeRunId;
        conversation.pendingApprovals = [];
        conversation.updatedAt = Date.now();
        await conversationStore.update(conversation);
      } catch (error) {
        if (abortController.signal.aborted || runCancelled) {
          const fallbackSections = [...sections];
          if (currentTools.length > 0) {
            fallbackSections.push({ type: "tools", content: [...currentTools] });
          }
          if (currentText.length > 0) {
            fallbackSections.push({ type: "text", content: currentText });
          }
          if (assistantResponse.length > 0 || toolTimeline.length > 0 || fallbackSections.length > 0) {
            conversation.messages = [
              ...historyMessages,
              { role: "user", content: messageText },
              {
                role: "assistant",
                content: assistantResponse,
                metadata:
                  toolTimeline.length > 0 || fallbackSections.length > 0
                    ? ({
                        toolActivity: [...toolTimeline],
                        sections: fallbackSections.length > 0 ? fallbackSections : undefined,
                      } as Message["metadata"])
                    : undefined,
              },
            ];
            conversation.updatedAt = Date.now();
            await conversationStore.update(conversation);
          }
          await clearPendingApprovalsForConversation(conversationId);
          return;
        }
        try {
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
        } catch {
          // Client already disconnected; persist whatever we accumulated.
          const fallbackSections = [...sections];
          if (currentTools.length > 0) {
            fallbackSections.push({ type: "tools", content: [...currentTools] });
          }
          if (currentText.length > 0) {
            fallbackSections.push({ type: "text", content: currentText });
          }
          if (assistantResponse.length > 0 || toolTimeline.length > 0 || fallbackSections.length > 0) {
            conversation.messages = [
              ...historyMessages,
              { role: "user", content: messageText },
              {
                role: "assistant",
                content: assistantResponse,
                metadata:
                  toolTimeline.length > 0 || fallbackSections.length > 0
                    ? ({
                        toolActivity: [...toolTimeline],
                        sections: fallbackSections.length > 0 ? fallbackSections : undefined,
                      } as Message["metadata"])
                    : undefined,
              },
            ];
            conversation.updatedAt = Date.now();
            await conversationStore.update(conversation);
          }
        }
      } finally {
        const active = activeConversationRuns.get(conversationId);
        if (active && active.abortController === abortController) {
          activeConversationRuns.delete(conversationId);
        }
        finishConversationStream(conversationId);
        await persistConversationPendingApprovals(conversationId);
        if (latestRunId) {
          runOwners.delete(latestRunId);
          runConversations.delete(latestRunId);
        }
        try {
          response.end();
        } catch {
          // Already closed.
        }
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

  for await (const event of harness.runWithTelemetry(input)) {
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
    if (event.type === "run:cancelled") {
      process.stdout.write("\n");
      process.stderr.write("Run cancelled.\n");
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
  const identity = await ensureAgentIdentity(workingDir);
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
      conversationStore: createConversationStore(resolveStateConfig(config), {
        workingDir,
        agentId: identity.id,
      }),
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

const normalizeSkillSourceName = (value: string): string => {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^@/, "")
    .replace(/[\/\s]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : "skills";
};

const collectSkillManifests = async (dir: string, depth = 2): Promise<string[]> => {
  const manifests: string[] = [];
  const localManifest = resolve(dir, "SKILL.md");
  try {
    await access(localManifest);
    manifests.push(localManifest);
  } catch {
    // Not found at this level — look one level deeper (e.g. skills/<name>/SKILL.md)
  }

  if (depth <= 0) return manifests;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      let isDir = entry.isDirectory();
      // Dirent reports symlinks separately; resolve target type via stat()
      if (!isDir && entry.isSymbolicLink()) {
        try {
          const s = await stat(resolve(dir, entry.name));
          isDir = s.isDirectory();
        } catch {
          continue; // broken symlink — skip
        }
      }

      if (isDir) {
        manifests.push(...(await collectSkillManifests(resolve(dir, entry.name), depth - 1)));
      }
    }
  } catch {
    // ignore read errors
  }

  return manifests;
};

const validateSkillPackage = async (
  workingDir: string,
  packageNameOrPath: string,
): Promise<{ skillRoot: string; manifests: string[] }> => {
  const skillRoot = resolveSkillRoot(workingDir, packageNameOrPath);
  const manifests = await collectSkillManifests(skillRoot);
  if (manifests.length === 0) {
    throw new Error(`Skill validation failed: no SKILL.md found in ${skillRoot}`);
  }
  return { skillRoot, manifests };
};

const selectSkillManifests = async (
  skillRoot: string,
  manifests: string[],
  relativeSkillPath?: string,
): Promise<string[]> => {
  if (!relativeSkillPath) return manifests;

  const normalized = normalize(relativeSkillPath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    throw new Error(`Invalid skill path "${relativeSkillPath}": path must be within package root.`);
  }

  const candidate = resolve(skillRoot, normalized);
  const relativeToRoot = relative(skillRoot, candidate).split("\\").join("/");
  if (relativeToRoot.startsWith("..") || relativeToRoot.startsWith("/")) {
    throw new Error(`Invalid skill path "${relativeSkillPath}": path escapes package root.`);
  }

  const candidateAsFile = candidate.toLowerCase().endsWith("skill.md")
    ? candidate
    : resolve(candidate, "SKILL.md");
  if (!existsSync(candidateAsFile)) {
    throw new Error(
      `Skill path "${relativeSkillPath}" does not point to a directory (or file) containing SKILL.md.`,
    );
  }

  const selected = manifests.filter((manifest) => resolve(manifest) === resolve(candidateAsFile));
  if (selected.length === 0) {
    throw new Error(`Skill path "${relativeSkillPath}" was not discovered as a valid skill manifest.`);
  }
  return selected;
};

const copySkillsIntoProject = async (
  workingDir: string,
  manifests: string[],
  sourceName: string,
): Promise<string[]> => {
  const skillsDir = resolve(workingDir, "skills", normalizeSkillSourceName(sourceName));
  await mkdir(skillsDir, { recursive: true });

  const destinations = new Map<string, string>();
  for (const manifest of manifests) {
    const sourceSkillDir = dirname(manifest);
    const skillFolderName = basename(sourceSkillDir);
    if (destinations.has(skillFolderName)) {
      throw new Error(
        `Skill copy failed: multiple skill directories map to "skills/${skillFolderName}" (${destinations.get(skillFolderName)} and ${sourceSkillDir}).`,
      );
    }
    destinations.set(skillFolderName, sourceSkillDir);
  }

  const copied: string[] = [];
  for (const [skillFolderName, sourceSkillDir] of destinations.entries()) {
    const destinationSkillDir = resolve(skillsDir, skillFolderName);
    if (existsSync(destinationSkillDir)) {
      throw new Error(
        `Skill copy failed: destination already exists at ${destinationSkillDir}. Remove or rename it and try again.`,
      );
    }
    await cp(sourceSkillDir, destinationSkillDir, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
    });
    copied.push(relative(workingDir, destinationSkillDir).split("\\").join("/"));
  }

  return copied.sort();
};

export const copySkillsFromPackage = async (
  workingDir: string,
  packageNameOrPath: string,
  options?: { path?: string },
): Promise<string[]> => {
  const { skillRoot, manifests } = await validateSkillPackage(workingDir, packageNameOrPath);
  const selected = await selectSkillManifests(skillRoot, manifests, options?.path);
  const sourceName = resolveInstalledPackageName(packageNameOrPath) ?? basename(skillRoot);
  return await copySkillsIntoProject(workingDir, selected, sourceName);
};

export const addSkill = async (
  workingDir: string,
  packageNameOrPath: string,
  options?: { path?: string },
): Promise<void> => {
  await runInstallCommand(workingDir, packageNameOrPath);
  const copiedSkills = await copySkillsFromPackage(workingDir, packageNameOrPath, options);
  process.stdout.write(
    `Added ${copiedSkills.length} skill${copiedSkills.length === 1 ? "" : "s"} from ${packageNameOrPath}:\n`,
  );
  for (const copied of copiedSkills) {
    process.stdout.write(`- ${copied}\n`);
  }
};

const getSkillFolderNames = (manifests: string[]): string[] => {
  const names = new Set<string>();
  for (const manifest of manifests) {
    names.add(basename(dirname(manifest)));
  }
  return Array.from(names).sort();
};

export const removeSkillsFromPackage = async (
  workingDir: string,
  packageNameOrPath: string,
  options?: { path?: string },
): Promise<{ removed: string[]; missing: string[] }> => {
  const { skillRoot, manifests } = await validateSkillPackage(workingDir, packageNameOrPath);
  const selected = await selectSkillManifests(skillRoot, manifests, options?.path);
  const skillsDir = resolve(workingDir, "skills");
  const sourceName = normalizeSkillSourceName(
    resolveInstalledPackageName(packageNameOrPath) ?? basename(skillRoot),
  );
  const sourceSkillsDir = resolve(skillsDir, sourceName);
  const skillNames = getSkillFolderNames(selected);

  const removed: string[] = [];
  const missing: string[] = [];

  if (!options?.path && existsSync(sourceSkillsDir)) {
    await rm(sourceSkillsDir, { recursive: true, force: false });
    removed.push(`skills/${sourceName}`);
    return { removed, missing };
  }

  for (const skillName of skillNames) {
    const destinationSkillDir = resolve(sourceSkillsDir, skillName);
    const normalized = relative(skillsDir, destinationSkillDir).split("\\").join("/");
    if (normalized.startsWith("..") || normalized.startsWith("/")) {
      throw new Error(`Refusing to remove path outside skills directory: ${destinationSkillDir}`);
    }

    if (!existsSync(destinationSkillDir)) {
      missing.push(`skills/${sourceName}/${skillName}`);
      continue;
    }

    await rm(destinationSkillDir, { recursive: true, force: false });
    removed.push(`skills/${sourceName}/${skillName}`);
  }

  return { removed, missing };
};

export const removeSkillPackage = async (
  workingDir: string,
  packageNameOrPath: string,
  options?: { path?: string },
): Promise<void> => {
  const result = await removeSkillsFromPackage(workingDir, packageNameOrPath, options);
  process.stdout.write(
    `Removed ${result.removed.length} skill${result.removed.length === 1 ? "" : "s"} from ${packageNameOrPath}:\n`,
  );
  for (const removed of result.removed) {
    process.stdout.write(`- ${removed}\n`);
  }
  if (result.missing.length > 0) {
    process.stdout.write(
      `Skipped ${result.missing.length} missing skill${result.missing.length === 1 ? "" : "s"}:\n`,
    );
    for (const missing of result.missing) {
      process.stdout.write(`- ${missing}\n`);
    }
  }
};

export const listInstalledSkills = async (
  workingDir: string,
  sourceName?: string,
): Promise<string[]> => {
  const skillsRoot = resolve(workingDir, "skills");
  const resolvedSourceName = sourceName
    ? resolveInstalledPackageName(sourceName) ?? sourceName
    : undefined;
  const targetRoot = sourceName
    ? resolve(skillsRoot, normalizeSkillSourceName(resolvedSourceName ?? sourceName))
    : skillsRoot;
  if (!existsSync(targetRoot)) {
    return [];
  }
  const manifests = await collectSkillManifests(targetRoot, sourceName ? 1 : 2);
  return manifests
    .map((manifest) => relative(workingDir, dirname(manifest)).split("\\").join("/"))
    .sort();
};

export const listSkills = async (workingDir: string, sourceName?: string): Promise<void> => {
  const skills = await listInstalledSkills(workingDir, sourceName);
  if (skills.length === 0) {
    process.stdout.write("No installed skills found.\n");
    return;
  }
  const resolvedSourceName = sourceName
    ? resolveInstalledPackageName(sourceName) ?? sourceName
    : undefined;
  process.stdout.write(
    sourceName
      ? `Installed skills for ${normalizeSkillSourceName(resolvedSourceName ?? sourceName)}:\n`
      : "Installed skills:\n",
  );
  for (const skill of skills) {
    process.stdout.write(`- ${skill}\n`);
  }
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

export const buildTarget = async (
  workingDir: string,
  target: string,
  options?: { force?: boolean },
): Promise<void> => {
  const normalizedTarget = normalizeDeployTarget(target);
  const writtenPaths = await scaffoldDeployTarget(workingDir, normalizedTarget, {
    force: options?.force,
  });
  process.stdout.write(`Scaffolded deploy files for ${normalizedTarget}:\n`);
  for (const filePath of writtenPaths) {
    process.stdout.write(`  - ${filePath}\n`);
  }
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
    return;
  }
  process.stdout.write("Configured MCP servers:\n");
  for (const entry of mcp) {
    const auth =
      entry.auth?.type === "bearer" ? `auth=bearer:${entry.auth.tokenEnv}` : "auth=none";
    process.stdout.write(
      `- ${entry.name ?? entry.url} (remote: ${entry.url}, ${auth})\n`,
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
  process.stdout.write(`Selected MCP tools: ${includePatterns.join(", ")}\n`);
  process.stdout.write(
    "\nRequired next step: add MCP intent in AGENT.md or SKILL.md allowed-tools. Without this, these MCP tools will not be registered for the model.\n",
  );
  process.stdout.write(
    "\nOption A: AGENT.md (global fallback intent)\n" +
      "Paste this into AGENT.md frontmatter:\n" +
      "---\n" +
      "allowed-tools:\n" +
      includePatterns.map((tool) => `  - mcp:${tool}`).join("\n") +
      "\n---\n",
  );
  process.stdout.write(
    "\nOption B: SKILL.md (only when that skill is activated)\n" +
      "Paste this into SKILL.md frontmatter:\n" +
      "---\n" +
      "allowed-tools:\n" +
      includePatterns.map((tool) => `  - mcp:${tool}`).join("\n") +
      "\napproval-required:\n" +
      includePatterns.map((tool) => `  - mcp:${tool}`).join("\n") +
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

  const skillsCommand = program.command("skills").description("Manage installed skills");
  skillsCommand
    .command("add")
    .argument("<source>", "skill package name/path")
    .argument("[skillPath]", "optional path to one specific skill within source")
    .description("Install and copy skills into ./skills/<source>/...")
    .action(async (source: string, skillPath?: string) => {
      await addSkill(process.cwd(), source, { path: skillPath });
    });

  skillsCommand
    .command("remove")
    .argument("<source>", "skill package name/path")
    .argument("[skillPath]", "optional path to one specific skill within source")
    .description("Remove installed skills from ./skills/<source>/...")
    .action(async (source: string, skillPath?: string) => {
      await removeSkillPackage(process.cwd(), source, { path: skillPath });
    });

  skillsCommand
    .command("list")
    .argument("[source]", "optional source package/folder")
    .description("List installed skills")
    .action(async (source?: string) => {
      await listSkills(process.cwd(), source);
    });

  program
    .command("add")
    .argument("<packageOrPath>", "skill package name/path")
    .option("--path <relativePath>", "only copy a specific skill path from the package")
    .description("Alias for `poncho skills add <source> [skillPath]`")
    .action(async (packageOrPath: string, options: { path?: string }) => {
      await addSkill(process.cwd(), packageOrPath, { path: options.path });
    });

  program
    .command("remove")
    .argument("<packageOrPath>", "skill package name/path")
    .option("--path <relativePath>", "only remove a specific skill path from the package")
    .description("Alias for `poncho skills remove <source> [skillPath]`")
    .action(async (packageOrPath: string, options: { path?: string }) => {
      await removeSkillPackage(process.cwd(), packageOrPath, { path: options.path });
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
    .option("--force", "overwrite existing deployment files")
    .description("Scaffold deployment files for a target")
    .action(async (target: string, options: { force?: boolean }) => {
      await buildTarget(process.cwd(), target, { force: options.force });
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
    .description("Select MCP tools and print frontmatter allowed-tools entries")
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
