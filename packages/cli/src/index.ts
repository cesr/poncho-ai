import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, watch as fsWatch } from "node:fs";
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
  createConversationStoreFromEngine,
  createUploadStore,
  deriveUploadKey,
  ensureAgentIdentity,
  generateAgentId,
  loadPonchoConfig,
  parseAgentMarkdown,
  resolveStateConfig,
  type CronJobConfig,
  type PonchoConfig,
  type Conversation,
  type ConversationStore,
  type ConversationSummary,
  verifyTenantToken,
  createSecretsStore,
  computeNextOccurrence,
  loadCanonicalHistory,
  resolveRunRequest,
  createTurnDraftState,
  cloneSections,
  flushTurnDraft,
  buildAssistantMetadata,
  executeConversationTurn,
  normalizeApprovalCheckpoint,
  buildApprovalCheckpoints,
  applyTurnMetadata,
  TOOL_RESULT_ARCHIVE_PARAM,
  withToolResultArchiveParam,
  AgentOrchestrator,
} from "@poncho-ai/harness";
import type { AgentEvent, FileInput, Message, RunInput } from "@poncho-ai/sdk";
import type {
  ApiApprovalResponse,
  ApiCompactResponse,
  ApiSlashCommand,
  ApiStopRunResponse,
  ApiSubagentSummary,
} from "@poncho-ai/sdk";
import { getTextContent } from "@poncho-ai/sdk";
import {
  AgentBridge,
  ResendAdapter,
  SlackAdapter,
  TelegramAdapter,
  type AgentRunner,
  type MessagingAdapter,
  type RouteRegistrar,
} from "@poncho-ai/messaging";
import Busboy from "busboy";
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
import { buildOpenApiSpec, renderApiDocsHtml } from "./api-docs.js";
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
import {
  exportOpenAICodex,
  loginOpenAICodex,
  logoutOpenAICodex,
  statusOpenAICodex,
} from "./auth-codex.js";

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

const EXT_MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", txt: "text/plain",
  json: "application/json", csv: "text/csv", html: "text/html",
};
const extToMime = (ext: string): string => EXT_MIME_MAP[ext] ?? "application/octet-stream";
// TOOL_RESULT_ARCHIVE_PARAM, withToolResultArchiveParam — imported from @poncho-ai/harness/orchestrator

const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.length > 0 ? (JSON.parse(body) as unknown) : {};
};

const parseTelegramMessageThreadIdFromPlatformThreadId = (
  platformThreadId: string | undefined,
  chatId: string | undefined,
): number | undefined => {
  if (!platformThreadId || !chatId) return undefined;
  const parts = platformThreadId.split(":");
  if (parts.length !== 3 || parts[0] !== chatId) return undefined;
  const threadId = Number(parts[1]);
  return Number.isInteger(threadId) ? threadId : undefined;
};

const MAX_UPLOAD_SIZE = 25 * 1024 * 1024; // 25MB per file

interface ParsedMultipart {
  message: string;
  parameters?: Record<string, unknown>;
  files: FileInput[];
}

const parseMultipartRequest = (request: IncomingMessage): Promise<ParsedMultipart> =>
  new Promise((resolve, reject) => {
    const result: ParsedMultipart = { message: "", files: [] };
    const bb = Busboy({
      headers: request.headers,
      limits: { fileSize: MAX_UPLOAD_SIZE },
    });

    bb.on("field", (name: string, value: string) => {
      if (name === "message") result.message = value;
      if (name === "parameters") {
        try {
          result.parameters = JSON.parse(value) as Record<string, unknown>;
        } catch { /* ignore malformed parameters */ }
      }
    });

    bb.on("file", (_name: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const buf = Buffer.concat(chunks);
        result.files.push({
          data: buf.toString("base64"),
          mediaType: info.mimeType,
          filename: info.filename,
        });
      });
    });

    bb.on("finish", () => resolve(result));
    bb.on("error", (err: Error) => reject(err));
    request.pipe(bb);
  });

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

const normalizeMessageForClient = (message: Message): Message | null => {
  // Hide tool-role and system-role messages from the web UI — they are
  // internal harness bookkeeping that leaks into conv.messages when
  // _harnessMessages are used as canonical history.
  if (message.role === "tool" || message.role === "system") {
    return null;
  }
  if (message.role !== "assistant" || typeof message.content !== "string") {
    return message;
  }
  try {
    const parsed = JSON.parse(message.content) as Record<string, unknown>;
    const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : undefined;
    if (toolCalls) {
      const text = typeof parsed.text === "string" ? parsed.text : "";
      const meta = { ...(message.metadata ?? {}) } as Record<string, unknown>;
      if (!meta.sections && toolCalls.length > 0) {
        const toolLabels = toolCalls.map((tc: Record<string, unknown>) => {
          const name = typeof tc.name === "string" ? tc.name : "tool";
          return `✓ ${name}`;
        });
        const sections: { type: string; content: string | string[] }[] = [];
        if (toolLabels.length > 0) sections.push({ type: "tools", content: toolLabels });
        if (text) sections.push({ type: "text", content: text });
        meta.sections = sections;
      }
      return {
        ...message,
        content: text,
        metadata: meta as Message["metadata"],
      };
    }
  } catch {
    // Keep original assistant content when it's plain text or non-JSON.
  }
  return message;
};

// isMessageArray, loadCanonicalHistory, loadRunHistory — imported from @poncho-ai/harness/orchestrator

// Turn types, helpers, approval checkpoints — imported from @poncho-ai/harness/orchestrator

// ── Shared cron helpers ──────────────────────────────────────────
// Used by both the HTTP /api/cron endpoint and the local-dev scheduler.

type CronRunResult = {
  response: string;
  steps: number;
  assistantMetadata?: Message["metadata"];
  hasContent: boolean;
  contextTokens: number;
  contextWindow: number;
  harnessMessages?: Message[];
  toolResultArchive?: Conversation["_toolResultArchive"];
  latestRunId: string;
  continuation: boolean;
  continuationMessages?: Message[];
};

const runCronAgent = async (
  harnessRef: AgentHarness,
  task: string,
  conversationId: string,
  historyMessages: Message[],
  toolResultArchive?: Conversation["_toolResultArchive"],
  onEvent?: (event: AgentEvent) => void | Promise<void>,
): Promise<CronRunResult> => {
  const execution = await executeConversationTurn({
    harness: harnessRef,
    runInput: {
      task,
      conversationId,
      parameters: {
        __activeConversationId: conversationId,
        [TOOL_RESULT_ARCHIVE_PARAM]: toolResultArchive ?? {},
      },
      messages: historyMessages,
    },
    onEvent,
  });
  flushTurnDraft(execution.draft);
  const hasContent = execution.draft.assistantResponse.length > 0 || execution.draft.toolTimeline.length > 0;
  const assistantMetadata = buildAssistantMetadata(execution.draft);
  return {
    response: execution.draft.assistantResponse,
    steps: execution.runSteps,
    assistantMetadata,
    hasContent,
    contextTokens: execution.runContextTokens,
    contextWindow: execution.runContextWindow,
    harnessMessages: execution.runHarnessMessages,
    toolResultArchive: harnessRef.getToolResultArchive(conversationId),
    latestRunId: execution.latestRunId,
    continuation: execution.runContinuation,
    continuationMessages: execution.runContinuationMessages,
  };
};

const buildCronMessages = (
  task: string,
  historyMessages: Message[],
  result: CronRunResult,
): Message[] => [
  ...historyMessages,
  { role: "user" as const, content: task },
  ...(result.hasContent
    ? [{ role: "assistant" as const, content: result.response, metadata: result.assistantMetadata }]
    : []),
];

/** Append a cron turn to a freshly-fetched conversation (avoids overwriting concurrent writes). */
const appendCronTurn = (conv: Conversation, task: string, result: CronRunResult): void => {
  conv.messages.push(
    { role: "user" as const, content: task },
    ...(result.hasContent
      ? [{ role: "assistant" as const, content: result.response, metadata: result.assistantMetadata }]
      : []),
  );
};

const MAX_PRUNE_PER_RUN = 25;

/** Delete old cron conversations beyond `maxRuns`, capped to avoid API storms on catch-up. */
const pruneCronConversations = async (
  store: ConversationStore,
  ownerId: string,
  jobName: string,
  maxRuns: number,
): Promise<number> => {
  const summaries = await store.listSummaries(ownerId);
  const cronPrefix = `[cron] ${jobName} `;
  const cronSummaries = summaries
    .filter((s) => s.title?.startsWith(cronPrefix))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  if (cronSummaries.length <= maxRuns) return 0;

  const toDelete = cronSummaries.slice(maxRuns, maxRuns + MAX_PRUNE_PER_RUN);
  let deleted = 0;
  for (const s of toDelete) {
    try {
      if (await store.delete(s.conversationId)) deleted++;
    } catch { /* best-effort per entry */ }
  }
  return deleted;
};

const AGENT_TEMPLATE = (
  name: string,
  id: string,
  options: { modelProvider: "anthropic" | "openai" | "openai-codex"; modelName: string },
): string => `---
name: ${name}
id: ${id}
description: A helpful Poncho assistant
model:
  provider: ${options.modelProvider}
  name: ${options.modelName}
  temperature: 0.2
limits:
  maxSteps: 20
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
 * Resolve the @poncho-ai/cli dependency specifier for the scaffolded project.
 * In dev mode we use `link:` so pnpm can resolve the local package;
 * in production we point at the npm registry.
 */
const resolveCliDep = async (projectDir: string): Promise<string> => {
  const packagesRoot = resolveLocalPackagesRoot();
  if (packagesRoot) {
    const cliAbs = resolve(packagesRoot, "cli");
    return `link:${relative(projectDir, cliAbs)}`;
  }
  const version = await readCliVersion();
  return `^${version}`;
};

const PACKAGE_TEMPLATE = async (name: string, projectDir: string): Promise<string> => {
  const cliDep = await resolveCliDep(projectDir);
  return JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        dev: "poncho dev",
        start: "poncho dev",
        test: "poncho test",
      },
      dependencies: {
        "@poncho-ai/cli": cliDep,
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
- Anthropic API key, OpenAI API key, or OpenAI Codex OAuth refresh token

## Quick Start

\`\`\`bash
npm install
# If you didn't enter credentials during init:
cp .env.example .env
# Then edit .env and add provider credentials
poncho dev
\`\`\`

For OpenAI Codex OAuth bootstrap:

\`\`\`bash
poncho auth login --provider openai-codex --device
poncho auth export --provider openai-codex --format env
\`\`\`

Open \`http://localhost:3000\` for the web UI, or \`http://localhost:3000/api/docs\` for interactive API documentation.

The web UI supports file attachments (drag-and-drop, paste, or attach button), conversation management (sidebar), a context window usage ring, and tool approval prompts. It can be installed as a PWA.

On your first interactive session, the agent introduces its configurable capabilities.
While a response is streaming, you can stop it:
- Web UI: click the send button again (it switches to a stop icon)
- Interactive CLI: press \`Ctrl+C\`

Stopping is best-effort and keeps partial assistant output/tool activity already produced.

Interactive CLI commands: \`/help\`, \`/clear\`, \`/tools\`, \`/exit\`, \`/attach <path>\`, \`/files\`, \`/list\`, \`/open <id>\`, \`/new [title]\`, \`/delete [id]\`, \`/continue\`, \`/compact [focus]\`, \`/reset [all]\`.

## Common Commands

\`\`\`bash
# Local web UI + API server
poncho dev
poncho dev --port 8080

# Local interactive CLI
poncho run --interactive

# One-off run
poncho run "Your task here"
poncho run "Explain this code" --file ./src/index.ts
poncho run "Review the code" --param projectName=my-app

# Run tests
poncho test

# List available tools
poncho tools

# OpenAI Codex auth (OAuth subscription)
poncho auth login --provider openai-codex --device
poncho auth status --provider openai-codex
poncho auth export --provider openai-codex --format env

# Remove deprecated guidance from AGENT.md after upgrading
poncho update-agent

# Multi-tenancy: create a tenant token
poncho auth create-token --tenant acme-corp --ttl 24h

# Manage per-tenant secrets
poncho secrets set --tenant acme-corp LINEAR_API_KEY lk_123
poncho secrets list --tenant acme-corp
poncho secrets delete --tenant acme-corp LINEAR_API_KEY
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

# Server with custom headers (e.g. Arcade)
poncho mcp add --url https://mcp.arcade.dev --name arcade \\
  --auth-bearer-env ARCADE_API_KEY --header "Arcade-User-ID: user@example.com"

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

Pattern format:

- MCP: \`mcp:server/tool\`, \`mcp:server/*\` (protocol-like prefix)
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
- \`.env\`: secrets and environment variables (loaded before the harness starts, so \`process.env\` is available in skill scripts)

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
    // Custom headers for servers that require them (e.g. Arcade)
    // { name: "arcade", url: "https://mcp.arcade.dev", auth: { type: "bearer", tokenEnv: "ARCADE_API_KEY" }, headers: { "Arcade-User-ID": "user@example.com" } },
  ],
  // Tool access: true (available), false (disabled), 'approval' (requires human approval)
  tools: {
    list_directory: true,
    read_file: true,
    write_file: true,           // gated by environment for writes
    edit_file: true,            // gated by environment for writes
    delete_file: 'approval',    // requires human approval
    delete_directory: 'approval', // requires human approval
    send_email: 'approval',     // requires human approval
    byEnvironment: {
      production: {
        write_file: false,
        edit_file: false,
        delete_file: false,
        delete_directory: false,
      },
      development: {
        send_email: true,       // skip approval in dev
      },
    },
  },
  // browser: true, // Enable browser automation tools (requires @poncho-ai/browser)
  // browser: { provider: 'browserbase' }, // Cloud browser for serverless (Vercel, Lambda)
  // webUi: false, // Disable built-in UI for API-only deployments
  // uploads: { provider: 'local' }, // 'local' | 'vercel-blob' | 's3'
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

## Cron Jobs

Define scheduled tasks in \`AGENT.md\` frontmatter:

\`\`\`yaml
cron:
  daily-report:
    schedule: "0 9 * * *"
    task: "Generate the daily sales report"
  morning-checkin:
    schedule: "0 8 * * 1-5"
    task: "Check in with the user about their day"
    channel: telegram
\`\`\`

- \`poncho dev\`: jobs run via an in-process scheduler.
- \`poncho build vercel\`: generates \`vercel.json\` cron entries. Set \`CRON_SECRET\` to the same value as \`PONCHO_AUTH_TOKEN\` so Vercel can authenticate.
- Docker/Fly.io: scheduler runs automatically.
- Lambda: use AWS EventBridge to trigger \`GET /api/cron/<jobName>\` with \`Authorization: Bearer <token>\`.
- Trigger manually: \`curl http://localhost:3000/api/cron/daily-report\`

Add \`channel: telegram\` (or another platform) to have the agent proactively send the response to all known chats on that platform. The bot must have received at least one message from each user first.

## Reminders

One-off reminders are enabled by default. The agent gets \`set_reminder\`, \`list_reminders\`, and \`cancel_reminder\` tools. Users can say things like "remind me tomorrow at 9am to check the report."

Configure in \`poncho.config.js\`:

\`\`\`javascript
export default {
  reminders: {
    enabled: true,
    pollSchedule: '*/10 * * * *', // how often to check for due reminders
  },
};
\`\`\`

- Reminders fire via a polling loop (same interval locally and on serverless).
- On Vercel, \`poncho build vercel\` adds a cron entry for \`/api/reminders/check\`.
- Channel reminders (Telegram/Slack) reply in the original conversation.
- Non-channel reminders create a new \`[reminder]\` conversation visible in the web UI.

## Messaging (Slack)

Connect your agent to Slack so it responds to @mentions:

1. Create a Slack App at [api.slack.com/apps](https://api.slack.com/apps)
2. Add Bot Token Scopes: \`app_mentions:read\`, \`chat:write\`, \`reactions:write\`
3. Enable Event Subscriptions, set Request URL to \`https://<your-url>/api/messaging/slack\`, subscribe to \`app_mention\`
4. Install to workspace, copy Bot Token and Signing Secret
5. Set env vars:
   \`\`\`
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_SIGNING_SECRET=...
   \`\`\`
6. Add to \`poncho.config.js\`:
   \`\`\`javascript
   messaging: [{ platform: 'slack' }]
   \`\`\`

**Vercel deployments:** install \`@vercel/functions\` so Poncho can keep the serverless function alive while processing: \`npm install @vercel/functions\`

## Messaging (Telegram)

Connect your agent to Telegram so it responds to messages and @mentions:

1. Talk to [@BotFather](https://t.me/BotFather) on Telegram, send \`/newbot\`, and follow the prompts
2. Copy the Bot Token
3. Set env vars:
   \`\`\`
   TELEGRAM_BOT_TOKEN=123456:ABC-...
   TELEGRAM_WEBHOOK_SECRET=my-secret-token   # optional but recommended
   \`\`\`
4. Add to \`poncho.config.js\`:
   \`\`\`javascript
   messaging: [{ platform: 'telegram' }]
   \`\`\`
5. Register the webhook after deploying:
   \`\`\`bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \\
     -H "Content-Type: application/json" \\
     -d '{"url": "https://<your-url>/api/messaging/telegram", "secret_token": "<SECRET>"}'
   \`\`\`

The bot responds to all messages in private chats and only to @mentions in groups. Use \`/new\` to reset the conversation.

**Vercel deployments:** install \`@vercel/functions\` so Poncho can keep the serverless function alive while processing: \`npm install @vercel/functions\`

## Messaging (Email via Resend)

Connect your agent to email so users can interact by sending emails:

1. Set up a domain and enable Inbound at [resend.com](https://resend.com)
2. Create a webhook for \`email.received\` pointing to \`https://<your-url>/api/messaging/resend\`
3. Install the Resend SDK: \`npm install resend\`
4. Set env vars:
   \`\`\`
   RESEND_API_KEY=re_...
   RESEND_WEBHOOK_SECRET=whsec_...
   RESEND_FROM=Agent <agent@yourdomain.com>
   RESEND_REPLY_TO=support@yourdomain.com   # optional
   \`\`\`
5. Add to \`poncho.config.js\`:
   \`\`\`javascript
   messaging: [{ platform: 'resend' }]
   \`\`\`

For full control over outbound emails, use **tool mode** (\`mode: 'tool'\`) — the agent gets a \`send_email\` tool instead of auto-replying. See the repo README for details.

**Vercel deployments:** install \`@vercel/functions\` so Poncho can keep the serverless function alive while processing: \`npm install @vercel/functions\`

## Subagents

Your agent can spawn **subagents** — independent background tasks that run in their own conversations. Subagents are useful for parallelizing work or isolating subtasks.

The agent gets four tools automatically: \`spawn_subagent\` (create and run a subagent), \`message_subagent\` (send follow-ups), \`stop_subagent\`, and \`list_subagents\`. Calls return immediately — subagents run in the background and their results are delivered to the parent automatically.

- **Limits**: subagents cannot spawn other subagents; max 5 concurrent per parent.
- **Memory**: subagents have read-only access to the parent's persistent memory.
- **Approvals**: subagent tool approvals are tunneled to the parent conversation thread.
- **Web UI**: subagent conversations appear nested under the parent in the sidebar.

## Deployment

\`\`\`bash
# Build for Vercel
poncho build vercel
vercel deploy --prod

# Build for Docker
poncho build docker
docker build -t ${name} .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=sk-ant-... ${name}

# AWS Lambda
poncho build lambda

# Fly.io
poncho build fly
fly deploy
\`\`\`

Set environment variables on your deployment platform:

\`\`\`bash
ANTHROPIC_API_KEY=sk-ant-...   # Required
# OR for OpenAI API key provider:
# OPENAI_API_KEY=sk-...
# OR for OpenAI Codex OAuth provider:
# OPENAI_CODEX_REFRESH_TOKEN=rt_...
# OPENAI_CODEX_ACCOUNT_ID=...   # Optional
PONCHO_AUTH_TOKEN=your-secret  # Optional: protect your endpoint
PONCHO_MAX_DURATION=55         # Optional: serverless timeout in seconds (enables auto-continuation)
PONCHO_INTERNAL_SECRET=...     # Recommended on serverless: shared secret for internal callback auth
\`\`\`

When \`PONCHO_MAX_DURATION\` is set, the agent automatically checkpoints and resumes across
request cycles when it approaches the platform timeout. The web UI and client SDK handle
this transparently.

For serverless deployments with subagents or background callbacks, use a shared state backend
(\`upstash\`, \`redis\`, or \`dynamodb\`) instead of \`state.provider: 'local'\` / \`'memory'\`.

## Troubleshooting

### Vercel deploy issues

- After upgrading \`@poncho-ai/cli\`, re-run \`poncho build vercel --force\` to refresh generated deploy files.
- If Vercel fails during \`pnpm install\` due to a lockfile mismatch, run \`pnpm install --no-frozen-lockfile\` locally and commit \`pnpm-lock.yaml\`.
- Deploy from the project root: \`vercel deploy --prod\`.
- For subagents/background callbacks, set \`PONCHO_INTERNAL_SECRET\` and use non-local state storage.

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

const UPLOAD_PROVIDER_DEPS: Record<string, Array<{ name: string; fallback: string }>> = {
  "vercel-blob": [{ name: "@vercel/blob", fallback: "^2.3.0" }],
  s3: [
    { name: "@aws-sdk/client-s3", fallback: "^3.700.0" },
    { name: "@aws-sdk/s3-request-presigner", fallback: "^3.700.0" },
  ],
};

const ensureRuntimeCliDependency = async (
  projectDir: string,
  cliVersion: string,
  config?: PonchoConfig,
  target?: string,
): Promise<{ paths: string[]; addedDeps: string[] }> => {
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

  const addedDeps: string[] = [];
  const uploadsProvider = config?.uploads?.provider;
  if (uploadsProvider && UPLOAD_PROVIDER_DEPS[uploadsProvider]) {
    for (const dep of UPLOAD_PROVIDER_DEPS[uploadsProvider]) {
      if (!dependencies[dep.name]) {
        dependencies[dep.name] = dep.fallback;
        addedDeps.push(dep.name);
      }
    }
  }

  if (target === "vercel" && !dependencies["@vercel/functions"]) {
    dependencies["@vercel/functions"] = "^1.0.0";
    addedDeps.push("@vercel/functions");
  }

  parsed.dependencies = dependencies;
  await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { paths: [relative(projectDir, packageJsonPath)], addedDeps };
};

const checkVercelCronDrift = async (projectDir: string): Promise<void> => {
  const vercelJsonPath = resolve(projectDir, "vercel.json");
  try {
    await access(vercelJsonPath);
  } catch {
    return;
  }
  let agentCrons: Record<string, CronJobConfig> = {};
  try {
    const agentMd = await readFile(resolve(projectDir, "AGENT.md"), "utf8");
    const parsed = parseAgentMarkdown(agentMd);
    agentCrons = parsed.frontmatter.cron ?? {};
  } catch {
    return;
  }
  let vercelCrons: Array<{ path: string; schedule: string }> = [];
  try {
    const raw = await readFile(vercelJsonPath, "utf8");
    const vercelConfig = JSON.parse(raw) as { crons?: Array<{ path: string; schedule: string }> };
    vercelCrons = vercelConfig.crons ?? [];
  } catch {
    return;
  }
  const vercelCronMap = new Map(
    vercelCrons
      .filter((c) => c.path.startsWith("/api/cron/"))
      .map((c) => [decodeURIComponent(c.path.replace("/api/cron/", "")), c.schedule]),
  );
  const diffs: string[] = [];
  for (const [jobName, job] of Object.entries(agentCrons)) {
    const existing = vercelCronMap.get(jobName);
    if (!existing) {
      diffs.push(`  + missing job "${jobName}" (${job.schedule})`);
    } else if (existing !== job.schedule) {
      diffs.push(`  ~ "${jobName}" schedule changed: "${existing}" → "${job.schedule}"`);
    }
    vercelCronMap.delete(jobName);
  }
  for (const [jobName, schedule] of vercelCronMap) {
    diffs.push(`  - removed job "${jobName}" (${schedule})`);
  }

  // Check reminder polling cron
  try {
    const cfg = await loadPonchoConfig(projectDir);
    const reminderCron = vercelCrons.find((c) => c.path === "/api/reminders/check");
    if (cfg?.reminders?.enabled && !reminderCron) {
      diffs.push(`  + missing reminders polling cron`);
    } else if (!cfg?.reminders?.enabled && reminderCron) {
      diffs.push(`  - reminders polling cron present but reminders disabled`);
    } else if (cfg?.reminders?.enabled && reminderCron) {
      const expected = cfg.reminders.pollSchedule ?? "*/10 * * * *";
      if (reminderCron.schedule !== expected) {
        diffs.push(`  ~ reminders poll schedule changed: "${reminderCron.schedule}" → "${expected}"`);
      }
    }
  } catch { /* best-effort */ }

  if (diffs.length > 0) {
    process.stderr.write(
      `\u26A0 vercel.json crons are out of sync with AGENT.md / poncho.config.js:\n${diffs.join("\n")}\n  Run \`poncho build vercel --force\` to update.\n\n`,
    );
  }
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
    // Build @vercel/nft trace hints for packages that are dynamically loaded
    // at runtime.  Bare `import("pkg")` with a string literal is enough for
    // nft to include the package in the bundle.  Using async import() avoids
    // blocking the module graph at cold start; .catch() prevents errors when
    // an optional package isn't installed.
    const traceHints: string[] = [];

    let browserEnabled = false;
    try {
      const cfg = await loadPonchoConfig(projectDir);
      browserEnabled = !!cfg?.browser;
    } catch { /* best-effort */ }

    if (browserEnabled) {
      traceHints.push(`import("@poncho-ai/browser").catch(() => {});`);

      const projectPkgPath = resolve(projectDir, "package.json");
      try {
        const raw = await readFile(projectPkgPath, "utf8");
        const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
        if (pkg.dependencies?.["@sparticuz/chromium"]) {
          traceHints.push(`import("@sparticuz/chromium").catch(() => {});`);
        }
      } catch { /* best-effort */ }
    }

    const traceBlock = traceHints.length > 0
      ? `\n${traceHints.join("\n")}\n`
      : "";

    const entryPath = resolve(projectDir, "api", "index.mjs");
    await writeScaffoldFile(
      entryPath,
      `import "marked";${traceBlock}
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
    let vercelCrons: Array<{ path: string; schedule: string }> | undefined;
    try {
      const agentMd = await readFile(resolve(projectDir, "AGENT.md"), "utf8");
      const parsed = parseAgentMarkdown(agentMd);
      if (parsed.frontmatter.cron) {
        vercelCrons = Object.entries(parsed.frontmatter.cron).map(
          ([jobName, job]) => ({
            path: `/api/cron/${encodeURIComponent(jobName)}`,
            schedule: job.schedule,
          }),
        );
      }
    } catch {
      // AGENT.md may not exist yet during init; skip cron generation
    }
    let existingVercelConfig: Record<string, unknown> = {};
    try {
      const raw = await readFile(vercelConfigPath, "utf8");
      existingVercelConfig = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No existing vercel.json or invalid JSON — start fresh
    }
    const existingFunctions = (existingVercelConfig.functions ?? {}) as Record<string, Record<string, unknown>>;
    const existingApiEntry = existingFunctions["api/index.mjs"] ?? {};
    const vercelConfig: Record<string, unknown> = {
      ...existingVercelConfig,
      version: 2,
      functions: {
        ...existingFunctions,
        "api/index.mjs": {
          ...existingApiEntry,
          includeFiles:
            "{AGENT.md,poncho.config.js,skills/**,tests/**,node_modules/.pnpm/marked@*/node_modules/marked/lib/marked.umd.js}",
        },
      },
      headers: [
        {
          source: "/api/(.*)",
          headers: [
            { key: "Cache-Control", value: "private, no-cache, no-store, must-revalidate" },
          ],
        },
      ],
      routes: [{ src: "/(.*)", dest: "/api/index.mjs" }],
    };
    // Add reminder polling cron if reminders are enabled
    try {
      const cfg = await loadPonchoConfig(projectDir);
      if (cfg?.reminders?.enabled) {
        const schedule = cfg.reminders.pollSchedule ?? "*/10 * * * *";
        if (!vercelCrons) vercelCrons = [];
        vercelCrons.push({ path: "/api/reminders/check", schedule });
      }
    } catch { /* best-effort */ }

    if (vercelCrons && vercelCrons.length > 0) {
      vercelConfig.crons = vercelCrons;
    }
    await writeScaffoldFile(
      vercelConfigPath,
      `${JSON.stringify(vercelConfig, null, 2)}\n`,
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

// Cron jobs: use AWS EventBridge (CloudWatch Events) to trigger scheduled invocations.
// Create a rule for each cron job defined in AGENT.md that sends a GET request to:
//   /api/cron/<jobName>
// Include the Authorization header with your PONCHO_AUTH_TOKEN as a Bearer token.
//
// Reminders: Create a CloudWatch Events rule that triggers GET /api/reminders/check
// every 10 minutes (or your preferred interval) with Authorization: Bearer <PONCHO_AUTH_TOKEN>.
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

  const config = await loadPonchoConfig(projectDir);
  const { paths: packagePaths, addedDeps } = await ensureRuntimeCliDependency(
    projectDir,
    cliVersion,
    config,
    target,
  );
  const depNote = addedDeps.length > 0 ? ` (added ${addedDeps.join(", ")})` : "";
  for (const p of packagePaths) {
    if (!writtenPaths.includes(p)) {
      writtenPaths.push(depNote ? `${p}${depNote}` : p);
    }
  }

  return writtenPaths;
};

const serializeJs = (value: unknown, indent = 0): string => {
  const pad = "  ".repeat(indent);
  const padInner = "  ".repeat(indent + 1);
  if (value === null || value === undefined) return String(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => `${padInner}${serializeJs(v, indent + 1)}`);
    return `[\n${items.join(",\n")},\n${pad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return "{}";
    const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
    const lines = entries.map(([k, v]) => {
      const key = safeKey.test(k) ? k : JSON.stringify(k);
      return `${padInner}${key}: ${serializeJs(v, indent + 1)}`;
    });
    return `{\n${lines.join(",\n")},\n${pad}}`;
  }
  return String(value);
};

const renderConfigFile = (config: PonchoConfig): string =>
  `export default ${serializeJs(config)}\n`;

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

export type RequestHandler = ((
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>) & {
  _harness?: AgentHarness;
  _cronJobs?: Record<string, CronJobConfig>;
  _conversationStore?: ConversationStore;
  _messagingAdapters?: Map<string, MessagingAdapter>;
  _activeConversationRuns?: Map<string, { ownerId: string; abortController: AbortController; runId: string | null }>;
  _pendingCallbackNeeded?: Set<string>;
  _processSubagentCallback?: (conversationId: string, skipLockCheck?: boolean) => Promise<void>;
  _broadcastEvent?: (conversationId: string, event: AgentEvent) => void;
  _finishConversationStream?: (conversationId: string) => void;
  _checkAndFireReminders?: () => Promise<{ fired: string[]; count: number; duration: number }>;
  _reminderPollIntervalMs?: number;
};

export const createRequestHandler = async (options?: {
  workingDir?: string;
}): Promise<RequestHandler> => {
  const workingDir = options?.workingDir ?? process.cwd();
  dotenv.config({ path: resolve(workingDir, ".env") });
  const config = await loadPonchoConfig(workingDir);
  let agentName = "Agent";
  let agentModelProvider = "anthropic";
  let agentModelName = "claude-opus-4-5";
  let cronJobs: Record<string, CronJobConfig> = {};
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
    try {
      const parsed = parseAgentMarkdown(agentMd);
      cronJobs = parsed.frontmatter.cron ?? {};
    } catch {
      // Cron parsing failure should not block the server
    }
  } catch {}
  // Runtime state maps — will be replaced with orchestrator's maps after init.
  // Initialized here so function definitions that reference them don't cause TS errors.
  // These are reassigned to orchestrator.* below after orchestrator creation.
  let runOwners = new Map<string, string>();
  let runConversations = new Map<string, string>();
  let activeConversationRuns = new Map<string, { ownerId: string; abortController: AbortController; runId: string | null }>();
  // Per-conversation event streaming: buffer events and allow SSE subscribers
  type ConversationEventStream = {
    buffer: AgentEvent[];
    subscribers: Set<ServerResponse>;
    finished: boolean;
  };
  const conversationEventStreams = new Map<string, ConversationEventStream>();
  type EventCallback = (event: AgentEvent) => void;
  const conversationEventCallbacks = new Map<string, Set<EventCallback>>();
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
    const cbs = conversationEventCallbacks.get(conversationId);
    if (cbs) {
      for (const cb of cbs) {
        try { cb(event); } catch {}
      }
    }
  };
  type BrowserSessionForStatus = {
    isActiveFor: (cid: string) => boolean;
    getUrl: (cid: string) => string | undefined;
  };
  // Write a raw SSE event to all event-stream subscribers for a conversation
  // without buffering it (ephemeral events like browser:status shouldn't replay
  // on reconnect).
  const broadcastRawSse = (conversationId: string, event: string, data: unknown): void => {
    const stream = conversationEventStreams.get(conversationId);
    if (!stream) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const subscriber of stream.subscribers) {
      try {
        subscriber.write(payload);
      } catch {
        stream.subscribers.delete(subscriber);
      }
    }
  };
  const emitBrowserStatusIfActive = (
    conversationId: string,
    event: AgentEvent,
    directResponse?: ServerResponse,
  ): void => {
    const bs = harness.browserSession as BrowserSessionForStatus | undefined;
    if (
      event.type !== "tool:completed" ||
      !event.tool.startsWith("browser_") ||
      !bs?.isActiveFor(conversationId)
    ) return;
    const statusPayload = {
      active: true,
      url: bs.getUrl(conversationId) ?? null,
      interactionAllowed: true,
    };
    const raw = `event: browser:status\ndata: ${JSON.stringify(statusPayload)}\n\n`;
    if (directResponse && !directResponse.destroyed) {
      try { directResponse.write(raw); } catch {}
    }
    broadcastRawSse(conversationId, "browser:status", statusPayload);
  };
  const onConversationEvent = (conversationId: string, cb: EventCallback): (() => void) => {
    let cbs = conversationEventCallbacks.get(conversationId);
    if (!cbs) {
      cbs = new Set();
      conversationEventCallbacks.set(conversationId, cbs);
    }
    cbs.add(cb);
    return () => {
      cbs!.delete(cb);
      if (cbs!.size === 0) conversationEventCallbacks.delete(conversationId);
    };
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
  const clearPendingApprovalsForConversation = async (conversationId: string): Promise<void> => {
    const conversation = await conversationStore.get(conversationId);
    if (!conversation) return;
    if (Array.isArray(conversation.pendingApprovals) && conversation.pendingApprovals.length > 0) {
      conversation.pendingApprovals = [];
      await conversationStore.update(conversation);
    }
  };
  const uploadStore = await createUploadStore(config?.uploads, workingDir);
  const harness = new AgentHarness({
    workingDir,
    environment: resolveHarnessEnvironment(),
    uploadStore,
  });
  await harness.initialize();
  const telemetry = new TelemetryEmitter(config?.telemetry);
  const identity = await ensureAgentIdentity(workingDir);
  const stateConfig = resolveStateConfig(config);
  if (!harness.storageEngine) {
    process.stderr.write(
      "[poncho] WARNING: harness.storageEngine is undefined. " +
        "This usually means an outdated @poncho-ai/harness (< 0.37.0) is installed. " +
        "Falling back to in-memory storage — conversations will NOT be persisted. " +
        "Fix: `pnpm up @poncho-ai/harness@latest` or add a pnpm.overrides entry to force resolution.\n",
    );
  }
  const conversationStore = harness.storageEngine
    ? createConversationStoreFromEngine(harness.storageEngine)
    : createConversationStore(stateConfig, { workingDir, agentId: identity.id });

  // ── Orchestrator ──────────────────────────────────────────────────────────
  const orchestrator = new AgentOrchestrator({
    harness,
    conversationStore,
    eventSink: (conversationId, event) => broadcastEvent(conversationId, event),
    telemetry,
    agentId: identity.id,
    workingDir,
    hooks: {
      onContinuationStart(conversationId) {
        const prevStream = conversationEventStreams.get(conversationId);
        if (prevStream) {
          prevStream.finished = false;
          prevStream.buffer = [];
        } else {
          conversationEventStreams.set(conversationId, {
            buffer: [],
            subscribers: new Set(),
            finished: false,
          });
        }
      },
      onContinuationEnd(conversationId) {
        finishConversationStream(conversationId);
      },
      onApprovalCheckpoint(conversationId, approvals) {
        // Telegram approval notification
        const conv = conversationStore.get(conversationId).then(c => {
          if (!c?.channelMeta || c.channelMeta.platform !== "telegram") return;
          const tgAdapter = messagingAdapters.get("telegram") as TelegramAdapter | undefined;
          if (!tgAdapter) return;
          const messageThreadId = parseTelegramMessageThreadIdFromPlatformThreadId(
            c.channelMeta.platformThreadId,
            c.channelMeta.channelId,
          );
          void tgAdapter.sendApprovalRequest(
            c.channelMeta.channelId,
            approvals,
            { message_thread_id: messageThreadId },
          ).catch(() => {});
        });
        void conv;
      },
      // ── Subagent hooks ──
      async createChildHarness() {
        const childHarness = new AgentHarness({
          workingDir,
          environment: resolveHarnessEnvironment(),
          uploadStore,
        });
        await childHarness.initialize();
        return childHarness;
      },
      buildRecallParams: (opts) => buildRecallParams(opts),
      dispatchBackground(type, conversationId) {
        const urlMap = {
          "subagent-run": `/api/internal/subagent/${encodeURIComponent(conversationId)}/run`,
          "subagent-callback": `/api/internal/conversations/${encodeURIComponent(conversationId)}/subagent-callback`,
          "continuation": `/api/internal/continue/${encodeURIComponent(conversationId)}`,
        };
        const work = selfFetchWithRetry(urlMap[type]).catch(err =>
          console.error(`[poncho][dispatch] ${type} self-fetch failed for ${conversationId}:`, err instanceof Error ? err.message : err),
        );
        doWaitUntil(work);
      },
      onStreamEnd(conversationId) {
        finishConversationStream(conversationId);
      },
      onCallbackStreamReset(conversationId) {
        const prevStream = conversationEventStreams.get(conversationId);
        if (prevStream) {
          prevStream.finished = false;
          prevStream.buffer = [];
        } else {
          conversationEventStreams.set(conversationId, {
            buffer: [],
            subscribers: new Set(),
            finished: false,
          });
        }
      },
      onMessagingNotify(conversationId, text) {
        conversationStore.get(conversationId).then(conv => {
          if (!conv?.channelMeta) return;
          const adapter = messagingAdapters.get(conv.channelMeta.platform);
          if (!adapter) return;
          adapter.sendReply(
            {
              channelId: conv.channelMeta.channelId,
              platformThreadId: conv.channelMeta.platformThreadId,
            },
            text,
          ).catch(sendErr =>
            console.error(`[poncho][subagent-callback] Messaging notify failed:`, sendErr instanceof Error ? sendErr.message : sendErr),
          );
        });
      },
    },
  });
  // Redirect local aliases to orchestrator-owned maps/methods
  runOwners = orchestrator.runOwners;
  runConversations = orchestrator.runConversations;
  activeConversationRuns = orchestrator.activeConversationRuns;
  const approvalDecisionTracker = orchestrator.approvalDecisionTracker;
  const findPendingApproval = orchestrator.findPendingApproval.bind(orchestrator);
  const resumeRunFromCheckpoint = orchestrator.resumeRunFromCheckpoint.bind(orchestrator);
  const activeSubagentRuns = orchestrator.activeSubagentRuns;
  const pendingSubagentApprovals = orchestrator.pendingSubagentApprovals;
  const pendingCallbackNeeded = orchestrator.pendingCallbackNeeded;
  const processSubagentCallback = orchestrator.processSubagentCallback.bind(orchestrator);
  const hasPendingSubagentWorkForParent = orchestrator.hasPendingSubagentWorkForParent.bind(orchestrator);
  const hasRunningSubagentsForParent = (parentId: string, _owner: string) => orchestrator.hasRunningSubagentsForParent(parentId);

  // Set up SubagentManager
  const subagentManager = orchestrator.createSubagentManager();
  harness.setSubagentManager(subagentManager);

  // ---------------------------------------------------------------------------
  // Conversation recall parameter builders — shared between main and subagent runs
  // ---------------------------------------------------------------------------
  const buildRecallParams = (opts: { ownerId: string; tenantId?: string | null; excludeConversationId: string }) => {
    let cachedRecallCorpus: unknown[] | undefined;
    const lazyRecallCorpus = async () => {
      if (cachedRecallCorpus) return cachedRecallCorpus;
      const _rc0 = performance.now();
      let recallConversations: Conversation[];
      if (typeof conversationStore.listSummaries === "function") {
        const recallSummaries = (await conversationStore.listSummaries(opts.ownerId, opts.tenantId))
          .filter((s) => s.conversationId !== opts.excludeConversationId && !s.parentConversationId)
          .slice(0, 20);
        recallConversations = (
          await Promise.all(recallSummaries.map((s) => conversationStore.get(s.conversationId)))
        ).filter((c): c is NonNullable<typeof c> => c != null);
      } else {
        recallConversations = (await conversationStore.list(opts.ownerId, opts.tenantId))
          .filter((item) => item.conversationId !== opts.excludeConversationId && !item.parentConversationId)
          .slice(0, 20);
      }
      cachedRecallCorpus = recallConversations
        .map((item) => ({
          conversationId: item.conversationId,
          title: item.title,
          updatedAt: item.updatedAt,
          content: item.messages
            .slice(-6)
            .map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : getTextContent(message)}`)
            .join("\n")
            .slice(0, 2000),
        }))
        .filter((item) => item.content.length > 0);
      console.info(`[poncho] recall corpus fetched lazily (${cachedRecallCorpus.length} items, ${(performance.now() - _rc0).toFixed(1)}ms)`);
      return cachedRecallCorpus;
    };

    const conversationListFn = async () => {
      const summaries = typeof conversationStore.listSummaries === "function"
        ? await conversationStore.listSummaries(opts.ownerId, opts.tenantId)
        : (await conversationStore.list(opts.ownerId, opts.tenantId)).map((c) => ({
            conversationId: c.conversationId,
            title: c.title,
            updatedAt: c.updatedAt,
            createdAt: c.createdAt,
            ownerId: c.ownerId,
            parentConversationId: c.parentConversationId,
            messageCount: c.messages.length,
          }));
      return summaries
        .filter((s) => s.conversationId !== opts.excludeConversationId && !s.parentConversationId)
        .map((s) => ({
          conversationId: s.conversationId,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messageCount,
        }));
    };

    const conversationFetchFn = async (targetId: string) => {
      const conv = await conversationStore.get(targetId);
      if (!conv) return undefined;
      return {
        conversationId: conv.conversationId,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messages: conv.messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : getTextContent(m),
          })),
      };
    };

    return {
      __conversationRecallCorpus: lazyRecallCorpus,
      __conversationListFn: conversationListFn,
      __conversationFetchFn: conversationFetchFn,
    };
  };

  // Subagent lifecycle extracted to AgentOrchestrator (Phase 5).

  // ---------------------------------------------------------------------------
  // Messaging adapters (Slack, etc.) — routes bypass Poncho auth; each
  // adapter handles its own request verification (e.g. Slack signing secret).
  // ---------------------------------------------------------------------------
  const messagingRoutes = new Map<string, Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>>();
  const messagingRouteRegistrar: RouteRegistrar = (method, path, routeHandler) => {
    let byMethod = messagingRoutes.get(path);
    if (!byMethod) {
      byMethod = new Map();
      messagingRoutes.set(path, byMethod);
    }
    byMethod.set(method, routeHandler);
  };

  const messagingRunner: AgentRunner = {
    async getOrCreateConversation(conversationId, meta) {
      const existing = await conversationStore.get(conversationId);
      if (existing) {
        if (!existing.channelMeta && meta.channelId) {
          existing.channelMeta = {
            platform: meta.platform,
            channelId: meta.channelId,
            platformThreadId: meta.platformThreadId ?? meta.channelId,
          };
          await conversationStore.update(existing);
        }
        return { messages: loadCanonicalHistory(existing).messages };
      }
      const now = Date.now();
      const channelMeta = meta.channelId
        ? {
            platform: meta.platform,
            channelId: meta.channelId,
            platformThreadId: meta.platformThreadId ?? meta.channelId,
          }
        : undefined;
      const conversation = {
        conversationId,
        title: meta.title ?? `${meta.platform} thread`,
        messages: [] as Message[],
        ownerId: meta.ownerId,
        tenantId: null,
        channelMeta,
        createdAt: now,
        updatedAt: now,
      };
      await conversationStore.update(conversation);
      return { messages: [] };
    },
    async run(conversationId, input) {
      // getWithArchive — latestConversation feeds withToolResultArchiveParam.
      const latestConversation = await conversationStore.getWithArchive(conversationId);
      const canonicalHistory = latestConversation
        ? loadCanonicalHistory(latestConversation)
        : { messages: [...input.messages], source: "messages" as const };
      const shouldRebuildCanonical = canonicalHistory.source !== "harness";

      const isContinuation = input.task == null;
      console.log(
        `[messaging-runner] starting run for ${conversationId} ` +
        `${isContinuation ? "(continuation)" : `task: ${input.task!.slice(0, 80)}`} ` +
        `history_source=${canonicalHistory.source}`,
      );

      const historyMessages = [...canonicalHistory.messages];
      const preRunMessages = [...canonicalHistory.messages];
      const userContent = input.task;

      // Read-modify-write helper: always fetches the latest version from
      // the store before writing, so concurrent writers don't get clobbered.
      const updateConversation = async (
        patch: (conv: Conversation) => void,
      ): Promise<void> => {
        const fresh = await conversationStore.get(conversationId);
        if (!fresh) return;
        patch(fresh);
        fresh.updatedAt = Date.now();
        await conversationStore.update(fresh);
      };

      await updateConversation((c) => {
        if (!isContinuation) {
          c.messages = [...historyMessages, { role: "user" as const, content: userContent! }];
        }
        c.runStatus = "running";
      });

      let latestRunId = "";
      const draft = createTurnDraftState();
      let checkpointedRun = false;
      let checkpointTextAlreadySent = false;
      let runContextTokens = 0;
      let runContextWindow = 0;
      let runContinuation = false;
      let runContinuationMessages: Message[] | undefined;
      let runSteps = 0;
      let runMaxSteps: number | undefined;

      const buildMessages = (): Message[] => {
        const draftSections = cloneSections(draft.sections);
        if (draft.currentTools.length > 0) {
          draftSections.push({ type: "tools", content: [...draft.currentTools] });
        }
        if (draft.currentText.length > 0) {
          draftSections.push({ type: "text", content: draft.currentText });
        }
        const userTurn: Message[] = userContent != null
          ? [{ role: "user" as const, content: userContent }]
          : [];
        const hasDraftContent =
          draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0 || draftSections.length > 0;
        if (!hasDraftContent) {
          return [...historyMessages, ...userTurn];
        }
        return [
          ...historyMessages,
          ...userTurn,
          {
            role: "assistant" as const,
            content: draft.assistantResponse,
            metadata: buildAssistantMetadata(draft, draftSections),
          },
        ];
      };

      const persistDraftAssistantTurn = async (): Promise<void> => {
        if (draft.assistantResponse.length === 0 && draft.toolTimeline.length === 0) return;
        await updateConversation((c) => {
          c.messages = buildMessages();
        });
      };

      const runInput = {
        task: input.task,
        conversationId,
        messages: historyMessages,
        files: input.files,
        parameters: withToolResultArchiveParam({
          ...(input.metadata ? {
            __messaging_platform: input.metadata.platform,
            __messaging_sender_id: input.metadata.sender.id,
            __messaging_sender_name: input.metadata.sender.name ?? "",
            __messaging_thread_id: input.metadata.threadId,
          } : {}),
          __activeConversationId: conversationId,
        }, latestConversation ?? { _toolResultArchive: {} } as Conversation),
      };

      try {
        const execution = await executeConversationTurn({
          harness,
          runInput,
          onEvent: async (event, eventDraft) => {
            draft.assistantResponse = eventDraft.assistantResponse;
            draft.toolTimeline = eventDraft.toolTimeline;
            draft.sections = eventDraft.sections;
            draft.currentTools = eventDraft.currentTools;
            draft.currentText = eventDraft.currentText;
            if (event.type === "run:started") {
              latestRunId = event.runId;
              runOwners.set(event.runId, "local-owner");
              runConversations.set(event.runId, conversationId);
            }
          if (event.type === "step:completed") {
            await persistDraftAssistantTurn();
          }
          if (event.type === "tool:approval:required") {
            const toolText = `- approval required \`${event.tool}\``;
            draft.toolTimeline.push(toolText);
            draft.currentTools.push(toolText);
            await persistDraftAssistantTurn();
          }
          if (event.type === "tool:approval:checkpoint") {
            await updateConversation((c) => {
              c.messages = buildMessages();
              c.pendingApprovals = buildApprovalCheckpoints({
                approvals: event.approvals,
                runId: latestRunId,
                checkpointMessages: event.checkpointMessages,
                baseMessageCount: historyMessages.length,
                pendingToolCalls: event.pendingToolCalls,
              });
            });
            checkpointedRun = true;

            const conv = await conversationStore.get(conversationId);
            if (conv?.channelMeta?.platform === "telegram") {
              const tgAdapter = messagingAdapters.get("telegram") as TelegramAdapter | undefined;
              if (tgAdapter) {
                const threadRef: import("@poncho-ai/messaging").ThreadRef = {
                  channelId: conv.channelMeta.channelId,
                  platformThreadId: conv.channelMeta.platformThreadId,
                };

                // Send accumulated text BEFORE approval buttons so Telegram
                // shows them in the natural order (text → approval request).
                const pendingText = draft.assistantResponse.trim();
                if (pendingText) {
                  try {
                    await tgAdapter.sendReply(threadRef, pendingText);
                    checkpointTextAlreadySent = true;
                  } catch (err: unknown) {
                    console.error("[messaging-runner] failed to send pre-approval text:", err instanceof Error ? err.message : err);
                  }
                }

                const approvals = event.approvals.map(a => ({
                  approvalId: a.approvalId,
                  tool: a.tool,
                  input: a.input,
                }));
                const messageThreadId = parseTelegramMessageThreadIdFromPlatformThreadId(
                  conv.channelMeta.platformThreadId,
                  conv.channelMeta.channelId,
                );
                void tgAdapter.sendApprovalRequest(
                  conv.channelMeta.channelId,
                  approvals,
                  { message_thread_id: messageThreadId },
                ).catch((err: unknown) => {
                  console.error("[messaging-runner] failed to send Telegram approval request:", err instanceof Error ? err.message : err);
                });
              }
            }
          }
          if (event.type === "compaction:completed") {
            if (event.compactedMessages) {
              historyMessages.length = 0;
              historyMessages.push(...event.compactedMessages);

              const preservedFromHistory = historyMessages.length - 1;
              const removedCount = preRunMessages.length - Math.max(0, preservedFromHistory);
              await updateConversation((c) => {
                const existingHistory = c.compactedHistory ?? [];
                c.compactedHistory = [
                  ...existingHistory,
                  ...preRunMessages.slice(0, removedCount),
                ];
              });
            }
          }
            broadcastEvent(conversationId, event);
          },
        });
        runContinuation = execution.runContinuation;
        runContinuationMessages = execution.runContinuationMessages;
        runSteps = execution.runSteps;
        runMaxSteps = execution.runMaxSteps;
        runContextTokens = execution.runContextTokens;
        runContextWindow = execution.runContextWindow;
        latestRunId = execution.latestRunId || latestRunId;
      } catch (err) {
        console.error("[messaging-runner] run failed:", err instanceof Error ? err.message : err);
        draft.assistantResponse = draft.assistantResponse || `[Error: ${err instanceof Error ? err.message : "Unknown error"}]`;
      }

      flushTurnDraft(draft);

      if (!checkpointedRun) {
        await updateConversation((c) => {
          if (!(runContinuation && runContinuationMessages)) {
            c.messages = buildMessages();
          }
          applyTurnMetadata(c, {
            latestRunId,
            contextTokens: runContextTokens,
            contextWindow: runContextWindow,
            continuation: runContinuation,
            continuationMessages: runContinuationMessages,
            harnessMessages: runContinuationMessages,
            toolResultArchive: harness.getToolResultArchive(conversationId),
          }, { shouldRebuildCanonical: true });
        });
      } else {
        await updateConversation((c) => {
          applyTurnMetadata(c, {
            latestRunId: "",
            contextTokens: 0,
            contextWindow: 0,
            toolResultArchive: harness.getToolResultArchive(conversationId),
          }, {
            clearContinuation: false,
            clearApprovals: false,
            shouldRebuildCanonical: shouldRebuildCanonical && !c._harnessMessages?.length,
          });
        });
      }
      finishConversationStream(conversationId);
      if (latestRunId) {
        runOwners.delete(latestRunId);
        runConversations.delete(latestRunId);
      }

      const response = checkpointTextAlreadySent ? "" : draft.assistantResponse;
      console.log("[messaging-runner] run complete, response length:", response.length, checkpointTextAlreadySent ? "(text sent at checkpoint)" : "", runContinuation ? "(continuation)" : "");

      return {
        response,
        continuation: runContinuation,
        steps: runSteps,
        maxSteps: runMaxSteps,
      };
    },
    async resetConversation(conversationId) {
      const existing = await conversationStore.get(conversationId);
      if (!existing) return;
      // Archive the old conversation under a unique ID so it stays
      // viewable in the web UI. The original ID is freed for a fresh one.
      const archiveId = `${conversationId}_${Date.now()}`;
      const archived = { ...existing, conversationId: archiveId };
      const datePart = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (archived.title) archived.title = `${archived.title} (${datePart})`;
      archived.updatedAt = Date.now();
      await conversationStore.update(archived);
      await conversationStore.delete(conversationId);
      console.log(`[messaging-runner] conversation archived: ${conversationId} → ${archiveId}`);
    },
  };

  let waitUntilHook: ((promise: Promise<unknown>) => void) | undefined;
  if (process.env.VERCEL) {
    try {
      const modName = "@vercel/functions";
      const mod = await import(/* webpackIgnore: true */ modName);
      waitUntilHook = mod.waitUntil;
    } catch {
      // @vercel/functions not installed -- fall through to no-op.
    }
  }

  const isServerless = !!waitUntilHook;
  // Only provide dispatchBackground in serverless mode so the orchestrator
  // calls methods directly in long-lived mode.
  if (!isServerless && orchestrator.hooks) {
    orchestrator.hooks.dispatchBackground = undefined;
  }
  const configuredInternalSecret = process.env.PONCHO_INTERNAL_SECRET?.trim();
  const vercelDeploymentSecret = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  const fallbackInternalSecret = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const internalSecret = configuredInternalSecret || vercelDeploymentSecret || fallbackInternalSecret;
  const isUsingEphemeralInternalSecret = !configuredInternalSecret && !vercelDeploymentSecret;
  let selfBaseUrl: string | null = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : null;

  if (!selfBaseUrl && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    selfBaseUrl = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (!selfBaseUrl && process.env.PONCHO_SELF_BASE_URL) {
    selfBaseUrl = process.env.PONCHO_SELF_BASE_URL.replace(/\/+$/, "");
  }

  if (isServerless && isUsingEphemeralInternalSecret) {
    console.warn(
      "[poncho][serverless] No stable internal secret found. Set PONCHO_INTERNAL_SECRET to avoid intermittent internal callback failures across instances.",
    );
  }
  if (isServerless && !selfBaseUrl) {
    console.warn(
      "[poncho][serverless] No self base URL available. Set PONCHO_SELF_BASE_URL if internal background callbacks fail.",
    );
  }
  const stateProvider = stateConfig?.provider ?? "local";
  if (isServerless && (stateProvider === "local" || stateProvider === "memory")) {
    console.warn(
      `[poncho][serverless] state.provider="${stateProvider}" may lose cross-invocation state. Prefer "upstash", "redis", or "dynamodb" for subagents/reliability.`,
    );
  }

  const doWaitUntil = (promise: Promise<unknown>): void => {
    if (waitUntilHook) waitUntilHook(promise);
  };

  const vercelBypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (process.env.VERCEL && !vercelBypassSecret) {
    console.warn(
      "\n[poncho] Vercel Deployment Protection will block subagents and auto-continuation." +
      "\n  Enable 'Protection Bypass for Automation' in your Vercel project settings:" +
      "\n  -> Project Settings > Deployment Protection > Protection Bypass for Automation" +
      "\n  The secret is auto-provisioned as VERCEL_AUTOMATION_BYPASS_SECRET.\n",
    );
  }
  const hasCronJobs = Object.keys(cronJobs).length > 0;
  const authTokenConfigured = !!(process.env[config?.auth?.tokenEnv ?? "PONCHO_AUTH_TOKEN"]) && (config?.auth?.required ?? false);
  if (process.env.VERCEL && hasCronJobs && authTokenConfigured && !process.env.CRON_SECRET) {
    console.warn(
      "\n[poncho] Cron jobs are configured but CRON_SECRET is not set." +
      "\n  Vercel sends CRON_SECRET as a Bearer token when invoking cron endpoints." +
      "\n  Set CRON_SECRET to the same value as PONCHO_AUTH_TOKEN in your Vercel env vars," +
      "\n  otherwise cron invocations will be rejected with 401.\n",
    );
  }

  const selfFetchWithRetry = async (path: string, body?: Record<string, unknown>, retries = 3): Promise<Response | void> => {
    if (!selfBaseUrl) {
      console.error(`[poncho][self-fetch] Missing self base URL for ${path}`);
      return;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-poncho-internal": internalSecret,
        };
        if (vercelBypassSecret) {
          headers["x-vercel-protection-bypass"] = vercelBypassSecret;
        }
        const result = await fetch(`${selfBaseUrl}${path}`, {
          method: "POST",
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        if (result.ok) {
          return result;
        }
        const responseText = await result.text().catch(() => "");
        lastError = new Error(
          `HTTP ${result.status}${responseText ? `: ${responseText.slice(0, 200)}` : ""}`,
        );
      } catch (err) {
        lastError = err;
      }
      if (attempt === retries - 1) {
        break;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000 * (attempt + 1)));
    }
    if (lastError) {
      console.error(
        `[poncho][self-fetch] Failed ${path} after ${retries} attempt(s):`,
        lastError instanceof Error ? lastError.message : String(lastError),
      );
      if (
        lastError instanceof Error
        && (lastError.message.includes("HTTP 403") || lastError.message.includes("HTTP 401"))
      ) {
        if (lastError.message.includes("HTTP 401") && lastError.message.includes("<!doctype")) {
          console.error(
            "[poncho][self-fetch] Blocked by Vercel Deployment Protection. Set VERCEL_AUTOMATION_BYPASS_SECRET in your Vercel project settings and env vars.",
          );
        } else {
          console.error(
            "[poncho][self-fetch] Internal auth failed. Ensure all serverless instances share PONCHO_INTERNAL_SECRET.",
          );
        }
      }
    } else {
      console.error(`[poncho][self-fetch] Failed ${path} after ${retries} attempt(s).`);
    }
  };

  const getInternalRequestHeader = (headers: IncomingMessage["headers"]): string | undefined => {
    const value = headers["x-poncho-internal"];
    return Array.isArray(value) ? value[0] : value;
  };

  const isValidInternalRequest = (headers: IncomingMessage["headers"]): boolean => {
    const headerValue = getInternalRequestHeader(headers);
    return typeof headerValue === "string" && headerValue === internalSecret;
  };

  // ── Unified continuation ──────────────────────────────────────────────
  // runContinuation and runChatContinuation are now handled by the orchestrator.
  // This local function delegates to orchestrator.runContinuation().
  async function runContinuation(
    conversationId: string,
    onYield?: (event: AgentEvent) => void | Promise<void>,
  ): Promise<void> {
    return orchestrator.runContinuation(conversationId, onYield);
  }


  const messagingAdapters = new Map<string, MessagingAdapter>();
  const messagingBridges: AgentBridge[] = [];
  if (config?.messaging && config.messaging.length > 0) {
    for (const channelConfig of config.messaging) {
      if (channelConfig.platform === "slack") {
        const adapter = new SlackAdapter({
          botTokenEnv: channelConfig.botTokenEnv,
          signingSecretEnv: channelConfig.signingSecretEnv,
        });
        const bridge = new AgentBridge({
          adapter,
          runner: messagingRunner,
          waitUntil: waitUntilHook,
          ownerId: "local-owner",
        });
        try {
          await bridge.start();
          adapter.registerRoutes(messagingRouteRegistrar);
          messagingBridges.push(bridge);
          messagingAdapters.set("slack", adapter);
          console.log(`  Slack messaging enabled at /api/messaging/slack`);
        } catch (err) {
          console.warn(
            `  Slack messaging disabled: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (channelConfig.platform === "resend") {
        const adapter = new ResendAdapter({
          apiKeyEnv: channelConfig.apiKeyEnv,
          webhookSecretEnv: channelConfig.webhookSecretEnv,
          fromEnv: channelConfig.fromEnv,
          replyToEnv: channelConfig.replyToEnv,
          allowedSenders: channelConfig.allowedSenders,
          mode: channelConfig.mode,
          allowedRecipients: channelConfig.allowedRecipients,
          maxSendsPerRun: channelConfig.maxSendsPerRun,
        });
        const bridge = new AgentBridge({
          adapter,
          runner: messagingRunner,
          waitUntil: waitUntilHook,
          ownerId: "local-owner",
        });
        try {
          await bridge.start();
          adapter.registerRoutes(messagingRouteRegistrar);
          messagingBridges.push(bridge);
          messagingAdapters.set("resend", adapter);
          const adapterTools = adapter.getToolDefinitions?.() ?? [];
          if (adapterTools.length > 0) {
            harness.registerTools(adapterTools);
          }
          const modeLabel = channelConfig.mode === "tool" ? "tool" : "auto-reply";
          console.log(`  Resend email messaging enabled at /api/messaging/resend (mode: ${modeLabel})`);
        } catch (err) {
          console.warn(
            `  Resend email messaging disabled: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else if (channelConfig.platform === "telegram") {
        const adapter = new TelegramAdapter({
          botTokenEnv: channelConfig.botTokenEnv,
          webhookSecretEnv: channelConfig.webhookSecretEnv,
          allowedUserIds: channelConfig.allowedUserIds,
        });
        const bridge = new AgentBridge({
          adapter,
          runner: messagingRunner,
          waitUntil: waitUntilHook,
          ownerId: "local-owner",
        });
        adapter.onApprovalDecision(async (approvalId: string, approved: boolean, _chatId: string) => {
          // Check subagent approvals first
          const pendingSubagent = pendingSubagentApprovals.get(approvalId);
          if (pendingSubagent) {
            await adapter.updateApprovalMessage(approvalId, approved ? "approved" : "denied", pendingSubagent.checkpoint.tool);
            await orchestrator.submitSubagentApprovalDecision(approvalId, approved);
            return;
          }

          // Regular (non-subagent) approval
          const found = await findPendingApproval(approvalId, "local-owner");
          let foundConversation = found?.conversation;
          const foundApproval = found?.approval;

          if (!foundConversation || !foundApproval) {
            console.warn("[telegram-approval] approval not found:", approvalId);
            return;
          }

          const approvalDecision = approved ? "approved" as const : "denied" as const;
          await adapter.updateApprovalMessage(approvalId, approvalDecision, foundApproval.tool);

          foundConversation.pendingApprovals = (foundConversation.pendingApprovals ?? []).map((approval) =>
            approval.approvalId === approvalId
              ? { ...normalizeApprovalCheckpoint(approval, foundConversation!.messages), decision: approvalDecision }
              : normalizeApprovalCheckpoint(approval, foundConversation!.messages),
          );
          await conversationStore.update(foundConversation);

          broadcastEvent(foundConversation.conversationId,
            approved
              ? { type: "tool:approval:granted", approvalId }
              : { type: "tool:approval:denied", approvalId },
          );

          const refreshedConversation = await conversationStore.get(foundConversation.conversationId);
          const allApprovals = (refreshedConversation?.pendingApprovals ?? []).map((approval) =>
            normalizeApprovalCheckpoint(approval, refreshedConversation!.messages),
          );
          const allDecided = allApprovals.length > 0 && allApprovals.every(a => a.decision != null);

          if (!allDecided) {
            return;
          }
          foundConversation = refreshedConversation!;

          // All decided — resume the run
          const conversationId = foundConversation.conversationId;
          const checkpointRef = allApprovals[0]!;
          foundConversation.pendingApprovals = [];
          foundConversation.runStatus = "running";
          await conversationStore.update(foundConversation);

          const prevStream = conversationEventStreams.get(conversationId);
          if (prevStream) {
            prevStream.finished = false;
            prevStream.buffer = [];
          } else {
            conversationEventStreams.set(conversationId, {
              buffer: [],
              subscribers: new Set(),
              finished: false,
            });
          }

          const resumeWork = (async () => {
            let stopTyping: (() => Promise<void>) | undefined;
            try {
              const threadRef: import("@poncho-ai/messaging").ThreadRef = {
                platformThreadId: foundConversation!.channelMeta!.platformThreadId,
                channelId: foundConversation!.channelMeta!.channelId,
              };
              stopTyping = await adapter.indicateProcessing(threadRef);

              const toolContext = {
                runId: checkpointRef.runId,
                agentId: identity.id,
                step: 0,
                workingDir,
                parameters: {},
              };

              const approvalToolCallIds = new Set(allApprovals.map(a => a.toolCallId));
              const callsToExecute: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
              const deniedResults: Array<{ callId: string; toolName: string; error: string }> = [];

              for (const a of allApprovals) {
                if (a.decision === "approved" && a.toolCallId) {
                  callsToExecute.push({ id: a.toolCallId, name: a.tool, input: a.input });
                } else if (a.decision === "denied" && a.toolCallId) {
                  deniedResults.push({ callId: a.toolCallId, toolName: a.tool, error: "Tool execution denied by user" });
                }
              }

              const pendingToolCalls = checkpointRef.pendingToolCalls ?? [];
              for (const tc of pendingToolCalls) {
                if (!approvalToolCallIds.has(tc.id)) callsToExecute.push(tc);
              }

              let toolResults: Array<{ callId: string; toolName: string; result?: unknown; error?: string }> = [...deniedResults];
              if (callsToExecute.length > 0) {
                const execResults = await harness.executeTools(callsToExecute, toolContext);
                toolResults.push(...execResults.map(r => ({
                  callId: r.callId,
                  toolName: r.tool,
                  result: r.output,
                  error: r.error,
                })));
              }

              // Capture pre-resume text length so we only send new content
              const preResumeConv = await conversationStore.get(conversationId);
              const preResumeLastMsg = preResumeConv?.messages[preResumeConv.messages.length - 1];
              const preResumeTextLength = preResumeLastMsg?.role === "assistant" && typeof preResumeLastMsg.content === "string"
                ? preResumeLastMsg.content.length
                : 0;

              await resumeRunFromCheckpoint(
                conversationId,
                foundConversation!,
                checkpointRef,
                toolResults,
              );

              // Send only the NEW text produced by the resumed run to Telegram
              const updatedConv = await conversationStore.get(conversationId);
              if (updatedConv?.channelMeta?.platform === "telegram") {
                const lastMsg = updatedConv.messages[updatedConv.messages.length - 1];
                const fullText = lastMsg?.role === "assistant" && typeof lastMsg.content === "string"
                  ? lastMsg.content
                  : "";
                const newText = fullText.slice(preResumeTextLength).trim();
                if (newText) {
                  await adapter.sendReply(threadRef, newText);
                }
              }
            } catch (err) {
              console.error("[telegram-approval-resume] failed:", err instanceof Error ? err.message : err);
              const conv = await conversationStore.get(conversationId);
              if (conv) {
                conv.runStatus = "idle";
                conv.updatedAt = Date.now();
                await conversationStore.update(conv);
              }
            } finally {
              if (stopTyping) await stopTyping().catch(() => {});
            }
          })();
          if (waitUntilHook) {
            waitUntilHook(resumeWork);
          }
        });

        try {
          await bridge.start();
          adapter.registerRoutes(messagingRouteRegistrar);
          messagingBridges.push(bridge);
          messagingAdapters.set("telegram", adapter);
          console.log(`  Telegram messaging enabled at /api/messaging/telegram`);
        } catch (err) {
          console.warn(
            `  Telegram messaging disabled: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  const sessionStore = new SessionStore();
  const loginRateLimiter = new LoginRateLimiter();

  const authTokenEnv = config?.auth?.tokenEnv ?? "PONCHO_AUTH_TOKEN";
  const authToken = process.env[authTokenEnv] ?? "";
  const authRequired = config?.auth?.required ?? false;
  const requireAuth = authRequired && authToken.length > 0;

  if (requireAuth) {
    sessionStore.setSigningKey(authToken);
  }

  const webUiEnabled = config?.webUi !== false;
  const isProduction = resolveHarnessEnvironment() === "production";
  const secureCookies = isProduction;

  const handler: RequestHandler = async (request: IncomingMessage, response: ServerResponse) => {
    if (!request.url || !request.method) {
      writeJson(response, 404, { error: "Not found" });
      return;
    }
    const [pathname] = request.url.split("?");
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (!selfBaseUrl && request.headers.host) {
      const proto = (request.headers["x-forwarded-proto"] as string | undefined) ?? (isProduction ? "https" : "http");
      selfBaseUrl = `${proto}://${request.headers.host}`;
    }

    if (webUiEnabled) {
      if (request.method === "GET" && (pathname === "/" || pathname.startsWith("/c/"))) {
        writeHtml(response, 200, renderWebUiHtml({ agentName, isDev: !isProduction }));
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
        response.writeHead(302, { Location: "/icon.svg" });
        response.end();
        return;
      }
    }

    if (pathname === "/health" && request.method === "GET") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (pathname === "/api/openapi.json" && request.method === "GET") {
      writeJson(response, 200, buildOpenApiSpec({ agentName }));
      return;
    }

    if (pathname === "/api/docs" && request.method === "GET") {
      writeHtml(response, 200, renderApiDocsHtml("/api/openapi.json"));
      return;
    }

    // Messaging adapter routes bypass Poncho auth (they verify requests
    // using platform-specific mechanisms, e.g. Slack signing secret).
    const messagingByMethod = messagingRoutes.get(pathname ?? "");
    if (messagingByMethod) {
      const routeHandler = messagingByMethod.get(request.method ?? "");
      if (routeHandler) {
        const work = routeHandler(request, response);
        if (waitUntilHook) waitUntilHook(work);
        await work;
        return;
      }
    }

    // ── Internal endpoints (self-fetch only, secured by startup secret) ──
    if (pathname?.startsWith("/api/internal/") && request.method === "POST") {
      if (!isValidInternalRequest(request.headers)) {
        writeJson(response, 403, { code: "FORBIDDEN", message: "Internal endpoint" });
        return;
      }

      const subagentRunMatch = pathname.match(/^\/api\/internal\/subagent\/([^/]+)\/run$/);
      if (subagentRunMatch) {
        const subagentId = decodeURIComponent(subagentRunMatch[1]!);
        const body = (await readRequestBody(request)) as { resume?: boolean } | undefined;
        writeJson(response, 202, { ok: true });
        const work = (async () => {
          try {
            const conv = await conversationStore.get(subagentId);
            if (!conv || !conv.parentConversationId) return;
            if (conv.subagentMeta?.status === "stopped") return;

            if (body?.resume) {
              await orchestrator.resumeSubagentFromCheckpoint(subagentId);
              return;
            }

            const task = (conv.messages.find(m => m.role === "user")?.content as string) ?? conv.subagentMeta?.task ?? "";
            await orchestrator.runSubagent(subagentId, conv.parentConversationId, task, conv.ownerId);
          } catch (err) {
            console.error(`[poncho][internal] subagent run error for ${subagentId}:`, err instanceof Error ? err.message : err);
          }
        })();
        doWaitUntil(work);
        if (!waitUntilHook) await work;
        return;
      }

      const callbackMatch = pathname.match(/^\/api\/internal\/conversations\/([^/]+)\/subagent-callback$/);
      if (callbackMatch) {
        const conversationId = decodeURIComponent(callbackMatch[1]!);
        writeJson(response, 202, { ok: true });
        const work = processSubagentCallback(conversationId);
        doWaitUntil(work);
        if (!waitUntilHook) await work;
        return;
      }

      const continueMatch = pathname.match(/^\/api\/internal\/continue\/([^/]+)$/);
      if (continueMatch) {
        const conversationId = decodeURIComponent(continueMatch[1]!);
        writeJson(response, 202, { ok: true });
        const work = (async () => {
          try {
            await runContinuation(conversationId);
            // Chain: if another continuation is needed, fire next self-fetch
            const conv = await conversationStore.get(conversationId);
            if (conv?._continuationMessages?.length) {
              await selfFetchWithRetry(`/api/internal/continue/${encodeURIComponent(conversationId)}`);
            }
          } catch (err) {
            console.error(`[poncho][internal-continue] Error for ${conversationId}:`, err instanceof Error ? err.message : err);
          }
        })();
        doWaitUntil(work);
        if (!waitUntilHook) await work;
        return;
      }

      writeJson(response, 404, { error: "Not found" });
      return;
    }

    // --- Resolve request context (auth type, tenant scope, owner) ---
    type RequestContext = {
      authType: "builder" | "tenant" | "anonymous";
      ownerId: string;
      /**
       * undefined = builder/admin (no tenant filter, sees everything)
       * null = legacy single-user mode
       * string = tenant-scoped
       */
      tenantId: string | undefined | null;
      session?: ReturnType<typeof sessionStore.get>;
    };

    const resolveRequestContext = async (req: IncomingMessage): Promise<RequestContext> => {
      const authHeader = req.headers.authorization;
      const bearer = typeof authHeader === "string"
        ? authHeader.match(/^Bearer\s+(.+)$/i)?.[1]
        : undefined;

      // 1. Builder Bearer token (exact match against PONCHO_AUTH_TOKEN)
      if (bearer && authToken && verifyPassphrase(bearer, authToken)) {
        return { authType: "builder", ownerId: "local-owner", tenantId: undefined };
      }

      // 2. Tenant JWT (HS256 signed with PONCHO_AUTH_TOKEN)
      if (bearer && authToken) {
        const tenantPayload = await verifyTenantToken(authToken, bearer);
        if (tenantPayload) {
          return {
            authType: "tenant",
            ownerId: tenantPayload.tenantId,
            tenantId: tenantPayload.tenantId,
          };
        }
      }

      // 3. Session cookie (passphrase login — builder auth)
      const cookies = parseCookies(req);
      const cookieValue = cookies.poncho_session;
      const sess = cookieValue
        ? (sessionStore.get(cookieValue) ?? sessionStore.restoreFromSigned(cookieValue))
        : undefined;
      if (sess) {
        return {
          authType: "builder",
          ownerId: sess.ownerId ?? "local-owner",
          tenantId: undefined,
          session: sess,
        };
      }

      // 4. Anonymous / legacy
      return { authType: "anonymous", ownerId: "local-owner", tenantId: null };
    };

    const ctx = await resolveRequestContext(request);
    const ownerId = ctx.ownerId;
    const session = ctx.session;
    const requiresCsrfValidation =
      request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";

    /** Check if ctx has access to a conversation. Builder (tenantId=undefined) sees everything. */
    const canAccessConversation = (conv: { ownerId: string; tenantId?: string | null }): boolean => {
      if (ctx.tenantId === undefined) return true; // builder/admin
      return conv.ownerId === ownerId && (conv.tenantId ?? null) === (ctx.tenantId ?? null);
    };

    if (pathname === "/api/auth/session" && request.method === "GET") {
      if (!requireAuth) {
        writeJson(response, 200, { authenticated: true, csrfToken: "" });
        return;
      }
      // Tenant JWT auth — already authenticated, no session needed
      if (ctx.authType === "tenant") {
        const tenantSecrets = config?.tenantSecrets;
        writeJson(response, 200, {
          authenticated: true,
          authType: "tenant",
          tenantId: ctx.tenantId,
          ...(tenantSecrets && Object.keys(tenantSecrets).length > 0
            ? { tenantSecrets }
            : {}),
        });
        return;
      }
      // Builder Bearer auth
      if (ctx.authType === "builder" && !session) {
        writeJson(response, 200, { authenticated: true, authType: "builder" });
        return;
      }
      if (!session) {
        writeJson(response, 200, { authenticated: false });
        return;
      }
      writeJson(response, 200, {
        authenticated: true,
        authType: "builder",
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
      const signedValue = sessionStore.signSession(createdSession);
      setCookie(response, "poncho_session", signedValue ?? createdSession.sessionId, {
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
      // Internal self-fetch requests bypass user-facing auth
      const isInternalPath = pathname.startsWith("/api/internal/") || pathname.startsWith("/api/cron/") || pathname === "/api/reminders/check";
      const isInternal = isInternalPath && request.method === "POST" && isValidInternalRequest(request.headers);

      // Check authentication: either valid session (Web UI), valid Bearer token (API), tenant JWT, or valid internal request
      const hasBearerToken = request.headers.authorization?.startsWith("Bearer ");
      const isAuthenticated = isInternal || !requireAuth || ctx.authType !== "anonymous";

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
        pathname !== "/api/auth/logout" &&
        request.headers["x-csrf-token"] !== session?.csrfToken
      ) {
        console.warn(
          `[poncho][csrf] blocked request method=${request.method} path="${pathname}" session=${session.sessionId}`,
        );
        writeJson(response, 403, {
          code: "CSRF_ERROR",
          message: "Invalid CSRF token",
        });
        return;
      }
    }

    // --- Secrets API endpoints ---
    const secretsMatch = pathname.match(/^\/api\/secrets(?:\/([^/]+))?$/);
    if (secretsMatch) {
      const envName = secretsMatch[1] ? decodeURIComponent(secretsMatch[1]) : undefined;
      const tenantSecrets = config?.tenantSecrets;

      if (request.method === "GET" && !envName) {
        // GET /api/secrets — list secrets
        if (ctx.authType === "tenant" && ctx.tenantId) {
          // Tenant: return tenantSecrets entries with set/unset status
          if (!tenantSecrets || Object.keys(tenantSecrets).length === 0) {
            writeJson(response, 200, { secrets: [] });
            return;
          }
          const setNames = harness.secretsStore
            ? new Set(await harness.secretsStore.list(ctx.tenantId))
            : new Set<string>();
          const secrets = Object.entries(tenantSecrets).map(([name, label]) => ({
            name,
            label,
            isSet: setNames.has(name),
          }));
          writeJson(response, 200, { secrets });
          return;
        }
        if (ctx.authType === "builder") {
          // Builder: list all secrets for a specific tenant
          const tenantParam = requestUrl.searchParams.get("tenant");
          if (!tenantParam) {
            writeJson(response, 400, { code: "BAD_REQUEST", message: "?tenant= query parameter required for builder access" });
            return;
          }
          const names = harness.secretsStore
            ? await harness.secretsStore.list(tenantParam)
            : [];
          writeJson(response, 200, { tenant: tenantParam, secrets: names.map((n) => ({ name: n, isSet: true })) });
          return;
        }
        writeJson(response, 403, { code: "FORBIDDEN", message: "Not authorized" });
        return;
      }

      if (request.method === "PUT" && envName) {
        // PUT /api/secrets/:envName — set a secret value
        const body = (await readRequestBody(request)) as { value?: string };
        const value = typeof body.value === "string" ? body.value : "";
        if (!value) {
          writeJson(response, 400, { code: "BAD_REQUEST", message: "value is required" });
          return;
        }
        let targetTenant: string | undefined;
        if (ctx.authType === "tenant" && ctx.tenantId) {
          // Tenants can only set keys listed in tenantSecrets
          if (!tenantSecrets || !(envName in tenantSecrets)) {
            writeJson(response, 403, { code: "FORBIDDEN", message: "Not allowed to set this secret" });
            return;
          }
          targetTenant = ctx.tenantId;
        } else if (ctx.authType === "builder") {
          const tenantParam = requestUrl.searchParams.get("tenant");
          if (!tenantParam) {
            writeJson(response, 400, { code: "BAD_REQUEST", message: "?tenant= required" });
            return;
          }
          targetTenant = tenantParam;
        }
        if (!targetTenant || !harness.secretsStore) {
          writeJson(response, 400, { code: "BAD_REQUEST", message: "Secrets store not available" });
          return;
        }
        await harness.secretsStore.set(targetTenant, envName, value);
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "DELETE" && envName) {
        // DELETE /api/secrets/:envName — remove a secret override
        let targetTenant: string | undefined;
        if (ctx.authType === "tenant" && ctx.tenantId) {
          if (!tenantSecrets || !(envName in tenantSecrets)) {
            writeJson(response, 403, { code: "FORBIDDEN", message: "Not allowed to delete this secret" });
            return;
          }
          targetTenant = ctx.tenantId;
        } else if (ctx.authType === "builder") {
          const tenantParam = requestUrl.searchParams.get("tenant");
          if (!tenantParam) {
            writeJson(response, 400, { code: "BAD_REQUEST", message: "?tenant= required" });
            return;
          }
          targetTenant = tenantParam;
        }
        if (!targetTenant || !harness.secretsStore) {
          writeJson(response, 400, { code: "BAD_REQUEST", message: "Secrets store not available" });
          return;
        }
        await harness.secretsStore.delete(targetTenant, envName);
        writeJson(response, 200, { ok: true });
        return;
      }
    }

    // --- Browser endpoints (single session, routed by conversationId) ---

    type BrowserSessionTyped = {
      isLaunched: boolean;
      isActiveFor: (cid: string) => boolean;
      getUrl: (cid: string) => string | undefined;
      onFrame: (cid: string, cb: (f: { data: string; width: number; height: number; timestamp: number }) => void) => () => void;
      onStatus: (cid: string, cb: (s: { active: boolean; url?: string; interactionAllowed: boolean }) => void) => () => void;
      startScreencast: (cid: string, opts?: Record<string, unknown>) => Promise<void>;
      screenshot: (cid: string) => Promise<string>;
      injectMouse: (cid: string, e: { type: string; x: number; y: number; button?: string; clickCount?: number; deltaX?: number; deltaY?: number }) => Promise<void>;
      injectKeyboard: (cid: string, e: { type: string; key: string; code?: string }) => Promise<void>;
      injectScroll: (cid: string, e: { deltaX: number; deltaY: number; x?: number; y?: number }) => Promise<void>;
      injectPaste: (cid: string, text: string) => Promise<void>;
      navigate: (cid: string, action: string) => Promise<void>;
    };

    const browserSession = harness.browserSession as BrowserSessionTyped | undefined;

    const resolveBrowserSession = (cid: string): BrowserSessionTyped | undefined => {
      if (browserSession?.isActiveFor(cid)) return browserSession;
      const subRun = activeSubagentRuns.get(cid);
      if (subRun) {
        const childSession = subRun.harness.browserSession as BrowserSessionTyped | undefined;
        if (childSession?.isActiveFor(cid)) return childSession;
      }
      return undefined;
    };

    if (pathname === "/api/browser/status" && request.method === "GET") {
      const cid = requestUrl.searchParams.get("conversationId") ?? "";
      const session = cid ? resolveBrowserSession(cid) : undefined;
      writeJson(response, 200, {
        active: !!session,
        url: session ? session.getUrl(cid) ?? null : null,
        conversationId: cid || null,
      });
      return;
    }

    if (pathname === "/api/browser/stream" && request.method === "GET") {
      const cid = requestUrl.searchParams.get("conversationId");
      const streamSession = cid ? resolveBrowserSession(cid) : undefined;
      if (!cid || !streamSession) {
        writeJson(response, 404, { error: "No browser session available" });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();

      let frameCount = 0;
      let droppedFrames = 0;
      let draining = false;
      let pendingFrame: { data: string; width: number; height: number; timestamp: number } | null = null;

      const sendSse = (event: string, data: unknown) => {
        if (response.destroyed) return;
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const sendFrame = (frame: { data: string; width: number; height: number; timestamp: number }) => {
        if (response.destroyed) return;
        if (draining) {
          pendingFrame = frame;
          droppedFrames++;
          return;
        }
        const ok = response.write(`event: browser:frame\ndata: ${JSON.stringify(frame)}\n\n`);
        if (!ok) {
          draining = true;
          response.once("drain", () => {
            draining = false;
            if (pendingFrame && !response.destroyed) {
              const f = pendingFrame;
              pendingFrame = null;
              sendFrame(f);
            }
          });
        }
      };

      sendSse("browser:status", {
        active: streamSession.isActiveFor(cid),
        url: streamSession.getUrl(cid),
        interactionAllowed: streamSession.isActiveFor(cid),
      });

      const removeFrame = streamSession.onFrame(cid, (frame) => {
        frameCount++;
        if (frameCount <= 3 || frameCount % 50 === 0) {
          console.log(`[poncho][browser-sse] Frame ${frameCount}: ${frame.width}x${frame.height}, data bytes: ${frame.data?.length ?? 0}${droppedFrames > 0 ? `, dropped: ${droppedFrames}` : ""}`);
        }
        sendFrame(frame);
      });
      const removeStatus = streamSession.onStatus(cid, (status) => {
        sendSse("browser:status", status);
      });

      if (streamSession.isActiveFor(cid)) {
        streamSession.screenshot(cid).then((data) => {
          if (!response.destroyed) {
            sendFrame({ data, width: 1280, height: 720, timestamp: Date.now() });
          }
          return streamSession.startScreencast(cid);
        }).catch((err: unknown) => {
          console.error("[poncho][browser-sse] initial frame/screencast failed:", (err as Error)?.message ?? err);
        });
      }

      request.on("close", () => {
        removeFrame();
        removeStatus();
        pendingFrame = null;
      });
      return;
    }

    if (pathname === "/api/browser/input" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const cid = body.conversationId as string;
      const inputSession = cid ? resolveBrowserSession(cid) : undefined;
      if (!cid || !inputSession) {
        writeJson(response, 404, { error: "No active browser session" });
        return;
      }
      try {
        if (body.kind === "mouse") {
          await inputSession.injectMouse(cid, body.event);
        } else if (body.kind === "keyboard") {
          await inputSession.injectKeyboard(cid, body.event);
        } else if (body.kind === "scroll") {
          await inputSession.injectScroll(cid, body.event);
        } else if (body.kind === "paste") {
          await inputSession.injectPaste(cid, body.text ?? body.event?.text ?? "");
        } else {
          writeJson(response, 400, { error: "Unknown input kind" });
          return;
        }
        writeJson(response, 200, { ok: true });
      } catch (err) {
        writeJson(response, 500, { error: (err as Error)?.message ?? "Input injection failed" });
      }
      return;
    }

    if (pathname === "/api/browser/navigate" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const cid = body.conversationId as string;
      const navSession = cid ? resolveBrowserSession(cid) : undefined;
      if (!cid || !navSession) {
        writeJson(response, 400, { error: "No active browser session" });
        return;
      }
      try {
        await navSession.navigate(cid, body.action);
        writeJson(response, 200, { ok: true });
      } catch (err) {
        writeJson(response, 500, { error: (err as Error)?.message ?? "Navigation failed" });
      }
      return;
    }

    if (pathname === "/api/conversations" && request.method === "GET") {
      const allSummaries = await conversationStore.listSummaries(ownerId, ctx.tenantId);
      const conversations = allSummaries.filter((c) => !c.parentConversationId);
      // Derive parent-has-subagent-approvals from the in-memory map (no disk I/O)
      const parentHasSubagentApprovals = new Set<string>();
      for (const [, pa] of pendingSubagentApprovals) {
        parentHasSubagentApprovals.add(pa.parentConversationId);
      }
      writeJson(response, 200, {
        conversations: conversations.map((c) => ({
          conversationId: c.conversationId,
          title: c.title,
          ownerId: c.ownerId,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          messageCount: c.messageCount ?? 0,
          hasPendingApprovals:
            !!c.hasPendingApprovals || parentHasSubagentApprovals.has(c.conversationId),
        })),
      });
      return;
    }

    if (pathname === "/api/conversations" && request.method === "POST") {
      const body = (await readRequestBody(request)) as { title?: string };
      const conversation = await conversationStore.create(ownerId, body.title, ctx.tenantId ?? null);
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
      const body = (await readRequestBody(request)) as { approved?: boolean; conversationId?: string };
      const approved = body.approved === true;
      const hintedConversationId = typeof body.conversationId === "string" && body.conversationId.trim().length > 0
        ? body.conversationId.trim()
        : undefined;

      // Check if this is a pending subagent approval (handled inline by runSubagent)
      const subagentResult = await orchestrator.submitSubagentApprovalDecision(approvalId, approved);
      if (subagentResult.found) {
        writeJson(response, 200, { ok: true, approvalId, approved } satisfies ApiApprovalResponse);
        return;
      }

      // Find the approval in the conversation store (checkpoint-based flow)
      let foundConversation: Conversation | undefined;
      let foundApproval: NonNullable<Conversation["pendingApprovals"]>[number] | undefined;
      if (hintedConversationId) {
        const hintedConversation = await conversationStore.get(hintedConversationId);
        if (hintedConversation && hintedConversation.ownerId === ownerId && Array.isArray(hintedConversation.pendingApprovals)) {
          const hintedMatch = hintedConversation.pendingApprovals.find((approval) => approval.approvalId === approvalId);
          if (hintedMatch) {
            foundConversation = hintedConversation;
            foundApproval = hintedMatch;
          }
        }
      }
      if (!foundConversation || !foundApproval) {
        const found = await findPendingApproval(approvalId, ownerId);
        foundConversation = found?.conversation;
        foundApproval = found?.approval;
      }

      if (!foundConversation || !foundApproval) {
        writeJson(response, 404, {
          code: "APPROVAL_NOT_FOUND",
          message: "Approval request not found",
        });
        return;
      }

      const conversationId = foundConversation.conversationId;
      foundApproval = normalizeApprovalCheckpoint(foundApproval, foundConversation.messages);

      if (!foundApproval.checkpointMessages || !foundApproval.toolCallId) {
        writeJson(response, 409, {
          code: "APPROVAL_NOT_READY",
          message: "Approval checkpoint is not ready yet. Please retry shortly.",
        });
        return;
      }

      const approvalDecision = approved ? "approved" : "denied";
      foundConversation.pendingApprovals = (foundConversation.pendingApprovals ?? []).map((approval) =>
        approval.approvalId === approvalId
          ? { ...normalizeApprovalCheckpoint(approval, foundConversation!.messages), decision: approvalDecision }
          : normalizeApprovalCheckpoint(approval, foundConversation!.messages),
      );
      await conversationStore.update(foundConversation);

      broadcastEvent(conversationId,
        approved
          ? { type: "tool:approval:granted", approvalId }
          : { type: "tool:approval:denied", approvalId },
      );

      const refreshedConversation = await conversationStore.get(conversationId);
      const allApprovals = (refreshedConversation?.pendingApprovals ?? []).map((approval) =>
        normalizeApprovalCheckpoint(approval, refreshedConversation!.messages),
      );
      const allDecided = allApprovals.length > 0 &&
        allApprovals.every(a => a.decision != null);

      if (!allDecided) {
        writeJson(response, 200, { ok: true, approvalId, approved, batchComplete: false } satisfies ApiApprovalResponse);
        return;
      }

      approvalDecisionTracker.delete(conversationId);

      foundConversation.pendingApprovals = [];
      foundConversation.runStatus = "running";
      await conversationStore.update(foundConversation);

      // Use the first approval as the checkpoint reference (all share the same checkpoint data)
      const checkpointRef = allApprovals[0]!;

      // Reset the event stream so new SSE subscribers can connect to the
      // resumed run (the previous run's stream was marked finished).
      const prevStream = conversationEventStreams.get(conversationId);
      if (prevStream) {
        prevStream.finished = false;
        prevStream.buffer = [];
      } else {
        conversationEventStreams.set(conversationId, {
          buffer: [],
          subscribers: new Set(),
          finished: false,
        });
      }

      const resumeWork = (async () => {
        try {
          const toolContext = {
            runId: checkpointRef.runId,
            agentId: identity.id,
            step: 0,
            workingDir,
            parameters: {},
          };

          // Collect tool calls to execute: approved approval-gated tools + auto-approved deferred tools
          const approvalToolCallIds = new Set(allApprovals.map(a => a.toolCallId));
          const callsToExecute: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
          const deniedResults: Array<{ callId: string; toolName: string; error: string }> = [];

          for (const a of allApprovals) {
            if (a.decision === "approved" && a.toolCallId) {
              callsToExecute.push({ id: a.toolCallId, name: a.tool, input: a.input });
            } else if (a.decision === "denied" && a.toolCallId) {
              deniedResults.push({ callId: a.toolCallId, toolName: a.tool, error: "Tool execution denied by user" });
            }
          }

          // Auto-approved tools that were deferred alongside the approval-needing ones
          const pendingToolCalls = checkpointRef.pendingToolCalls ?? [];
          for (const tc of pendingToolCalls) {
            if (!approvalToolCallIds.has(tc.id)) {
              callsToExecute.push(tc);
            }
          }

          let toolResults: Array<{ callId: string; toolName: string; result?: unknown; error?: string }> = [...deniedResults];
          if (callsToExecute.length > 0) {
            const execResults = await harness.executeTools(callsToExecute, toolContext);
            toolResults.push(...execResults.map(r => ({
              callId: r.callId,
              toolName: r.tool,
              result: r.output,
              error: r.error,
            })));
          }

          // If approved tools activated the browser, notify connected clients
          const bs = harness.browserSession as BrowserSessionForStatus | undefined;
          if (bs?.isActiveFor(conversationId)) {
            broadcastRawSse(conversationId, "browser:status", {
              active: true,
              url: bs.getUrl(conversationId) ?? null,
              interactionAllowed: true,
            });
          }

          // Capture pre-resume text so Telegram reply only includes new content
          const preConv = await conversationStore.get(conversationId);
          const preLast = preConv?.messages[preConv.messages.length - 1];
          const preLen = preLast?.role === "assistant" && typeof preLast.content === "string"
            ? preLast.content.length : 0;

          await resumeRunFromCheckpoint(
            conversationId,
            foundConversation!,
            checkpointRef,
            toolResults,
          );

          // If the conversation originated from a messaging channel, send the new response text
          const postConv = await conversationStore.get(conversationId);
          if (postConv?.channelMeta) {
            const adapter = messagingAdapters.get(postConv.channelMeta.platform);
            if (adapter) {
              const lastMsg = postConv.messages[postConv.messages.length - 1];
              const full = lastMsg?.role === "assistant" && typeof lastMsg.content === "string"
                ? lastMsg.content : "";
              const newText = full.slice(preLen).trim();
              if (newText) {
                try {
                  await adapter.sendReply(
                    {
                      platformThreadId: postConv.channelMeta.platformThreadId,
                      channelId: postConv.channelMeta.channelId,
                    },
                    newText,
                  );
                } catch (sendErr) {
                  console.error("[approval-resume] messaging notify failed:", sendErr instanceof Error ? sendErr.message : sendErr);
                }
              }
            }
          }

          // If this conversation is a subagent, handle completion (write result to parent)
          if (foundConversation!.parentConversationId) {
            await orchestrator.handleSubagentCompletion(conversationId);
          }
        } catch (err) {
          console.error("[approval-resume] failed:", err instanceof Error ? err.message : err);
          const conv = await conversationStore.get(conversationId);
          if (conv) {
            conv.runStatus = "idle";
            conv.updatedAt = Date.now();
            await conversationStore.update(conv);
          }
        }
      })();
      if (waitUntilHook) {
        waitUntilHook(resumeWork);
      } else {
        await resumeWork;
      }

      writeJson(response, 200, { ok: true, approvalId, approved, batchComplete: true } satisfies ApiApprovalResponse);
      return;
    }

    const conversationEventsMatch = pathname.match(
      /^\/api\/conversations\/([^/]+)\/events$/,
    );
    if (conversationEventsMatch && request.method === "GET") {
      const conversationId = decodeURIComponent(conversationEventsMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
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
        response.write("event: stream:end\ndata: {}\n\n");
        response.end();
        return;
      }
      const liveOnly = (request.url ?? "").includes("live_only=true");
      if (!liveOnly) {
        for (const bufferedEvent of stream.buffer) {
          try {
            response.write(formatSseEvent(bufferedEvent));
          } catch {
            response.end();
            return;
          }
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

    const subagentsMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/subagents$/);
    if (subagentsMatch && request.method === "GET") {
      const parentId = decodeURIComponent(subagentsMatch[1] ?? "");
      // Use summaries to find child IDs, then only load those child files
      const allSummaries = await conversationStore.listSummaries(ownerId, ctx.tenantId);
      const childSummaries = allSummaries.filter((s) => s.parentConversationId === parentId);
      const subagents: ApiSubagentSummary[] = [];
      for (const s of childSummaries) {
        const c = await conversationStore.get(s.conversationId);
        if (c) {
          subagents.push({
            conversationId: c.conversationId,
            title: c.title,
            task: c.subagentMeta?.task ?? c.title,
            status: c.subagentMeta?.status ?? "stopped",
            messageCount: c.messages.length,
            hasPendingApprovals: Array.isArray(c.pendingApprovals) && c.pendingApprovals.length > 0,
            createdAt: String(c.createdAt),
            updatedAt: String(c.updatedAt),
          });
        }
      }
      writeJson(response, 200, { subagents });
      return;
    }

    const todosMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/todos$/);
    if (todosMatch && request.method === "GET") {
      const conversationId = decodeURIComponent(todosMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, { code: "CONVERSATION_NOT_FOUND", message: "Conversation not found" });
        return;
      }
      const todos = await harness.getTodos(conversationId);
      writeJson(response, 200, { todos });
      return;
    }

    // Cheap status endpoint — column-only reads + in-memory state. Used by
    // the web UI poll loop to check whether the full conversation needs to
    // be refetched. Intentionally kept minimal: returning extra fields here
    // re-creates the egress problem the endpoint exists to avoid.
    const conversationStatusMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/status$/);
    if (conversationStatusMatch && request.method === "GET") {
      const conversationId = decodeURIComponent(conversationStatusMatch[1] ?? "");
      const snapshot = await conversationStore.getStatusSnapshot(conversationId);
      if (!snapshot || !canAccessConversation(snapshot)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      const activeStream = conversationEventStreams.get(conversationId);
      const hasActiveRun =
        (!!activeStream && !activeStream.finished) || snapshot.runStatus === "running";
      const hasRunningSubagents = !snapshot.parentConversationId
        ? hasRunningSubagentsForParent(conversationId, snapshot.ownerId)
        : false;
      let subagentPendingApprovalsCount = 0;
      if (!snapshot.parentConversationId) {
        for (const [, pa] of pendingSubagentApprovals) {
          if (pa.parentConversationId === conversationId) subagentPendingApprovalsCount += 1;
        }
      }
      const needsContinuation =
        !hasActiveRun && snapshot.hasContinuationMessages && !snapshot.hasPendingApprovals;
      writeJson(response, 200, {
        conversationId,
        updatedAt: snapshot.updatedAt,
        messageCount: snapshot.messageCount,
        hasPendingApprovals: snapshot.hasPendingApprovals,
        subagentPendingApprovalsCount,
        hasActiveRun,
        hasRunningSubagents,
        needsContinuation,
      });
      return;
    }

    const conversationPathMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (conversationPathMatch) {
      const conversationId = decodeURIComponent(conversationPathMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      if (request.method === "GET") {
        const storedPending = Array.isArray(conversation.pendingApprovals)
          ? conversation.pendingApprovals.map(a => ({
              approvalId: a.approvalId,
              runId: a.runId,
              tool: a.tool,
              input: a.input,
              decision: a.decision,
            }))
          : [];
        // Collect pending approvals from subagent conversations (in-memory map, no disk I/O)
        const subagentPending: Array<{ approvalId: string; tool: string; input: unknown; subagentId: string }> = [];
        if (!conversation.parentConversationId) {
          for (const [aid, pa] of pendingSubagentApprovals) {
            if (pa.parentConversationId === conversationId) {
              subagentPending.push({
                approvalId: aid,
                tool: pa.checkpoint.tool,
                input: pa.checkpoint.input,
                subagentId: pa.childConversationId,
              });
            }
          }
        }
        const activeStream = conversationEventStreams.get(conversationId);
        const hasActiveRun = (!!activeStream && !activeStream.finished) || conversation.runStatus === "running";
        const hasRunningSubagents = !conversation.parentConversationId
          ? hasRunningSubagentsForParent(conversationId, conversation.ownerId)
          : false;
        const hasPendingCallbackResults = Array.isArray(conversation.pendingSubagentResults)
          && conversation.pendingSubagentResults.length > 0;
        const hasPendingApprovals = Array.isArray(conversation.pendingApprovals)
          && conversation.pendingApprovals.length > 0;
        const needsContinuation = !hasActiveRun
          && Array.isArray(conversation._continuationMessages)
          && conversation._continuationMessages.length > 0
          && !hasPendingApprovals;
        writeJson(response, 200, {
          conversation: {
            ...conversation,
            messages: conversation.messages.map(normalizeMessageForClient).filter((m): m is Message => m !== null),
            pendingApprovals: storedPending,
            _continuationMessages: undefined,
            _harnessMessages: undefined,
            // The browser has no use for the archive; make sure we never ship
            // it back even if the conversation was loaded via getWithArchive.
            _toolResultArchive: undefined,
          },
          subagentPendingApprovals: subagentPending,
          hasActiveRun: hasActiveRun || hasPendingCallbackResults,
          hasRunningSubagents,
          needsContinuation,
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
        // Cascade: stop and delete all child subagent conversations
        const allSummaries = await conversationStore.listSummaries(ownerId, ctx.tenantId);
        const childIds = allSummaries
          .filter((s) => s.parentConversationId === conversationId)
          .map((s) => s.conversationId);
        for (const childId of childIds) {
          const activeChild = activeSubagentRuns.get(childId);
          if (activeChild) activeChild.abortController.abort();
          activeSubagentRuns.delete(childId);
          activeConversationRuns.delete(childId);
          await conversationStore.delete(childId);
        }
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
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      const activeRun = activeConversationRuns.get(conversationId);
      if (!activeRun || (ctx.tenantId !== undefined && activeRun.ownerId !== ownerId)) {
        writeJson(response, 200, {
          ok: true,
          stopped: false,
        } satisfies ApiStopRunResponse);
        return;
      }
      if (activeRun.abortController.signal.aborted) {
        activeConversationRuns.delete(conversationId);
        writeJson(response, 200, {
          ok: true,
          stopped: false,
        } satisfies ApiStopRunResponse);
        return;
      }
      if (requestedRunId && activeRun.runId !== requestedRunId) {
        writeJson(response, 200, {
          ok: true,
          stopped: false,
          runId: activeRun.runId ?? undefined,
        } satisfies ApiStopRunResponse);
        return;
      }
      if (!requestedRunId) {
        writeJson(response, 200, {
          ok: true,
          stopped: false,
          runId: activeRun.runId ?? undefined,
        } satisfies ApiStopRunResponse);
        return;
      }
      activeRun.abortController.abort();
      await clearPendingApprovalsForConversation(conversationId);
      writeJson(response, 200, {
        ok: true,
        stopped: true,
        runId: activeRun.runId ?? undefined,
      } satisfies ApiStopRunResponse);
      return;
    }

    const uploadMatch = pathname.match(/^\/api\/uploads\/(.+)$/);
    if (uploadMatch && request.method === "GET") {
      const key = decodeURIComponent(uploadMatch[1] ?? "");
      try {
        const data = await uploadStore.get(key);
        const ext = key.split(".").pop() ?? "";
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
          pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm",
          mp3: "audio/mpeg", wav: "audio/wav", txt: "text/plain",
          json: "application/json", csv: "text/csv", html: "text/html",
        };
        response.writeHead(200, {
          "Content-Type": mimeMap[ext] ?? "application/octet-stream",
          "Content-Length": data.length,
          "Cache-Control": "public, max-age=86400",
        });
        response.end(data);
      } catch {
        writeJson(response, 404, { code: "NOT_FOUND", message: "Upload not found" });
      }
      return;
    }

    const vfsMatch = pathname.match(/^\/api\/vfs\/(.+)$/);
    if (vfsMatch && request.method === "GET") {
      const vfsPath = "/" + decodeURIComponent(vfsMatch[1] ?? "");
      const tenantId = ctx.tenantId ?? "__default__";
      const engine = harness.storageEngine;
      if (!engine) {
        writeJson(response, 500, { code: "NO_ENGINE", message: "Storage engine not available" });
        return;
      }
      try {
        const stat = await engine.vfs.stat(tenantId, vfsPath);
        if (!stat || stat.type !== "file") {
          writeJson(response, 404, { code: "NOT_FOUND", message: "File not found in VFS" });
          return;
        }
        const data = await engine.vfs.readFile(tenantId, vfsPath);
        const ext = vfsPath.split(".").pop()?.toLowerCase() ?? "";
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
          gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
          pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm",
          mp3: "audio/mpeg", wav: "audio/wav", txt: "text/plain",
          json: "application/json", csv: "text/csv", html: "text/html",
          xml: "application/xml", zip: "application/zip",
          doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        };
        const contentType = stat.mimeType ?? mimeMap[ext] ?? "application/octet-stream";
        const filename = vfsPath.split("/").pop() ?? "download";
        const inline = contentType.startsWith("image/") || contentType.startsWith("text/") || contentType === "application/pdf";
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": data.length,
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
          "Cache-Control": "no-cache",
        });
        response.end(Buffer.from(data));
      } catch {
        writeJson(response, 404, { code: "NOT_FOUND", message: "File not found in VFS" });
      }
      return;
    }

    if (pathname === "/api/slash-commands" && request.method === "GET") {
      const skills: ApiSlashCommand[] = harness.listSkills().map((s) => ({
        command: "/" + s.name,
        description: s.description,
        type: "skill" as const,
      }));
      const builtIn: ApiSlashCommand[] = [
        { command: "/compact", description: "Compact conversation context", type: "command" as const },
      ];
      writeJson(response, 200, { commands: [...builtIn, ...skills] });
      return;
    }

    const conversationCompactMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/compact$/);
    if (conversationCompactMatch && request.method === "POST") {
      const conversationId = decodeURIComponent(conversationCompactMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      const activeRun = activeConversationRuns.get(conversationId);
      if (activeRun && activeRun.ownerId === ownerId && !activeRun.abortController.signal.aborted) {
        writeJson(response, 409, {
          code: "RUN_IN_PROGRESS",
          message: "Cannot compact while a run is active",
        });
        return;
      }
      const body = (await readRequestBody(request)) as { instructions?: string };
      const instructions = typeof body.instructions === "string" ? body.instructions.trim() || undefined : undefined;
      const result = await harness.compact(
        conversation.messages,
        instructions ? { instructions } : undefined,
      );
      if (result.compacted) {
        const existingHistory = conversation.compactedHistory ?? [];
        const preservedCount = result.messages.length - 1; // exclude summary
        const removedCount = conversation.messages.length - preservedCount;
        conversation.compactedHistory = [
          ...existingHistory,
          ...conversation.messages.slice(0, removedCount),
        ];
        conversation.messages = result.messages;
        conversation._harnessMessages = undefined;
        await conversationStore.update(conversation);
      }
      writeJson(response, 200, {
        compacted: result.compacted,
        messagesBefore: result.messagesBefore ?? 0,
        messagesAfter: result.messagesAfter ?? 0,
        warning: result.warning,
      } satisfies ApiCompactResponse);
      return;
    }

    // ── Public continuation endpoint (SSE) ──
    const conversationContinueMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/continue$/);
    if (conversationContinueMatch && request.method === "POST") {
      const conversationId = decodeURIComponent(conversationContinueMatch[1] ?? "");
      const conversation = await conversationStore.get(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      if (conversation.parentConversationId) {
        writeJson(response, 403, {
          code: "SUBAGENT_READ_ONLY",
          message: "Subagent conversations are read-only.",
        });
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const unsubSubagentEvents = onConversationEvent(conversationId, (evt) => {
        if (evt.type.startsWith("subagent:")) {
          try { response.write(formatSseEvent(evt)); } catch {}
        }
      });

      let eventCount = 0;
      try {
        await runContinuation(conversationId, async (event) => {
          eventCount++;
          let sseEvent: AgentEvent = event;
          if (sseEvent.type === "run:completed") {
            const hasPendingSubagents = await hasPendingSubagentWorkForParent(conversationId, ownerId);
            const stripped = { ...sseEvent, result: { ...sseEvent.result, continuationMessages: undefined } };
            sseEvent = hasPendingSubagents ? { ...stripped, pendingSubagents: true } : stripped;
          }
          try {
            response.write(formatSseEvent(sseEvent));
          } catch {
            // Client disconnected — continue processing so the run completes
          }
          emitBrowserStatusIfActive(conversationId, event, response);
        });
      } catch (err) {
        const errorEvent: AgentEvent = {
          type: "run:error",
          runId: "",
          error: { code: "CONTINUATION_ERROR", message: err instanceof Error ? err.message : String(err) },
        };
        try { response.write(formatSseEvent(errorEvent)); } catch {}
      } finally {
        unsubSubagentEvents();
      }

      if (eventCount === 0) {
        try { response.write("event: stream:end\ndata: {}\n\n"); } catch {}
      } else {
        // If the run produced events and another continuation is needed,
        // fire a delayed safety net in case the client disconnects before
        // POSTing the next /continue.
        const freshConv = await conversationStore.get(conversationId);
        if (
          freshConv?._continuationMessages?.length &&
          (!Array.isArray(freshConv.pendingApprovals) || freshConv.pendingApprovals.length === 0)
        ) {
          doWaitUntil(
            new Promise(r => setTimeout(r, 3000)).then(() =>
              selfFetchWithRetry(`/api/internal/continue/${encodeURIComponent(conversationId)}`),
            ),
          );
        }
      }
      response.end();
      return;
    }

    const conversationMessageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (conversationMessageMatch && request.method === "POST") {
      const conversationId = decodeURIComponent(conversationMessageMatch[1] ?? "");
      // getWithArchive — conversation feeds withToolResultArchiveParam when
      // the turn below calls executeConversationTurn.
      const conversation = await conversationStore.getWithArchive(conversationId);
      if (!conversation || !canAccessConversation(conversation)) {
        writeJson(response, 404, {
          code: "CONVERSATION_NOT_FOUND",
          message: "Conversation not found",
        });
        return;
      }
      if (conversation.parentConversationId) {
        writeJson(response, 403, {
          code: "SUBAGENT_READ_ONLY",
          message: "Subagent conversations are read-only. Only the parent agent can send messages.",
        });
        return;
      }
      let messageText = "";
      let bodyParameters: Record<string, unknown> | undefined;
      let files: FileInput[] = [];

      const contentType = request.headers["content-type"] ?? "";
      if (contentType.includes("multipart/form-data")) {
        const parsed = await parseMultipartRequest(request);
        messageText = parsed.message.trim();
        bodyParameters = parsed.parameters;
        files = parsed.files;
      } else {
        const body = (await readRequestBody(request)) as {
          message?: string;
          parameters?: Record<string, unknown>;
          files?: Array<{ data?: string; mediaType?: string; filename?: string }>;
        };
        messageText = body.message?.trim() ?? "";
        bodyParameters = body.parameters;
        if (Array.isArray(body.files)) {
          files = body.files
            .filter((f): f is { data: string; mediaType: string; filename?: string } =>
              typeof f.data === "string" && typeof f.mediaType === "string",
            );
        }
      }
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
        "X-Accel-Buffering": "no",
      });
      const canonicalHistory = resolveRunRequest(conversation, {
        conversationId,
        messages: conversation.messages,
      });
      const shouldRebuildCanonical = canonicalHistory.shouldRebuildCanonical;
      const harnessMessages = [...canonicalHistory.messages];
      const historyMessages = [...conversation.messages];
      const preRunMessages = [...conversation.messages];
      console.info(
        `[poncho] conversation="${conversationId}" history_source=${canonicalHistory.source}`,
      );
      let latestRunId = conversation.runtimeRunId ?? "";
      let userContent: Message["content"] | undefined = messageText;
      if (files.length > 0) {
        try {
          const uploadedParts = await Promise.all(
            files.map(async (f) => {
              const buf = Buffer.from(f.data, "base64");
              const key = deriveUploadKey(buf, f.mediaType);
              const ref = await uploadStore.put(key, buf, f.mediaType);
              return {
                type: "file" as const,
                data: ref,
                mediaType: f.mediaType,
                filename: f.filename,
              };
            }),
          );
          userContent = [
            { type: "text" as const, text: messageText },
            ...uploadedParts,
          ];
        } catch (uploadErr) {
          const errMsg = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
          console.error("[poncho] File upload failed:", errMsg);
          const errorEvent: AgentEvent = {
            type: "run:error",
            runId: "",
            error: { code: "UPLOAD_ERROR", message: `File upload failed: ${errMsg}` },
          };
          broadcastEvent(conversationId, errorEvent);
          finishConversationStream(conversationId);
          activeConversationRuns.delete(conversationId);
          response.end();
          return;
        }
      }
      const unsubSubagentEvents = onConversationEvent(conversationId, (evt) => {
        if (evt.type.startsWith("subagent:")) {
          try { response.write(formatSseEvent(evt)); } catch {}
        }
      });

      const draft = createTurnDraftState();
      let checkpointedRun = false;
      let runCancelled = false;
      let runContinuationMessages: Message[] | undefined;

      const buildMessages = (): Message[] => {
        const draftSections = cloneSections(draft.sections);
        if (draft.currentTools.length > 0) {
          draftSections.push({ type: "tools", content: [...draft.currentTools] });
        }
        if (draft.currentText.length > 0) {
          draftSections.push({ type: "text", content: draft.currentText });
        }
        const userTurn: Message[] = userContent != null
          ? [{ role: "user" as const, content: userContent }]
          : [];
        const hasDraftContent =
          draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0 || draftSections.length > 0;
        if (!hasDraftContent) {
          return [...historyMessages, ...userTurn];
        }
        return [
          ...historyMessages,
          ...userTurn,
          {
            role: "assistant" as const,
            content: draft.assistantResponse,
            metadata: buildAssistantMetadata(draft, draftSections),
          },
        ];
      };

      const persistDraftAssistantTurn = async (): Promise<void> => {
        if (draft.assistantResponse.length === 0 && draft.toolTimeline.length === 0) return;
        conversation.messages = buildMessages();
        conversation.updatedAt = Date.now();
        await conversationStore.update(conversation);
      };

      try {
        {
          conversation.messages = [...historyMessages, { role: "user", content: userContent! }];
          conversation.subagentCallbackCount = 0;
          conversation._continuationCount = undefined;
          conversation.updatedAt = Date.now();
          conversationStore.update(conversation).catch((err) => {
            console.error("[poncho] Failed to persist user turn:", err);
          });
        }

        const execution = await executeConversationTurn({
          harness,
          runInput: {
            task: messageText,
            conversationId,
            tenantId: ctx.tenantId ?? undefined,
            parameters: withToolResultArchiveParam({
              ...(bodyParameters ?? {}),
              ...buildRecallParams({ ownerId, tenantId: ctx.tenantId, excludeConversationId: conversationId }),
              __activeConversationId: conversationId,
              __ownerId: ownerId,
            }, conversation),
            messages: harnessMessages,
            files: files.length > 0 ? files : undefined,
            abortSignal: abortController.signal,
          },
          initialContextTokens: conversation.contextTokens ?? 0,
          initialContextWindow: conversation.contextWindow ?? 0,
          onEvent: async (event, eventDraft) => {
            draft.assistantResponse = eventDraft.assistantResponse;
            draft.toolTimeline = eventDraft.toolTimeline;
            draft.sections = eventDraft.sections;
            draft.currentTools = eventDraft.currentTools;
            draft.currentText = eventDraft.currentText;

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
            if (event.type === "compaction:completed") {
              if (event.compactedMessages) {
                historyMessages.length = 0;
                historyMessages.push(...event.compactedMessages);

                const preservedFromHistory = historyMessages.length - 1;
                const removedCount = preRunMessages.length - Math.max(0, preservedFromHistory);
                const existingHistory = conversation.compactedHistory ?? [];
                conversation.compactedHistory = [
                  ...existingHistory,
                  ...preRunMessages.slice(0, removedCount),
                ];
              }
            }
            if (event.type === "step:completed") {
              await persistDraftAssistantTurn();
            }
            if (event.type === "tool:approval:required") {
              const toolText = `- approval required \`${event.tool}\``;
              draft.toolTimeline.push(toolText);
              draft.currentTools.push(toolText);
              const existingApprovals = Array.isArray(conversation.pendingApprovals)
                ? conversation.pendingApprovals
                : [];
              if (!existingApprovals.some((approval) => approval.approvalId === event.approvalId)) {
                conversation.pendingApprovals = [
                  ...existingApprovals,
                  {
                    approvalId: event.approvalId,
                    runId: latestRunId || conversation.runtimeRunId || "",
                    tool: event.tool,
                    toolCallId: undefined,
                    input: (event.input ?? {}) as Record<string, unknown>,
                    checkpointMessages: undefined,
                    baseMessageCount: historyMessages.length,
                    pendingToolCalls: [],
                  },
                ];
                conversation.updatedAt = Date.now();
                await conversationStore.update(conversation);
              }
              await persistDraftAssistantTurn();
            }
            if (event.type === "tool:approval:checkpoint") {
              conversation.messages = buildMessages();
              conversation.pendingApprovals = buildApprovalCheckpoints({
                approvals: event.approvals,
                runId: latestRunId,
                checkpointMessages: event.checkpointMessages,
                baseMessageCount: historyMessages.length,
                pendingToolCalls: event.pendingToolCalls,
              });
              conversation._toolResultArchive = harness.getToolResultArchive(conversationId);
              conversation.updatedAt = Date.now();
              await conversationStore.update(conversation);
              checkpointedRun = true;
            }
            if (event.type === "run:completed") {
              if (event.result.continuation && event.result.continuationMessages) {
                runContinuationMessages = event.result.continuationMessages;

                conversation.messages = buildMessages();
                conversation._continuationMessages = runContinuationMessages;
                conversation._harnessMessages = runContinuationMessages;
                conversation._toolResultArchive = harness.getToolResultArchive(conversationId);
                conversation.runtimeRunId = latestRunId || conversation.runtimeRunId;
                if (!checkpointedRun) {
                  conversation.pendingApprovals = [];
                }
                if ((event.result.contextTokens ?? 0) > 0) conversation.contextTokens = event.result.contextTokens!;
                if ((event.result.contextWindow ?? 0) > 0) conversation.contextWindow = event.result.contextWindow!;
                conversation.updatedAt = Date.now();
                await conversationStore.update(conversation);

                if (!checkpointedRun) {
                  doWaitUntil(
                    new Promise(r => setTimeout(r, 3000)).then(() =>
                      selfFetchWithRetry(`/api/internal/continue/${encodeURIComponent(conversationId)}`),
                    ),
                  );
                }
              }
            }

            await telemetry.emit(event);
            let sseEvent: AgentEvent = event.type === "compaction:completed" && event.compactedMessages
              ? { ...event, compactedMessages: undefined }
              : event;
            if (sseEvent.type === "run:completed") {
              const hasPendingSubagents = await hasPendingSubagentWorkForParent(conversationId, ownerId);
              const stripped = { ...sseEvent, result: { ...sseEvent.result, continuationMessages: undefined } };
              if (hasPendingSubagents) {
                sseEvent = { ...stripped, pendingSubagents: true };
              } else {
                sseEvent = stripped;
              }
            }
            broadcastEvent(conversationId, sseEvent);
            try {
              response.write(formatSseEvent(sseEvent));
            } catch {
              // Client disconnected — continue processing so the run completes.
            }
            emitBrowserStatusIfActive(conversationId, event, response);
          },
        });

        flushTurnDraft(draft);
        latestRunId = execution.latestRunId || latestRunId;

        if (!checkpointedRun && !runContinuationMessages) {
          conversation.messages = buildMessages();
          applyTurnMetadata(conversation, {
            latestRunId,
            contextTokens: execution.runContextTokens,
            contextWindow: execution.runContextWindow,
            harnessMessages: execution.runHarnessMessages,
            toolResultArchive: harness.getToolResultArchive(conversationId),
          }, { shouldRebuildCanonical });
          await conversationStore.update(conversation);
        }
      } catch (error) {
        flushTurnDraft(draft);
        if (abortController.signal.aborted || runCancelled) {
          if (draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0 || draft.sections.length > 0) {
            conversation.messages = buildMessages();
            conversation.updatedAt = Date.now();
            await conversationStore.update(conversation);
          }
          if (!checkpointedRun) {
            await clearPendingApprovalsForConversation(conversationId);
          }
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
          if (draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0 || draft.sections.length > 0) {
            conversation.messages = buildMessages();
            conversation.updatedAt = Date.now();
            await conversationStore.update(conversation);
          }
        }
      } finally {
        unsubSubagentEvents();
        const active = activeConversationRuns.get(conversationId);
        if (active && active.abortController === abortController) {
          activeConversationRuns.delete(conversationId);
        }
        if (latestRunId) {
          runOwners.delete(latestRunId);
          runConversations.delete(latestRunId);
        }

        const hadDeferred = pendingCallbackNeeded.delete(conversationId);
        const freshConv = await conversationStore.get(conversationId);
        const needsCallback = hadDeferred || !!freshConv?.pendingSubagentResults?.length;
        const hasRunningChildren = Array.from(activeSubagentRuns.values()).some(
          (run) => run.parentConversationId === conversationId,
        );

        if (!needsCallback && !hasRunningChildren) {
          finishConversationStream(conversationId);
        }

        try {
          response.end();
        } catch {
          // Already closed.
        }
        if (needsCallback) {
          processSubagentCallback(conversationId, true).catch(err =>
            console.error(`[poncho][subagent-callback] Post-run callback failed:`, err instanceof Error ? err.message : err),
          );
        }
      }
      return;
    }

    // ── Cron job endpoint ──────────────────────────────────────────
    const cronMatch = pathname.match(/^\/api\/cron\/([^/]+)$/);
    if (cronMatch && (request.method === "GET" || request.method === "POST")) {
      const jobName = decodeURIComponent(cronMatch[1] ?? "");
      const cronJob = cronJobs[jobName];
      if (!cronJob) {
        writeJson(response, 404, {
          code: "CRON_JOB_NOT_FOUND",
          message: `Cron job "${jobName}" is not defined in AGENT.md`,
        });
        return;
      }

      const urlObj = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      const cronOwnerId = ownerId;
      const start = Date.now();

      if (cronJob.channel) {
        const adapter = messagingAdapters.get(cronJob.channel);
        if (!adapter) {
          writeJson(response, 200, {
            status: "skipped",
            reason: `${cronJob.channel} adapter not available`,
            duration: Date.now() - start,
          });
          return;
        }

        try {
          const summaries = await conversationStore.listSummaries(cronOwnerId);
          const targetSummaries = new Map<string, ConversationSummary>();
          for (const s of summaries) {
            if (s.channelMeta?.platform !== cronJob.channel) continue;
            const key = s.channelMeta.channelId;
            const existing = targetSummaries.get(key);
            if (!existing || s.updatedAt > (existing.updatedAt ?? 0)) {
              targetSummaries.set(key, s);
            }
          }

          if (targetSummaries.size === 0) {
            writeJson(response, 200, {
              status: "skipped",
              reason: `no known ${cronJob.channel} chats`,
              duration: Date.now() - start,
            });
            return;
          }

          const chatResults: Array<{ chatId: string; status: string; steps?: number }> = [];
          for (const [chatId, summary] of targetSummaries) {
            // getWithArchive — conv feeds runCronAgent below which needs the
            // archive to reseed the harness.
            const conv = await conversationStore.getWithArchive(summary.conversationId);
            if (!conv) continue;

            const task = `[Scheduled: ${jobName}]\n${cronJob.task}`;
            const historySelection = resolveRunRequest(conv, {
              conversationId: conv.conversationId,
              messages: conv.messages,
            });
            const historyMessages = [...historySelection.messages];
            try {
              const result = await runCronAgent(harness, task, conv.conversationId, historyMessages,
                conv._toolResultArchive,
                async (event) => { await telemetry.emit(event); },
              );

              const freshConv = await conversationStore.get(conv.conversationId);
              if (freshConv) {
                appendCronTurn(freshConv, task, result);
                applyTurnMetadata(freshConv, result, {
                  clearContinuation: false,
                  clearApprovals: false,
                  setIdle: false,
                  shouldRebuildCanonical: historySelection.shouldRebuildCanonical,
                });
                await conversationStore.update(freshConv);
              }

              if (result.response) {
                try {
                  await adapter.sendReply(
                    {
                      channelId: chatId,
                      platformThreadId: (freshConv ?? conv).channelMeta?.platformThreadId ?? chatId,
                    },
                    result.response,
                  );
                } catch (sendError) {
                  console.error(`[cron] ${jobName}: send to ${chatId} failed:`, sendError instanceof Error ? sendError.message : sendError);
                }
              }
              chatResults.push({ chatId, status: "completed", steps: result.steps });
            } catch (runError) {
              chatResults.push({ chatId, status: "error" });
              console.error(`[cron] ${jobName}: run for chat ${chatId} failed:`, runError instanceof Error ? runError.message : runError);
            }
          }

          writeJson(response, 200, {
            status: "completed",
            chats: chatResults.length,
            results: chatResults,
            duration: Date.now() - start,
          });
        } catch (error) {
          writeJson(response, 500, {
            code: "CRON_RUN_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
        return;
      }

      try {
        const timestamp = new Date().toISOString();
        const conversation = await conversationStore.create(
          cronOwnerId,
          `[cron] ${jobName} ${timestamp}`,
        );

        const convId = conversation.conversationId;
        activeConversationRuns.set(convId, {
          ownerId: conversation.ownerId,
          abortController: new AbortController(),
          runId: null,
        });

        try {
          const result = await runCronAgent(harness, cronJob.task, convId, [],
            conversation._toolResultArchive,
            async (event) => {
              broadcastEvent(convId, event);
              await telemetry.emit(event);
            },
          );
          finishConversationStream(convId);

          const freshConv = await conversationStore.get(convId);
          if (freshConv) {
            freshConv.messages = buildCronMessages(cronJob.task, [], result);
            applyTurnMetadata(freshConv, result, {
              clearApprovals: false,
              setIdle: false,
            });
            await conversationStore.update(freshConv);
          }

          const pruneWork = pruneCronConversations(
            conversationStore, cronOwnerId, jobName, cronJob.maxRuns ?? 5,
          ).then(n => {
            if (n > 0) process.stdout.write(`[cron] ${jobName}: pruned ${n} old conversation${n === 1 ? "" : "s"}\n`);
          }).catch(err =>
            console.error(`[cron] ${jobName}: prune failed:`, err instanceof Error ? err.message : err),
          );
          doWaitUntil(pruneWork);

          if (result.continuation) {
            const work = selfFetchWithRetry(`/api/internal/continue/${encodeURIComponent(convId)}`).catch(err =>
              console.error(`[poncho][cron] Continuation self-fetch failed:`, err instanceof Error ? err.message : err),
            );
            doWaitUntil(work);
            writeJson(response, 200, {
              conversationId: convId,
              status: "continued",
              duration: Date.now() - start,
            });
            return;
          }

          writeJson(response, 200, {
            conversationId: convId,
            status: "completed",
            response: result.response.slice(0, 500),
            duration: Date.now() - start,
            steps: result.steps,
          });
        } finally {
          activeConversationRuns.delete(convId);
          const hadDeferred = pendingCallbackNeeded.delete(convId);
          const checkConv = await conversationStore.get(convId);
          if (hadDeferred || checkConv?.pendingSubagentResults?.length) {
            if (isServerless) {
              selfFetchWithRetry(`/api/internal/conversations/${encodeURIComponent(convId)}/subagent-callback`).catch(err =>
                console.error(`[cron] subagent callback self-fetch failed:`, err instanceof Error ? err.message : err),
              );
            } else {
              processSubagentCallback(convId, true).catch(err =>
                console.error(`[cron] subagent callback failed:`, err instanceof Error ? err.message : err),
              );
            }
          }
        }
      } catch (error) {
        writeJson(response, 500, {
          code: "CRON_RUN_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
      return;
    }

    // ── Reminders check endpoint ────────────────────────────────────
    if (pathname === "/api/reminders/check" && (request.method === "GET" || request.method === "POST")) {
      const result = await checkAndFireReminders();
      writeJson(response, 200, result);
      return;
    }

    writeJson(response, 404, { error: "Not found" });
  };

  // ── Reminder polling logic ──────────────────────────────────────
  const DEFAULT_POLL_SCHEDULE = "*/10 * * * *";

  const pollScheduleToMs = (schedule: string): number => {
    const m = schedule.match(/^\*\/(\d+)\s/);
    if (m) return Number(m[1]) * 60 * 1000;
    return 10 * 60 * 1000;
  };

  const reminderPollSchedule = config?.reminders?.pollSchedule ?? DEFAULT_POLL_SCHEDULE;
  const reminderPollWindowMs = pollScheduleToMs(reminderPollSchedule);

  const checkAndFireReminders = async (): Promise<{
    fired: string[];
    count: number;
    duration: number;
  }> => {
    const reminderStore = harness.reminderStore;
    if (!reminderStore) return { fired: [], count: 0, duration: 0 };

    const start = Date.now();
    const firedIds: string[] = [];

    try {
      const reminders = await reminderStore.list();
      const cutoff = Date.now() + reminderPollWindowMs;
      const due = reminders.filter((r) => r.status === "pending" && r.scheduledAt <= cutoff);

      for (const reminder of due) {
        try {
          // For recurring reminders, compute the next occurrence before any
          // state changes so we can reschedule. For one-off reminders, delete.
          const nextScheduledAt = computeNextOccurrence(reminder);
          if (nextScheduledAt) {
            await reminderStore.update(reminder.id, {
              scheduledAt: nextScheduledAt,
              occurrenceCount: (reminder.occurrenceCount ?? 0) + 1,
            });
          } else {
            await reminderStore.delete(reminder.id);
          }

          const originConv = reminder.conversationId
            // getWithArchive — originConv feeds runCronAgent below which
            // needs the archive to reseed the harness.
            ? await conversationStore.getWithArchive(reminder.conversationId)
            : undefined;
          const channelMeta = originConv?.channelMeta;

          const isRecurring = !!reminder.recurrence;
          const recurrenceNote = isRecurring && nextScheduledAt
            ? `\nNext occurrence: ${new Date(nextScheduledAt).toISOString()}`
            : isRecurring
              ? "\nThis was the final occurrence."
              : "";

          const framedMessage =
            `[Reminder] A reminder you previously set has fired.\n` +
            `Task: "${reminder.task}"\n` +
            `Originally set at: ${new Date(reminder.createdAt).toISOString()}\n` +
            `Scheduled for: ${new Date(reminder.scheduledAt).toISOString()}` +
            recurrenceNote;

          if (channelMeta) {
            const adapter = messagingAdapters.get(channelMeta.platform);
            if (adapter && originConv) {
              const result = await runCronAgent(
                harness, framedMessage, originConv.conversationId,
                originConv.messages ?? [],
                originConv._toolResultArchive,
              );
              if (result.response) {
                try {
                  await adapter.sendReply(
                    {
                      channelId: channelMeta.channelId,
                      platformThreadId: channelMeta.platformThreadId ?? channelMeta.channelId,
                    },
                    result.response,
                  );
                } catch (sendError) {
                  console.error(`[reminder] Send to ${channelMeta.platform} failed:`, sendError instanceof Error ? sendError.message : sendError);
                }
              }
              const freshConv = await conversationStore.get(originConv.conversationId);
              if (freshConv) {
                appendCronTurn(freshConv, framedMessage, result);
                applyTurnMetadata(freshConv, result, {
                  clearContinuation: false,
                  clearApprovals: false,
                  setIdle: false,
                });
                await conversationStore.update(freshConv);
              }
            }
          } else {
            const timestamp = new Date().toISOString();
            const conversation = await conversationStore.create(
              reminder.ownerId ?? "local-owner",
              `[reminder] ${reminder.task.slice(0, 80)} ${timestamp}`,
            );
            const convId = conversation.conversationId;
            const result = await runCronAgent(harness, framedMessage, convId, []);
            const freshConv = await conversationStore.get(convId);
            if (freshConv) {
              freshConv.messages = buildCronMessages(framedMessage, [], result);
              applyTurnMetadata(freshConv, result, {
                clearContinuation: false,
                clearApprovals: false,
                setIdle: false,
              });
              await conversationStore.update(freshConv);
            }
          }

          firedIds.push(reminder.id);
        } catch (err) {
          console.error(`[reminder] Failed to fire reminder "${reminder.id}":`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.error("[reminder] Error checking reminders:", err instanceof Error ? err.message : err);
    }

    return { fired: firedIds, count: firedIds.length, duration: Date.now() - start };
  };

  handler._harness = harness;
  handler._cronJobs = cronJobs;
  handler._conversationStore = conversationStore;
  handler._messagingAdapters = messagingAdapters;
  handler._activeConversationRuns = activeConversationRuns;
  handler._pendingCallbackNeeded = pendingCallbackNeeded;
  handler._processSubagentCallback = processSubagentCallback;
  handler._broadcastEvent = broadcastEvent;
  handler._finishConversationStream = finishConversationStream;
  handler._checkAndFireReminders = checkAndFireReminders;
  handler._reminderPollIntervalMs = reminderPollWindowMs;

  // Recover stale subagent runs that were "running" when the server last stopped
  orchestrator.recoverStaleSubagents().catch(err =>
    console.warn("[poncho][subagent] Failed to recover stale subagent runs:", err),
  );

  return handler;
};

export const startDevServer = async (
  port: number,
  options?: { workingDir?: string },
): Promise<Server> => {
  const workingDir = options?.workingDir ?? process.cwd();
  const handler = await createRequestHandler(options);
  const server = createServer(handler);
  const actualPort = await listenOnAvailablePort(server, port);
  if (actualPort !== port) {
    process.stdout.write(`Port ${port} is in use, switched to ${actualPort}.\n`);
  }
  process.stdout.write(`Poncho dev server running at http://localhost:${actualPort}\n`);

  await checkVercelCronDrift(workingDir);

  // ── Cron scheduler ─────────────────────────────────────────────
  const { Cron } = await import("croner");
  type CronJob = InstanceType<typeof Cron>;
  let activeJobs: CronJob[] = [];

  const scheduleCronJobs = (jobs: Record<string, CronJobConfig>): void => {
    for (const job of activeJobs) {
      job.stop();
    }
    activeJobs = [];

    const entries = Object.entries(jobs);
    if (entries.length === 0) return;

    const harnessRef = handler._harness;
    const store = handler._conversationStore;
    const adapters = handler._messagingAdapters;
    const activeRuns = handler._activeConversationRuns;
    const deferredCallbacks = handler._pendingCallbackNeeded;
    const runCallback = handler._processSubagentCallback;
    if (!harnessRef || !store) return;

    for (const [jobName, config] of entries) {
      const job = new Cron(
        config.schedule,
        { timezone: config.timezone ?? "UTC" },
        async () => {
          const timestamp = new Date().toISOString();
          process.stdout.write(`[cron] ${jobName} started at ${timestamp}\n`);
          const start = Date.now();

          if (config.channel) {
            const adapter = adapters?.get(config.channel);
            if (!adapter) {
              process.stderr.write(`[cron] ${jobName}: ${config.channel} adapter not available, skipping\n`);
              return;
            }
            try {
              const summaries = await store.listSummaries("local-owner");
              const targetSummaries = new Map<string, ConversationSummary>();
              for (const s of summaries) {
                if (s.channelMeta?.platform !== config.channel) continue;
                const key = s.channelMeta.channelId;
                const existing = targetSummaries.get(key);
                if (!existing || s.updatedAt > (existing.updatedAt ?? 0)) {
                  targetSummaries.set(key, s);
                }
              }

              if (targetSummaries.size === 0) {
                process.stdout.write(`[cron] ${jobName}: no known ${config.channel} chats, skipping\n`);
                return;
              }

              let totalChats = 0;
              for (const [chatId, summary] of targetSummaries) {
                // getWithArchive — conversation feeds runCronAgent below
                // which needs the archive to reseed the harness.
                const conversation = await store.getWithArchive(summary.conversationId);
                if (!conversation) continue;

                const task = `[Scheduled: ${jobName}]\n${config.task}`;
                const historySelection = resolveRunRequest(conversation, {
                  conversationId: conversation.conversationId,
                  messages: conversation.messages,
                });
                const historyMessages = [...historySelection.messages];
                const convId = conversation.conversationId;

                activeRuns?.set(convId, {
                  ownerId: "local-owner",
                  abortController: new AbortController(),
                  runId: null,
                });
                try {
                  const broadcastCh = handler._broadcastEvent;
                  const result = await runCronAgent(harnessRef, task, convId, historyMessages,
                    conversation._toolResultArchive,
                    broadcastCh ? (ev) => broadcastCh(convId, ev) : undefined,
                  );
                  handler._finishConversationStream?.(convId);

                  const freshConv = await store.get(convId);
                  if (freshConv) {
                    appendCronTurn(freshConv, task, result);
                    applyTurnMetadata(freshConv, result, {
                      clearContinuation: false,
                      clearApprovals: false,
                      setIdle: false,
                      shouldRebuildCanonical: historySelection.shouldRebuildCanonical,
                    });
                    await store.update(freshConv);

                    if (result.response) {
                      try {
                        await adapter.sendReply(
                          {
                            channelId: chatId,
                            platformThreadId: freshConv.channelMeta?.platformThreadId ?? chatId,
                          },
                          result.response,
                        );
                      } catch (sendError) {
                        const sendMsg = sendError instanceof Error ? sendError.message : String(sendError);
                        process.stderr.write(`[cron] ${jobName}: send to ${chatId} failed: ${sendMsg}\n`);
                      }
                    }
                  }
                  totalChats++;
                } catch (runError) {
                  const runMsg = runError instanceof Error ? runError.message : String(runError);
                  process.stderr.write(`[cron] ${jobName}: run for chat ${chatId} failed: ${runMsg}\n`);
                } finally {
                  activeRuns?.delete(convId);
                  const hadDeferred = deferredCallbacks?.delete(convId) ?? false;
                  const checkConv = await store.get(convId);
                  if (hadDeferred || checkConv?.pendingSubagentResults?.length) {
                    runCallback?.(convId, true).catch((err: unknown) =>
                      console.error(`[cron] ${jobName}: subagent callback for ${chatId} failed:`, err instanceof Error ? err.message : err),
                    );
                  }
                }
              }

              const elapsed = ((Date.now() - start) / 1000).toFixed(1);
              process.stdout.write(`[cron] ${jobName} completed in ${elapsed}s (${totalChats} chats)\n`);
            } catch (error) {
              const elapsed = ((Date.now() - start) / 1000).toFixed(1);
              const msg = error instanceof Error ? error.message : String(error);
              process.stderr.write(`[cron] ${jobName} failed after ${elapsed}s: ${msg}\n`);
            }
            return;
          }

          let cronConvId: string | undefined;
          try {
            const conversation = await store.create(
              "local-owner",
              `[cron] ${jobName} ${timestamp}`,
            );
            cronConvId = conversation.conversationId;
            activeRuns?.set(cronConvId, {
              ownerId: "local-owner",
              abortController: new AbortController(),
              runId: null,
            });
            const broadcast = handler._broadcastEvent;
            const result = await runCronAgent(harnessRef, config.task, cronConvId, [],
              conversation._toolResultArchive,
              broadcast ? (ev) => broadcast(cronConvId!, ev) : undefined,
            );
            handler._finishConversationStream?.(cronConvId);
            const freshConv = await store.get(cronConvId);
            if (freshConv) {
              freshConv.messages = buildCronMessages(config.task, [], result);
              applyTurnMetadata(freshConv, result, {
                clearContinuation: false,
                clearApprovals: false,
                setIdle: false,
              });
              await store.update(freshConv);
            }
            pruneCronConversations(store, "local-owner", jobName, config.maxRuns ?? 5).then(n => {
              if (n > 0) process.stdout.write(`[cron] ${jobName}: pruned ${n} old conversation${n === 1 ? "" : "s"}\n`);
            }).catch(err =>
              console.error(`[cron] ${jobName}: prune failed:`, err instanceof Error ? err.message : err),
            );
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            process.stdout.write(
              `[cron] ${jobName} completed in ${elapsed}s (${result.steps} steps)\n`,
            );
          } catch (error) {
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            const msg = error instanceof Error ? error.message : String(error);
            process.stderr.write(
              `[cron] ${jobName} failed after ${elapsed}s: ${msg}\n`,
            );
          } finally {
            if (cronConvId) {
              activeRuns?.delete(cronConvId);
              const hadDeferred = deferredCallbacks?.delete(cronConvId) ?? false;
              const checkConv = await store.get(cronConvId);
              if (hadDeferred || checkConv?.pendingSubagentResults?.length) {
                runCallback?.(cronConvId, true).catch((err: unknown) =>
                  console.error(`[cron] ${jobName}: subagent callback failed:`, err instanceof Error ? err.message : err),
                );
              }
            }
          }
        },
      );
      activeJobs.push(job);
    }
    process.stdout.write(
      `[cron] Scheduled ${entries.length} job${entries.length === 1 ? "" : "s"}: ${entries.map(([n]) => n).join(", ")}\n`,
    );
  };

  const initialCronJobs = handler._cronJobs ?? {};
  scheduleCronJobs(initialCronJobs);

  // Hot-reload cron config when AGENT.md changes
  const agentMdPath = resolve(workingDir, "AGENT.md");
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  const watcher = fsWatch(agentMdPath, () => {
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(async () => {
      try {
        const agentMd = await readFile(agentMdPath, "utf8");
        const parsed = parseAgentMarkdown(agentMd);
        const newJobs = parsed.frontmatter.cron ?? {};
        handler._cronJobs = newJobs;
        scheduleCronJobs(newJobs);
        process.stdout.write(`[cron] Reloaded: ${Object.keys(newJobs).length} jobs scheduled\n`);
      } catch {
        // Parse errors during editing are expected; ignore
      }
    }, 500);
  });

  // ── Reminder polling ─────────────────────────────────────────────
  let reminderInterval: ReturnType<typeof setInterval> | null = null;
  if (handler._checkAndFireReminders && handler._reminderPollIntervalMs) {
    const pollMs = handler._reminderPollIntervalMs;
    const check = handler._checkAndFireReminders;
    reminderInterval = setInterval(async () => {
      try {
        const result = await check();
        if (result.count > 0) {
          process.stdout.write(
            `[reminder] Fired ${result.count} reminder${result.count === 1 ? "" : "s"} (${result.duration}ms)\n`,
          );
        }
      } catch (err) {
        console.error("[reminder] Poll error:", err instanceof Error ? err.message : err);
      }
    }, pollMs);
    process.stdout.write(`[reminder] Polling every ${Math.round(pollMs / 1000)}s\n`);
  }

  const shutdown = () => {
    watcher.close();
    if (reminderInterval) clearInterval(reminderInterval);
    for (const job of activeJobs) {
      job.stop();
    }
    server.close();
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
  const uploadStore = await createUploadStore(config?.uploads, workingDir);
  const harness = new AgentHarness({ workingDir, uploadStore });
  const telemetry = new TelemetryEmitter(config?.telemetry);
  await harness.initialize();

  const fileInputs: FileInput[] = await Promise.all(
    options.filePaths.map(async (filePath) => {
      const absPath = resolve(workingDir, filePath);
      const buf = await readFile(absPath);
      const ext = absPath.split(".").pop()?.toLowerCase() ?? "";
      return {
        data: buf.toString("base64"),
        mediaType: extToMime(ext),
        filename: basename(filePath),
      };
    }),
  );

  const input: RunInput = {
    task,
    parameters: options.params,
    files: fileInputs.length > 0 ? fileInputs : undefined,
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

  const uploadStore = await createUploadStore(config?.uploads, workingDir);
  const harness = new AgentHarness({
    workingDir,
    environment: resolveHarnessEnvironment(),
    uploadStore,
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
      }) => Promise<void>
    )({
      harness,
      params,
      workingDir,
      config,
      conversationStore: (() => {
        if (!harness.storageEngine) {
          process.stderr.write(
            "[poncho] WARNING: harness.storageEngine is undefined. " +
              "This usually means an outdated @poncho-ai/harness (< 0.37.0) is installed. " +
              "Falling back to in-memory storage — conversations will NOT be persisted. " +
              "Fix: `pnpm up @poncho-ai/harness@latest` or add a pnpm.overrides entry to force resolution.\n",
          );
          return createConversationStore(resolveStateConfig(config), { workingDir, agentId: identity.id });
        }
        return createConversationStoreFromEngine(harness.storageEngine);
      })(),
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
  if (normalizedTarget === "vercel" && !options?.force) {
    await checkVercelCronDrift(workingDir);
  }
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
    headers?: string[];
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
  const parsedHeaders: Record<string, string> | undefined =
    options.headers && options.headers.length > 0
      ? Object.fromEntries(
          options.headers.map((h) => {
            const idx = h.indexOf(":");
            if (idx < 1) {
              throw new Error(`Invalid header format "${h}". Expected "Name: value".`);
            }
            return [h.slice(0, idx).trim(), h.slice(idx + 1).trim()];
          }),
        )
      : undefined;
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
    headers: parsedHeaders,
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
    const headerKeys = entry.headers ? Object.keys(entry.headers) : [];
    const headerInfo = headerKeys.length > 0 ? `, headers=${headerKeys.join(",")}` : "";
    process.stdout.write(
      `- ${entry.name ?? entry.url} (remote: ${entry.url}, ${auth}${headerInfo})\n`,
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

  const authCommand = program.command("auth").description("Manage model provider authentication");
  authCommand
    .command("login")
    .requiredOption("--provider <provider>", "provider id (currently: openai-codex)")
    .option("--device", "use device auth flow", true)
    .action(async (options: { provider: string; device: boolean }) => {
      if (options.provider !== "openai-codex") {
        throw new Error(`Unsupported provider "${options.provider}". Try --provider openai-codex.`);
      }
      await loginOpenAICodex({ device: options.device });
    });

  authCommand
    .command("status")
    .requiredOption("--provider <provider>", "provider id (currently: openai-codex)")
    .action(async (options: { provider: string }) => {
      if (options.provider !== "openai-codex") {
        throw new Error(`Unsupported provider "${options.provider}". Try --provider openai-codex.`);
      }
      await statusOpenAICodex();
    });

  authCommand
    .command("logout")
    .requiredOption("--provider <provider>", "provider id (currently: openai-codex)")
    .action(async (options: { provider: string }) => {
      if (options.provider !== "openai-codex") {
        throw new Error(`Unsupported provider "${options.provider}". Try --provider openai-codex.`);
      }
      await logoutOpenAICodex();
    });

  authCommand
    .command("export")
    .requiredOption("--provider <provider>", "provider id (currently: openai-codex)")
    .option("--format <format>", "env|json", "env")
    .action(async (options: { provider: string; format: string }) => {
      if (options.provider !== "openai-codex") {
        throw new Error(`Unsupported provider "${options.provider}". Try --provider openai-codex.`);
      }
      if (options.format !== "env" && options.format !== "json") {
        throw new Error(`Unsupported export format "${options.format}". Use env or json.`);
      }
      await exportOpenAICodex(options.format);
    });

  authCommand
    .command("create-token")
    .description("Create a tenant-scoped JWT for development/testing")
    .requiredOption("--tenant <tenantId>", "tenant identifier (becomes JWT sub claim)")
    .option("--ttl <duration>", "token lifetime, e.g. 1h, 7d (default: no expiration)")
    .option("--meta <json>", "JSON metadata to embed in the token")
    .action(async (options: { tenant: string; ttl?: string; meta?: string }) => {
      dotenv.config();
      const tokenEnv = "PONCHO_AUTH_TOKEN";
      const signingKey = process.env[tokenEnv];
      if (!signingKey) {
        console.error(`Error: ${tokenEnv} is not set. Set it in .env or environment.`);
        process.exit(1);
      }
      const { SignJWT } = await import("jose");
      const secret = new TextEncoder().encode(signingKey);
      let metaObj: Record<string, unknown> | undefined;
      if (options.meta) {
        try {
          metaObj = JSON.parse(options.meta) as Record<string, unknown>;
        } catch {
          console.error("Error: --meta must be valid JSON");
          process.exit(1);
        }
      }
      let builder = new SignJWT(metaObj ? { meta: metaObj } : {})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(options.tenant)
        .setIssuedAt();
      if (options.ttl) {
        builder = builder.setExpirationTime(options.ttl);
      }
      const token = await builder.sign(secret);
      console.log(token);
    });

  const secretsCommand = program.command("secrets").description("Manage per-tenant secrets");

  secretsCommand
    .command("set")
    .description("Set a secret for a tenant")
    .requiredOption("--tenant <tenantId>", "tenant identifier")
    .argument("<envName>", "environment variable name")
    .argument("<value>", "secret value")
    .action(async (envName: string, value: string, options: { tenant: string }) => {
      dotenv.config();
      const authToken = process.env.PONCHO_AUTH_TOKEN;
      if (!authToken) {
        console.error("Error: PONCHO_AUTH_TOKEN is not set");
        process.exit(1);
      }
      const config = await loadPonchoConfig(process.cwd());
      const stateConfig = resolveStateConfig(config);
      const agentId = (await ensureAgentIdentity(process.cwd())).id;
      const store = createSecretsStore(agentId, authToken, stateConfig, { workingDir: process.cwd() });
      await store.set(options.tenant, envName, value);
      console.log(`Secret ${envName} set for tenant ${options.tenant}`);
    });

  secretsCommand
    .command("list")
    .description("List secrets for a tenant (names only)")
    .requiredOption("--tenant <tenantId>", "tenant identifier")
    .action(async (options: { tenant: string }) => {
      dotenv.config();
      const authToken = process.env.PONCHO_AUTH_TOKEN;
      if (!authToken) {
        console.error("Error: PONCHO_AUTH_TOKEN is not set");
        process.exit(1);
      }
      const config = await loadPonchoConfig(process.cwd());
      const stateConfig = resolveStateConfig(config);
      const agentId = (await ensureAgentIdentity(process.cwd())).id;
      const store = createSecretsStore(agentId, authToken, stateConfig, { workingDir: process.cwd() });
      const names = await store.list(options.tenant);
      if (names.length === 0) {
        console.log("No secrets set for this tenant.");
      } else {
        for (const name of names) {
          console.log(`${name} (set)`);
        }
      }
    });

  secretsCommand
    .command("delete")
    .description("Delete a tenant secret override")
    .requiredOption("--tenant <tenantId>", "tenant identifier")
    .argument("<envName>", "environment variable name to remove")
    .action(async (envName: string, options: { tenant: string }) => {
      dotenv.config();
      const authToken = process.env.PONCHO_AUTH_TOKEN;
      if (!authToken) {
        console.error("Error: PONCHO_AUTH_TOKEN is not set");
        process.exit(1);
      }
      const config = await loadPonchoConfig(process.cwd());
      const stateConfig = resolveStateConfig(config);
      const agentId = (await ensureAgentIdentity(process.cwd())).id;
      const store = createSecretsStore(agentId, authToken, stateConfig, { workingDir: process.cwd() });
      await store.delete(options.tenant, envName);
      console.log(`Secret ${envName} deleted for tenant ${options.tenant}`);
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
    .argument("[target]", "vercel|docker|lambda|fly")
    .option("--force", "overwrite existing deployment files")
    .description("Scaffold deployment files for a target")
    .action(async (target: string | undefined, options: { force?: boolean }) => {
      if (!target) {
        // No-op when called without a target (e.g. from Vercel build scripts).
        // Scaffolding is done locally via `poncho build <target>`.
        return;
      }
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
    .option("--header <header>", "custom header as 'Name: value' (repeatable)", (value, all: string[]) => {
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
          header: string[];
        },
      ) => {
        await mcpAdd(process.cwd(), {
          url: options.url,
          name: options.name,
          envVars: options.env,
          authBearerEnv: options.authBearerEnv,
          headers: options.header,
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
