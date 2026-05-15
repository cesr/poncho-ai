import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AgentEvent,
  ContentPart,
  FileContentPart,
  Message,
  RunInput,
  RunResult,
  TextContentPart,
  ToolContext,
  ToolDefinition,
} from "@poncho-ai/sdk";
import { defineTool, getTextContent, createLogger, formatError as fmtErr, url as urlColor } from "@poncho-ai/sdk";

const harnessLog = createLogger("harness");
const telemetryLog = createLogger("telemetry");
const costLog = createLogger("cost");
const mcpLog = createLogger("mcp");
const modelLog = createLogger("model");
import type { UploadStore } from "./upload-store.js";
import { PONCHO_UPLOAD_SCHEME, VFS_SCHEME, decodeFileInputData, deriveUploadKey } from "./upload-store.js";
import type { StorageEngine } from "./storage/engine.js";
import { createStorageEngine, type StorageProvider } from "./storage/index.js";
import {
  createConversationStoreFromEngine,
  createMemoryStoreFromEngine,
  createTodoStoreFromEngine,
  createReminderStoreFromEngine,
} from "./storage/store-adapters.js";
import { BashEnvironmentManager } from "./vfs/bash-manager.js";
import type { VirtualMount } from "./vfs/poncho-fs-adapter.js";
export type { VirtualMount } from "./vfs/poncho-fs-adapter.js";
import { createBashTool } from "./vfs/bash-tool.js";
import { createReadFileTool } from "./vfs/read-file-tool.js";
import { createEditFileTool } from "./vfs/edit-file-tool.js";
import { createWriteFileTool } from "./vfs/write-file-tool.js";
import { PonchoFsAdapter } from "./vfs/poncho-fs-adapter.js";
import { parseAgentFile, parseAgentMarkdown, renderAgentPrompt, type ParsedAgent, type AgentFrontmatter } from "./agent-parser.js";
import { loadPonchoConfig, normalizeToolAccess, resolveMemoryConfig, resolveStateConfig, type PonchoConfig, type ToolAccess, type BuiltInToolToggles } from "./config.js";
import { ponchoDocsTool } from "./default-tools.js";
import {
  createMemoryStore,
  createMemoryTools,
  type MemoryConfig,
  type MemoryStore,
} from "./memory.js";
import { createTodoStore, createTodoTools, type TodoItem, type TodoStore } from "./todo-tools.js";
import { createReminderStore, type ReminderStore } from "./reminder-store.js";
import { createSecretsStore, resolveEnv, type SecretsStore } from "./secrets-store.js";
import { createReminderTools } from "./reminder-tools.js";
import { LocalMcpBridge } from "./mcp.js";
import { createModelProvider, getModelContextWindow, type ModelProviderFactory, type ProviderConfig } from "./model-factory.js";
import {
  buildSkillContextWindow,
  loadSkillMetadata,
  loadVfsSkillMetadata,
  mergeSkills,
} from "./skill-context.js";
import { generateText, streamText, type ModelMessage } from "ai";
import { addPromptCacheBreakpoints } from "./prompt-cache.js";
import { jsonSchemaToZod } from "./schema-converter.js";
import type { SkillMetadata } from "./skill-context.js";
import { createSkillTools, normalizeScriptPolicyPath } from "./skill-tools.js";
import { createSearchTools } from "./search-tools.js";
import { createSubagentTools } from "./subagent-tools.js";
import type { SubagentManager } from "./subagent-manager.js";
import { trace, context as otelContext, SpanStatusCode, SpanKind, diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { normalizeOtlp } from "./telemetry.js";

/** Extract useful details from OTLPExporterError (has .code + .data) or plain Error. */
function formatOtlpError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  const code = (err as { code?: number }).code;
  if (code != null) parts.push(`HTTP ${code}`);
  if (err.message) parts.push(err.message);
  const data = (err as { data?: string }).data;
  if (data) parts.push(data);
  return parts.join(" — ") || "unknown error";
}
import {
  isSiblingScriptsPattern,
  matchesRelativeScriptPattern,
  matchesSlashPattern,
  normalizeRelativeScriptPattern,
} from "./tool-policy.js";
import { ToolDispatcher, type ToolCall, type ToolExecutionResult } from "./tool-dispatcher.js";
import { ensureAgentIdentity } from "./agent-identity.js";
import {
  compactMessages,
  estimateTotalTokens,
  resolveCompactionConfig,
  type CompactMessagesOptions,
  type CompactResult,
} from "./compaction.js";

export interface HarnessOptions {
  workingDir?: string;
  environment?: "development" | "staging" | "production";
  toolDefinitions?: ToolDefinition[];
  modelProvider?: ModelProviderFactory;
  uploadStore?: UploadStore;
  /**
   * Inject the agent definition directly instead of reading AGENT.md from
   * `workingDir`. Pass raw markdown (string) or a pre-parsed `ParsedAgent`.
   * When provided, `storageEngine` is also required — the engine's
   * `agentId` becomes the source of truth for partitioning, and the
   * filesystem identity dance (`ensureAgentIdentity`) is skipped.
   */
  agentDefinition?: string | ParsedAgent;
  /**
   * Pre-constructed storage engine. When provided, the harness will not
   * create one internally. The engine's `agentId` is used wherever the
   * harness today reads `parsedAgent.frontmatter.id`.
   */
  storageEngine?: StorageEngine;
  /**
   * Inject a `PonchoConfig` object directly instead of importing
   * `poncho.config.js` from `workingDir`. When provided, the disk-based
   * loader is skipped. Downstream resolvers (`resolveMemoryConfig`,
   * `resolveStateConfig`, etc.) run as today regardless of source.
   */
  config?: PonchoConfig;
  /**
   * Read-only virtual mounts overlaid on the VFS. Each mount maps a VFS
   * prefix (e.g. "/system/") to a local filesystem directory; reads under
   * the prefix are served from local disk, writes are rejected. Used by
   * platforms like PonchOS to expose deployment-shipped defaults (system
   * jobs, system skills) without storing them in each tenant's VFS.
   * Empty by default — no system mounts in the CLI / dev workflow.
   */
  virtualMounts?: VirtualMount[];
}

export interface HarnessRunOutput {
  runId: string;
  result: RunResult;
  events: AgentEvent[];
  messages: Message[];
}

const now = (): number => Date.now();
const FIRST_CHUNK_TIMEOUT_MS = 90_000; // 90s to receive the first chunk from the model
const MAX_TRANSIENT_STEP_RETRIES = 1;
const COMPACTION_CHECK_INTERVAL_STEPS = 3;
const TOOL_RESULT_ARCHIVE_PARAM = "__toolResultArchive";
const TOOL_RESULT_TRUNCATED_PREFIX = "[TRUNCATED_TOOL_RESULT]";
const TOOL_RESULT_PREVIEW_CHARS = 700;

interface ArchivedToolResult {
  toolResultId: string;
  conversationId: string;
  toolName: string;
  toolCallId: string;
  createdAt: number;
  sizeBytes: number;
  payload: string;
}

class FirstChunkTimeoutError extends Error {
  constructor(modelName: string, timeoutMs: number) {
    super(
      `Model "${modelName}" did not respond within ${Math.floor(timeoutMs / 1000)}s. ` +
      `This is likely a transient API delay. The step will be retried automatically.`,
    );
    this.name = "FirstChunkTimeoutError";
  }
}
const SKILL_TOOL_NAMES = [
  "activate_skill",
  "deactivate_skill",
  "list_active_skills",
  "read_skill_resource",
  "list_skill_scripts",
  "run_skill_script",
] as const;

// Tools whose results are "view-once" — the model consumes the payload in the
// step where it's returned and never needs it retrieved later. Archiving them
// caused unbounded heap growth on browser-heavy sessions (each screenshot
// is ~50-500KB base64 and accumulated for the lifetime of the conversation).
const NON_ARCHIVABLE_TOOL_NAMES = new Set<string>([
  "browser_screenshot",
  "browser_snapshot",
]);

// Per-conversation byte cap on the tool-result archive. Browser/web tools
// frequently return ~50-500KB payloads (page text/HTML/extracts); without a
// cap, long sessions accumulate hundreds of MB just in archived results,
// each retained as a string in heap. Once over the cap, evict oldest by
// `createdAt`. Configurable via PONCHO_TOOL_ARCHIVE_MAX_MB (default 25 MB).
const TOOL_ARCHIVE_MAX_BYTES = (() => {
  const env = process.env.PONCHO_TOOL_ARCHIVE_MAX_MB;
  const parsed = env ? Number.parseInt(env, 10) : NaN;
  const mb = Number.isFinite(parsed) && parsed > 0 ? parsed : 25;
  return mb * 1024 * 1024;
})();
const enforceArchiveCap = (
  archive: Record<string, ArchivedToolResult>,
): number => {
  let total = 0;
  for (const id in archive) total += archive[id]?.sizeBytes ?? 0;
  if (total <= TOOL_ARCHIVE_MAX_BYTES) return 0;
  // Sort entries by createdAt ascending and drop oldest until we're under cap.
  const entries = Object.values(archive).sort((a, b) => a.createdAt - b.createdAt);
  let evicted = 0;
  for (const entry of entries) {
    if (total <= TOOL_ARCHIVE_MAX_BYTES) break;
    delete archive[entry.toolResultId];
    total -= entry.sizeBytes;
    evicted += 1;
  }
  return evicted;
};

// Factories that produce browser event listeners whose only captured variable
// is the target queue. Keep these at module scope: defining them inside run()
// would cause V8 to capture the entire run scope (including the runInput's
// __toolResultArchive) into the closure's Context object, leaking it via
// BrowserSession.tabs[cid].statusListeners across runs.
const makeBrowserFrameListener =
  (queue: AgentEvent[]) =>
  (frame: { data: string; width: number; height: number }): void => {
    queue.push({ type: "browser:frame", data: frame.data, width: frame.width, height: frame.height });
  };
const makeBrowserStatusListener =
  (queue: AgentEvent[]) =>
  (status: { active: boolean; url?: string; interactionAllowed: boolean }): void => {
    queue.push({ type: "browser:status", ...status });
  };

const isAbortError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeName = "name" in error ? String(error.name ?? "") : "";
  if (maybeName === "AbortError") {
    return true;
  }
  const maybeMessage = "message" in error ? String(error.message ?? "") : "";
  return maybeMessage.toLowerCase().includes("abort");
};

const isNoOutputGeneratedError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeName = "name" in error ? String(error.name ?? "") : "";
  if (maybeName === "AI_NoOutputGeneratedError") {
    return true;
  }
  const maybeMessage = "message" in error ? String(error.message ?? "") : "";
  return maybeMessage.toLowerCase().includes("no output generated");
};

const getErrorStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const fromTopLevel = "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;
  if (typeof fromTopLevel === "number") {
    return fromTopLevel;
  }
  if ("cause" in error && error.cause && typeof error.cause === "object") {
    const fromCause = "statusCode" in error.cause
      ? (error.cause as { statusCode?: unknown }).statusCode
      : undefined;
    if (typeof fromCause === "number") {
      return fromCause;
    }
  }
  return undefined;
};

const isRetryableModelError = (error: unknown): boolean => {
  if (error instanceof FirstChunkTimeoutError) {
    return true;
  }
  const statusCode = getErrorStatusCode(error);
  if (typeof statusCode === "number") {
    return statusCode === 429 || statusCode >= 500;
  }
  return false;
};

const toRunError = (error: unknown): { code: string; message: string; details?: Record<string, unknown> } => {
  const statusCode = getErrorStatusCode(error);
  if (error instanceof FirstChunkTimeoutError) {
    return {
      code: "MODEL_TIMEOUT",
      message: error.message,
    };
  }
  if (isNoOutputGeneratedError(error)) {
    return {
      code: "MODEL_NO_OUTPUT",
      message:
        "The provider returned no output for this step. This is often transient (for example, a provider 5xx). Try the run again.",
    };
  }
  if (typeof statusCode === "number") {
    return {
      code: statusCode >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_API_ERROR",
      message:
        statusCode >= 500
          ? `The model provider returned a temporary server error (${statusCode}). Try again in a moment.`
          : error instanceof Error
            ? error.message
            : String(error),
      details: { statusCode },
    };
  }
  return {
    code: "STEP_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
};

const MODEL_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

const toProviderSafeToolName = (
  originalName: string,
  index: number,
  used: Set<string>,
): string => {
  if (MODEL_TOOL_NAME_PATTERN.test(originalName) && !used.has(originalName)) {
    used.add(originalName);
    return originalName;
  }
  let base = originalName
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base.length === 0) {
    base = `tool_${index + 1}`;
  }
  if (base.length > 120) {
    base = base.slice(0, 120);
  }
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate) || !MODEL_TOOL_NAME_PATTERN.test(candidate)) {
    const suffixText = `_${suffix}`;
    const maxBaseLength = Math.max(1, 128 - suffixText.length);
    candidate = `${base.slice(0, maxBaseLength)}${suffixText}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
};

const isToolResultRow = (value: unknown): value is {
  tool_use_id: string;
  tool_name: string;
  content: string;
} => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.tool_use_id === "string" &&
    typeof row.tool_name === "string" &&
    typeof row.content === "string"
  );
};

const readArchiveFromParameters = (
  parameters: Record<string, unknown> | undefined,
): Record<string, ArchivedToolResult> => {
  const raw = parameters?.[TOOL_RESULT_ARCHIVE_PARAM];
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, ArchivedToolResult> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    if (
      typeof row.toolResultId !== "string" ||
      typeof row.conversationId !== "string" ||
      typeof row.toolName !== "string" ||
      typeof row.toolCallId !== "string" ||
      typeof row.createdAt !== "number" ||
      typeof row.sizeBytes !== "number" ||
      typeof row.payload !== "string"
    ) {
      continue;
    }
    out[key] = {
      toolResultId: row.toolResultId,
      conversationId: row.conversationId,
      toolName: row.toolName,
      toolCallId: row.toolCallId,
      createdAt: row.createdAt,
      sizeBytes: row.sizeBytes,
      payload: row.payload,
    };
  }
  return out;
};

const makeTruncatedToolResultNotice = (
  toolResultId: string,
  toolName: string,
  payload: string,
): string => {
  const preview = payload.slice(0, TOOL_RESULT_PREVIEW_CHARS);
  const omittedChars = Math.max(0, payload.length - preview.length);
  return `${TOOL_RESULT_TRUNCATED_PREFIX} id="${toolResultId}" tool="${toolName}" omittedChars=${omittedChars}\n${preview}${omittedChars > 0 ? "\n...[truncated]" : ""}`;
};

/**
 * Drop trailing messages that would be rejected by the model API:
 * - tool messages with no preceding assistant tool_use
 * - assistant messages whose serialized content carries `tool_calls` but
 *   has no following tool message
 *
 * Used at cancellation time to produce a snapshot that's safe to use as the
 * canonical history on the next turn.
 */
const trimToValidPrefix = (messages: Message[]): Message[] => {
  const out = [...messages];
  while (out.length > 0) {
    const tail = out[out.length - 1]!;
    if (tail.role === "tool") {
      // A tool message at the tail without a preceding assistant tool_use
      // is invalid; an assistant tool_use without a following tool message
      // is also invalid. The pair is pushed together in the run loop, so a
      // bare trailing "tool" only happens if the assistant message was lost
      // somehow — drop it defensively.
      const prev = out[out.length - 2];
      if (!prev || prev.role !== "assistant") {
        out.pop();
        continue;
      }
      break;
    }
    if (tail.role === "assistant") {
      // Assistant message with serialized tool_calls but no matching tool
      // message after it — drop it.
      if (typeof tail.content === "string" && tail.content.includes('"tool_calls"')) {
        try {
          const parsed = JSON.parse(tail.content) as { tool_calls?: unknown };
          if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
            out.pop();
            continue;
          }
        } catch {
          // Not JSON — plain text assistant message is fine.
        }
      }
      break;
    }
    break;
  }
  return out;
};

const hasUntruncatedToolResults = (messages: Message[]): boolean => {
  for (const msg of messages) {
    if (msg.role !== "tool" || typeof msg.content !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const row of parsed) {
      if (!isToolResultRow(row)) continue;
      if (!row.content.startsWith(TOOL_RESULT_TRUNCATED_PREFIX)) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Finds the last ModelMessage index that's safe to place a prompt cache
 * breakpoint at — i.e. the last index before any untruncated tool-result.
 *
 * Untruncated tool-results from a prior run will be truncated on the next
 * run, which would invalidate any cache write covering them. Placing the
 * breakpoint just before them lets us cache only the stable prefix (system
 * prompt + earlier turns) while still reading it back next turn.
 *
 * Returns `messages.length - 1` when there are no untruncated tool-results
 * (normal tail-of-history caching).
 */
const findLastStableCacheIndex = (messages: ModelMessage[]): number => {
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role !== "tool") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as { type?: string; output?: { type?: string; value?: unknown } };
      if (p.type !== "tool-result" || !p.output) continue;
      // JSON outputs bypass truncation (only text content is truncated).
      if (p.output.type === "json") return i - 1;
      if (p.output.type === "text" && typeof p.output.value === "string") {
        if (!p.output.value.startsWith(TOOL_RESULT_TRUNCATED_PREFIX)) {
          return i - 1;
        }
      }
    }
  }
  return messages.length - 1;
};

const DEVELOPMENT_MODE_CONTEXT = `## Development Mode Context

You are running locally in development mode. Treat this as an editable agent workspace.

## Understanding Your Environment

- Built-in tools: \`list_directory\` and \`read_file\`
- \`write_file\` and \`edit_file\` are available in development (disabled by default in production)
- A starter local skill is included (\`starter-echo\`)
- Bash/shell commands are **not** available unless you install and enable a shell tool/skill
- Git operations are only available if a git-capable tool/skill is configured
- For setup/configuration/skills/MCP questions, proactively read \`README.md\` with \`read_file\` before answering
- Prefer concrete commands and examples from \`README.md\` over assumptions

### Tool Access Control

Any tool can be configured in \`poncho.config.js\` under \`tools\`:

\`\`\`javascript
tools: {
  send_email: 'approval',  // requires human approval before each call
  write_file: false,        // disabled (agent never sees it)
  read_file: true,          // available (default)
  byEnvironment: {
    development: { send_email: true },  // skip approval in dev
  },
}
\`\`\`

Three access levels: \`true\` (available), \`'approval'\` (requires approval), \`false\` (disabled). Works for any tool name. Per-environment overrides take priority.

## Self-Extension Capabilities

You can extend your own capabilities by creating custom JavaScript/TypeScript scripts:

- Create scripts under \`skills/<skill-name>/\` (recursive) to add new functionality
- Scripts can perform any Node.js operations: API calls, file processing, data transformations, web scraping, etc.
- Use the \`run_skill_script\` tool to execute these scripts and integrate results into your workflow
- This allows you to dynamically add custom tools and capabilities as users need them, without requiring external dependencies or MCP servers
- Scripts run in the same Node.js process, so \`process.env\` is available directly. The \`.env\` file is loaded before the harness starts, meaning any variable defined there (e.g. API keys, tokens) can be read with \`process.env.MY_VAR\` inside scripts.

## Skill Authoring Guardrails

- Every \`SKILL.md\` must include YAML frontmatter between \`---\` markers.
- Required frontmatter fields for discovery: \`name\` (non-empty string). Add \`description\` whenever possible.
- \`allowed-tools\` and \`approval-required\` belong in SKILL frontmatter (not in script files).
- MCP entries in frontmatter must use \`mcp:server/tool\` or \`mcp:server/*\`.
- Script entries in frontmatter must be relative paths (for example \`./scripts/fetch.ts\`, \`./tools/audit.ts\`, \`./fetch-page.ts\`).
- \`approval-required\` should be a stricter subset of allowed access:
  - MCP entries must also appear in \`allowed-tools\`.
  - Script entries outside \`./scripts/\` must also appear in \`allowed-tools\`.
- Keep MCP server connection details (\`url\`, auth env vars) in \`poncho.config.js\` only.

## Cron Jobs

Users can define scheduled tasks in \`AGENT.md\` frontmatter:

\`\`\`yaml
cron:
  daily-report:
    schedule: "0 9 * * *"        # Standard 5-field cron expression
    timezone: "America/New_York" # Optional IANA timezone (default: UTC)
    task: "Generate the daily sales report"
  telegram-checkin:
    schedule: "0 18 * * 1-5"
    channel: telegram              # Proactive message to all known Telegram chats
    task: "Send an end-of-day summary to the user"
\`\`\`

- Each cron job triggers an autonomous agent run with the specified task, creating a fresh conversation.
- In \`poncho dev\`, jobs run via an in-process scheduler and appear in the web UI sidebar (prefixed with \`[cron]\`).
- For Vercel: \`poncho build vercel\` generates \`vercel.json\` cron entries. Set \`CRON_SECRET\` = \`PONCHO_AUTH_TOKEN\`.
- Jobs can also be triggered manually: \`GET /api/cron/<jobName>\`.
- To carry context across cron runs, enable memory.
- **IMPORTANT**: When adding a new cron job, always PRESERVE all existing cron jobs. Never remove or overwrite existing jobs unless the user explicitly asks you to replace or delete them. Read the full current \`cron:\` block before editing, and append the new job alongside the existing ones.
- **Proactive channel messaging**: Adding \`channel: telegram\` (or \`slack\`) makes the cron job send its response directly to all known conversations on that platform, instead of creating a standalone conversation. The agent continues the existing conversation history for context. A chat must have at least one prior user message for auto-discovery to find it.

## Messaging Integrations (Slack, Telegram, Email)

Users can connect this agent to messaging platforms so it responds to messages and @mentions.

### Slack Setup

1. Create a Slack App at https://api.slack.com/apps ("From scratch")
2. Under **OAuth & Permissions**, add Bot Token Scopes: \`app_mentions:read\`, \`chat:write\`, \`reactions:write\`
3. Under **Event Subscriptions**, enable events, set the Request URL to \`https://<deployed-url>/api/messaging/slack\`, and subscribe to \`app_mention\`
4. Install the app to the workspace (generates Bot Token \`xoxb-...\`)
5. Copy the **Signing Secret** from the Basic Information page
6. Add env vars:
   \`\`\`
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_SIGNING_SECRET=...
   \`\`\`
7. Add to \`poncho.config.js\`:
   \`\`\`javascript
   messaging: [{ platform: 'slack' }]
   \`\`\`
8. Deploy (or use a tunnel like ngrok for local dev)
9. **Vercel only:** install \`@vercel/functions\` so the serverless function stays alive while processing messages (\`npm install @vercel/functions\`)

The agent will respond in Slack threads when @mentioned. Each Slack thread maps to a separate Poncho conversation.

### Telegram Setup

1. Open Telegram and start a chat with @BotFather (https://t.me/BotFather)
2. Send \`/newbot\` and follow the prompts to create your bot
3. Copy the **Bot Token** (looks like \`123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11\`)
4. Add env vars:
   \`\`\`
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
   TELEGRAM_WEBHOOK_SECRET=my-secret-token
   \`\`\`
   The webhook secret is optional but recommended. It can be any string up to 256 characters.
5. Add to \`poncho.config.js\`:
   \`\`\`javascript
   messaging: [{ platform: 'telegram' }]
   \`\`\`
6. Register the webhook after deploying:
   \`\`\`bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \\
     -H "Content-Type: application/json" \\
     -d '{"url": "https://<deployed-url>/api/messaging/telegram", "secret_token": "<WEBHOOK_SECRET>"}'
   \`\`\`
   Omit \`secret_token\` if not using a webhook secret. For local dev, use a tunnel like ngrok and register the tunnel URL.
7. **Vercel only:** install \`@vercel/functions\` so the serverless function stays alive while processing (\`npm install @vercel/functions\`)

**How it works:**
- **Private chats**: the bot responds to all messages.
- **Groups**: the bot only responds when @mentioned. The mention is stripped before the message reaches the agent.
- **Forum topics**: each topic in a supergroup is a separate conversation.
- Photos and documents sent to the bot are forwarded as file attachments.
- Use \`/new\` to reset the conversation. In groups, use \`/new@botusername\`.

**Restricting access:**

By default any Telegram user can message the bot. To restrict to specific users:

\`\`\`javascript
messaging: [{
  platform: 'telegram',
  allowedUserIds: [1056240469],
}]
\`\`\`

Messages from anyone not on the list are silently ignored. Users can find their ID by messaging @userinfobot on Telegram.

### Email Setup (Resend)

1. Create an account at https://resend.com and add your domain
2. Enable **Inbound** on your domain, create a webhook for \`email.received\` pointing to \`https://<deployed-url>/api/messaging/resend\`
3. Install the Resend SDK: \`npm install resend\`
4. Add env vars:
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

**Response modes:**

- \`mode: 'auto-reply'\` (default): the agent's text response is sent back as an email reply automatically.
- \`mode: 'tool'\`: auto-reply is disabled; the agent gets a \`send_email\` tool with full control over recipients, subject, body, CC/BCC, and threading.

**Tool mode config options:**

\`\`\`javascript
messaging: [{
  platform: 'resend',
  mode: 'tool',
  allowedSenders: ['*@mycompany.com'],     // optional: restrict who can email the agent
  allowedRecipients: ['*@mycompany.com'],  // optional: restrict who the agent can email
  maxSendsPerRun: 5,                       // optional: max emails per run (default: 10)
}]
\`\`\`

In tool mode, the \`send_email\` tool accepts: \`to\` (required), \`subject\` (required), \`body\` (required, markdown converted to HTML), \`cc\`, \`bcc\`, and \`in_reply_to\` (optional, message ID for threading as a reply).

The incoming email's sender and subject are included in the task as \`From:\` / \`Subject:\` headers.

## Editing AGENT.md Safely

When modifying \`AGENT.md\`, follow these rules strictly:

- **Preserve all existing frontmatter fields.** Always read the full file first, then write it back with your changes applied. Never drop \`name\`, \`description\`, \`model\`, \`cron\`, or any other field that was already present unless the user explicitly asks you to remove it.
- **Do not change the \`model\` unless explicitly asked.** If the user asks you to add a cron job, update the system prompt, add tools, etc., keep the existing \`model\` block exactly as-is. Pay special attention to model names — do not "correct", shorten, or substitute them (e.g. do not change \`claude-opus-4-6\` to \`claude-opus-4\` or any other variant).
- **Prefer skill-scoped \`allowed-tools\` over agent-level.** If a tool is already declared in a \`SKILL.md\` frontmatter \`allowed-tools\` list, do not duplicate it into \`AGENT.md\`. Only add \`allowed-tools\` to \`AGENT.md\` when the user wants a tool available globally (outside any specific skill).
- **Add env vars to \`.env\`, not \`.env.example\`.** When the user needs new environment variables, add them directly to the existing \`.env\` file (with placeholder values if needed). Do not create or modify \`.env.example\` — the user manages their secrets in \`.env\`.
- **Do not create files the user didn't ask for.** Only create or modify files that are directly required by the user's request. Do not speculatively create documentation files, READMEs, guides, or any other artifacts unless explicitly asked.

## Telemetry Configuration (\`poncho.config.js\`)

Send OpenTelemetry traces to any OTLP-compatible collector (Jaeger, Grafana Tempo, Honeycomb, Datadog, etc.):

\`\`\`javascript
telemetry: {
  enabled: true,
  otlp: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  // Or with auth headers:
  // otlp: { url: "https://api.honeycomb.io/v1/traces", headers: { "x-honeycomb-team": process.env.HONEYCOMB_API_KEY } },
},
\`\`\`

## Credential Configuration Pattern

All credentials in \`poncho.config.js\` use the **env var name** pattern (\`*Env\` fields). Config specifies which environment variable to read — never the secret itself. Sensible defaults mean zero config when using conventional env var names.

\`\`\`javascript
// poncho.config.js — credentials use *Env fields with defaults
export default {
  // Model provider API keys (optional, defaults shown)
  providers: {
    anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
    openai: { apiKeyEnv: "OPENAI_API_KEY" },
    // openai-codex provider reads OAuth tokens from env vars by default:
    // openaiCodex: { refreshTokenEnv: "OPENAI_CODEX_REFRESH_TOKEN", accountIdEnv: "OPENAI_CODEX_ACCOUNT_ID" },
  },
  auth: {
    required: true,
    tokenEnv: "PONCHO_AUTH_TOKEN",  // default
  },
  storage: {
    provider: "upstash",
    urlEnv: "UPSTASH_REDIS_REST_URL",       // default (falls back to KV_REST_API_URL)
    tokenEnv: "UPSTASH_REDIS_REST_TOKEN",   // default (falls back to KV_REST_API_TOKEN)
  },
  telemetry: {
    otlp: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  },
  messaging: [{ platform: "slack" }],      // reads SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET by default
}
\`\`\`

Since all fields have defaults, you only need to specify \`*Env\` when your env var name differs from the convention.

## When users ask about customization:

- Explain and edit \`poncho.config.js\` for model/provider, storage+memory, auth, telemetry, and MCP settings.
- Help create or update local skills under \`skills/<skill-name>/SKILL.md\`.
- For executable scripts, use a sibling \`scripts/\` directory next to \`AGENT.md\` or \`SKILL.md\`; run via \`run_skill_script\`.
- To use a custom script folder (for example \`tools/\`), declare it in \`allowed-tools\` and gate sensitive paths with \`approval-required\` in frontmatter.
- For MCP setup, default to direct \`poncho.config.js\` edits (\`mcp\` entries with URL and bearer token env).
- Keep MCP server connection details in \`poncho.config.js\` only (name/url/auth). Do not move server definitions into \`SKILL.md\`.
- In \`AGENT.md\`/\`SKILL.md\` frontmatter, declare MCP tools in \`allowed-tools\` array as \`mcp:server/pattern\` (for example \`mcp:linear/*\` or \`mcp:linear/list_issues\`), and use \`approval-required\` for human-gated calls.
- Never use nested MCP objects in skill frontmatter (for example \`mcp: [{ name, url, auth }]\`).
- To scope tools to a skill: keep server config in \`poncho.config.js\`, add desired \`allowed-tools\`/ \`approval-required\` patterns in that skill's \`SKILL.md\`, and remove global \`AGENT.md\` patterns if you do not want global availability.
- Do not invent unsupported top-level config keys (for example \`model\` in \`poncho.config.js\`). Keep existing config structure unless README/spec explicitly says otherwise.
- Keep \`poncho.config.js\` valid JavaScript and preserve existing imports/types/comments. If there is a JSDoc type import, do not rewrite it to a different package name.
- Credentials always use \`*Env\` fields (env var names), never raw \`process.env.*\` values. For example, use \`apiKeyEnv: "MY_KEY"\` not \`apiKey: process.env.MY_KEY\`.
- Preferred MCP config shape in \`poncho.config.js\`:
  \`mcp: [{ name: "linear", url: "https://mcp.linear.app/mcp", auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" } }]\`
- If shell/CLI access exists, you can use \`poncho mcp add --url ... --name ... --auth-bearer-env ...\`, then \`poncho mcp tools list <server>\` and \`poncho mcp tools select <server>\`.
- If shell/CLI access is unavailable, ask the user to run needed commands and provide exact copy-paste commands.
- For setup, skills, MCP, auth, storage, telemetry, or "how do I..." questions, proactively read \`README.md\` with \`read_file\` before answering.
- Prefer quoting concrete commands and examples from \`README.md\` over guessing.
- Prefer \`edit_file\` for targeted changes to existing files (uses exact string matching); use \`write_file\` only for creating new files or full rewrites.
- Keep edits minimal, preserve unrelated settings/code, and summarize what changed.

## Detailed Documentation

For topics not covered above, use the \`poncho_docs\` tool to load full documentation on demand:
- \`api\` — HTTP API endpoints, SSE events, TypeScript client SDK, file attachments, upload providers
- \`features\` — Web UI details, browser automation, subagents, persistent memory, custom messaging adapters
- \`configuration\` — Full config reference, env vars, auth types, storage, telemetry, tool approval
- \`troubleshooting\` — Error codes, recoverable vs fatal errors, common issues and fixes`;

/**
 * Detect FileContentPart objects ({ type:"file", data, mediaType }) in a tool
 * output value and split them into:
 *  - `mediaItems` – items suitable for the AI SDK multi-part `content` output
 *    (images become proper vision tokens, not base64 text).
 *  - `strippedOutput` – the original output with base64 `data` fields replaced
 *    by a short placeholder so the stored conversation stays small.
 */
function extractMediaFromToolOutput(output: unknown): {
  mediaItems: Array<{ type: "media"; data: string; mediaType: string }>;
  strippedOutput: unknown;
} {
  const mediaItems: Array<{ type: "media"; data: string; mediaType: string }> = [];

  function walk(node: unknown): unknown {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (
        obj.type === "file" &&
        typeof obj.data === "string" &&
        typeof obj.mediaType === "string" &&
        ((obj.mediaType as string).startsWith("image/") || obj.mediaType === "application/pdf")
      ) {
        mediaItems.push({
          type: "media",
          data: obj.data as string,
          mediaType: obj.mediaType as string,
        });
        return { type: "file", mediaType: obj.mediaType, filename: obj.filename ?? "file", _stripped: true };
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
      return out;
    }
    return node;
  }

  const strippedOutput = walk(output);
  return { mediaItems, strippedOutput };
}

export class AgentHarness {
  private readonly workingDir: string;
  private readonly environment: HarnessOptions["environment"];
  private modelProvider: ModelProviderFactory;
  private readonly modelProviderInjected: boolean;
  private readonly dispatcher = new ToolDispatcher();
  readonly uploadStore?: UploadStore;
  private memoryStore?: MemoryStore;
  private readonly tenantMemoryStores = new Map<string, MemoryStore>();
  private memoryConfig?: MemoryConfig;
  private todoStore?: TodoStore;
  reminderStore?: ReminderStore;
  secretsStore?: SecretsStore;
  private loadedConfig?: PonchoConfig;
  private readonly injectedConfig?: PonchoConfig;
  private loadedSkills: SkillMetadata[] = [];
  private skillFingerprint = "";
  private lastSkillRefreshAt = 0;
  private readonly activeSkillNames = new Set<string>();
  private readonly skillCache = new Map<string, { skills: SkillMetadata[]; fingerprint: string }>();
  private readonly vfsSkillCollisionWarnings = new Set<string>();
  private readonly registeredMcpToolNames = new Set<string>();
  private otlpSpanProcessor?: BatchSpanProcessor;
  private otlpTracerProvider?: NodeTracerProvider;
  private hasOtlpExporter = false;
  private _browserSession?: unknown;
  private _browserMod?: {
    createBrowserTools: (getSession: () => unknown, getConversationId?: () => string) => ToolDefinition[];
    BrowserSession: new (sessionId: string, config: Record<string, unknown>) => unknown;
  };

  private parsedAgent?: ParsedAgent;
  private agentFileFingerprint = "";
  private injectedAgentDefinition?: string | ParsedAgent;
  private injectedStorageEngine = false;
  private mcpBridge?: LocalMcpBridge;
  private subagentManager?: SubagentManager;
  private readonly archivedToolResultsByConversation = new Map<string, Record<string, ArchivedToolResult>>();

  /** Unified storage engine (replaces individual KV-backed stores). */
  storageEngine?: StorageEngine;
  /** Bash environment manager (creates per-tenant bash instances). */
  private bashManager?: BashEnvironmentManager;
  /** Read-only virtual mounts overlaid on the VFS. Empty by default. */
  private virtualMounts: VirtualMount[] = [];

  private resolveToolAccess(toolName: string): ToolAccess {
    const tools = this.loadedConfig?.tools;
    if (!tools) return true;

    const env = this.environment ?? "development";
    const envOverride = tools.byEnvironment?.[env]?.[toolName];
    if (envOverride !== undefined) return envOverride;

    const flatValue = tools[toolName];
    if (
      typeof flatValue === "boolean" ||
      flatValue === "approval" ||
      (flatValue !== null && typeof flatValue === "object" && !Array.isArray(flatValue) &&
        // distinguish a ToolAccess object from the nested `defaults` /
        // `byEnvironment` sibling fields by checking it has only the
        // expected ToolAccess keys.
        Object.keys(flatValue as object).every((k) => k === "access" || k === "dispatch"))
    ) {
      return flatValue as ToolAccess;
    }

    const legacyValue = tools.defaults?.[toolName as keyof BuiltInToolToggles];
    if (legacyValue !== undefined) return legacyValue;

    return true;
  }

  /** Returns the normalized {access, dispatch} mode for the tool. */
  private resolveToolMode(toolName: string): { access?: "approval"; dispatch?: "device" } {
    return normalizeToolAccess(this.resolveToolAccess(toolName));
  }

  private isToolEnabled(name: string): boolean {
    const access = this.resolveToolAccess(name);
    if (access === false) return false;
    if (name === "write_file" || name === "edit_file" || name === "delete_file" || name === "delete_directory") {
      return this.shouldEnableWriteTool();
    }
    return true;
  }

  private registerIfMissing(tool: ToolDefinition): void {
    if (!this.dispatcher.get(tool.name)) {
      this.dispatcher.register(tool);
    }
  }

  /**
   * Register additional tools after construction (e.g. messaging adapter tools).
   * Existing tools with the same name are overwritten.
   * Tools disabled via `tools` config are skipped.
   */
  registerTools(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      if (!this.isToolEnabled(tool.name)) continue;
      this.dispatcher.register(tool);
    }
  }

  unregisterTools(names: string[]): void {
    this.dispatcher.unregisterMany(names);
  }

  setSubagentManager(manager: SubagentManager): void {
    this.subagentManager = manager;
    this.dispatcher.registerMany(
      createSubagentTools(manager),
    );
  }

  private registerConfiguredBuiltInTools(config: PonchoConfig | undefined): void {
    // Old file tools (read_file, write_file, etc.) are replaced by the bash tool.
    // Only register search tools, poncho_docs, and get_tool_result_by_id.
    for (const tool of createSearchTools()) {
      if (this.isToolEnabled(tool.name)) {
        this.registerIfMissing(tool);
      }
    }
    if (this.environment === "development" && this.isToolEnabled("poncho_docs")) {
      this.registerIfMissing(ponchoDocsTool);
    }
    if (this.isToolEnabled("get_tool_result_by_id")) {
      this.registerIfMissing(this.createGetToolResultByIdTool());
    }
  }

  private createGetToolResultByIdTool(): ToolDefinition {
    return defineTool({
      name: "get_tool_result_by_id",
      description:
        "Retrieve a previously archived full tool result by id for the current conversation. " +
        "Use this when older tool outputs were truncated in prompt history.",
      inputSchema: {
        type: "object",
        properties: {
          toolResultId: { type: "string", description: "Archived tool result id to retrieve" },
          offset: { type: "number", description: "Optional character offset for paging large payloads" },
          limit: { type: "number", description: "Optional maximum characters to return (default 6000, max 20000)" },
        },
        required: ["toolResultId"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const conversationId = context.conversationId ?? "__default__";
        const archive = this.archivedToolResultsByConversation.get(conversationId) ?? {};
        const toolResultId = typeof input.toolResultId === "string" ? input.toolResultId : "";
        const record = archive[toolResultId];
        if (!record) {
          costLog.debug(
            `archived tool result miss: id="${toolResultId}" conv=${conversationId.slice(0, 8)}`,
          );
          return {
            error: `No archived tool result found for id "${toolResultId}" in this conversation.`,
          };
        }
        const offset = Math.max(0, Number(input.offset) || 0);
        const limit = Math.min(Math.max(Number(input.limit) || 6000, 1), 20_000);
        const end = Math.min(record.payload.length, offset + limit);
        const chunk = record.payload.slice(offset, end);
        costLog.debug(
          `archived tool result hit: id="${toolResultId}" conv=${conversationId.slice(0, 8)} ` +
          `offset=${offset} returned=${chunk.length} total=${record.payload.length}`,
        );
        return {
          toolResultId: record.toolResultId,
          toolName: record.toolName,
          toolCallId: record.toolCallId,
          totalChars: record.payload.length,
          offset,
          returnedChars: chunk.length,
          hasMore: end < record.payload.length,
          payload: chunk,
        };
      },
    });
  }

  private createVfsAccess(tenantId: string): NonNullable<ToolContext["vfs"]> {
    const adapter = this.bashManager!.getAdapter(tenantId);
    const maybeInvalidate = (path: string) => {
      if (path === "/skills" || path.startsWith("/skills/")) {
        this.invalidateSkillsForTenant(tenantId);
      }
    };
    return {
      readFile: (path: string) => adapter.readFileBuffer(path),
      readText: (path: string) => adapter.readFile(path),
      writeFile: async (path: string, content: Uint8Array, _mimeType?: string) => {
        await adapter.writeFile(path, content);
        maybeInvalidate(path);
      },
      writeText: async (path: string, content: string) => {
        await adapter.writeFile(path, content);
        maybeInvalidate(path);
      },
      exists: (path: string) => adapter.exists(path),
      stat: async (path: string) => {
        const s = await adapter.stat(path);
        return {
          size: s.size,
          isDirectory: s.isDirectory,
          mimeType: undefined,
          updatedAt: s.mtime.getTime(),
        };
      },
      readdir: (path: string) => adapter.readdir(path),
      mkdir: async (path: string, options?: { recursive?: boolean }) => {
        await adapter.mkdir(path, options);
        maybeInvalidate(path);
      },
      rm: async (path: string, options?: { recursive?: boolean }) => {
        await adapter.rm(path, options);
        maybeInvalidate(path);
      },
    };
  }

  private shouldEnableWriteTool(): boolean {
    const override = process.env.PONCHO_FS_WRITE?.toLowerCase();
    if (override === "1" || override === "true" || override === "yes") {
      return true;
    }
    if (override === "0" || override === "false" || override === "no") {
      return false;
    }
    return this.environment !== "production";
  }

  constructor(options: HarnessOptions = {}) {
    this.workingDir = options.workingDir ?? process.cwd();
    this.environment = options.environment ?? "development";
    this.modelProviderInjected = !!options.modelProvider;
    this.modelProvider = options.modelProvider ?? createModelProvider("anthropic");
    this.uploadStore = options.uploadStore;
    this.injectedConfig = options.config;

    if (options.agentDefinition !== undefined && options.storageEngine === undefined) {
      throw new Error(
        "HarnessOptions.agentDefinition requires HarnessOptions.storageEngine — " +
        "construct a StorageEngine with the desired agentId and pass both.",
      );
    }
    this.injectedAgentDefinition = options.agentDefinition;
    if (options.storageEngine) {
      this.storageEngine = options.storageEngine;
      this.injectedStorageEngine = true;
    }
    this.virtualMounts = options.virtualMounts ?? [];

    if (options.toolDefinitions?.length) {
      this.dispatcher.registerMany(options.toolDefinitions);
    }
  }

  get frontmatter(): AgentFrontmatter | undefined {
    return this.parsedAgent?.frontmatter;
  }

  getToolResultArchive(conversationId: string): Record<string, ArchivedToolResult> {
    const archive = this.archivedToolResultsByConversation.get(conversationId);
    return archive ? { ...archive } : {};
  }

  private seedToolResultArchive(
    conversationId: string,
    parameters: Record<string, unknown> | undefined,
  ): Record<string, ArchivedToolResult> {
    const seeded = readArchiveFromParameters(parameters);
    const existing = this.archivedToolResultsByConversation.get(conversationId) ?? {};
    const merged = { ...existing, ...seeded };
    this.archivedToolResultsByConversation.set(conversationId, merged);
    return merged;
  }

  private truncateHistoricalToolResults(
    messages: Message[],
    conversationId: string,
  ): { changed: boolean; truncatedCount: number; archivedCount: number; omittedChars: number } {
    let latestRunId: string | undefined;
    let latestToolMessageIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]!;
      if (latestToolMessageIndex === -1 && msg.role === "tool" && typeof msg.content === "string") {
        latestToolMessageIndex = i;
      }
      const meta = msg.metadata as Record<string, unknown> | undefined;
      const runId = typeof meta?.runId === "string" ? meta.runId : undefined;
      if (runId) {
        latestRunId = runId;
        break;
      }
    }
    if (!latestRunId && latestToolMessageIndex === -1) {
      return { changed: false, truncatedCount: 0, archivedCount: 0, omittedChars: 0 };
    }
    const archive = this.archivedToolResultsByConversation.get(conversationId) ?? {};
    this.archivedToolResultsByConversation.set(conversationId, archive);
    let changed = false;
    let truncatedCount = 0;
    let archivedCount = 0;
    let omittedChars = 0;

    for (let index = 0; index < messages.length; index += 1) {
      const msg = messages[index]!;
      if (msg.role !== "tool" || typeof msg.content !== "string") continue;
      const meta = msg.metadata as Record<string, unknown> | undefined;
      const runId = typeof meta?.runId === "string" ? meta.runId : undefined;
      if (latestRunId) {
        if (runId === latestRunId) continue;
      } else if (index === latestToolMessageIndex) {
        // Legacy fallback for pre-runId conversations: keep newest tool turn intact.
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.content);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      let rowChanged = false;
      const nextRows = parsed.map((row) => {
        if (!isToolResultRow(row)) return row;
        if (row.content.startsWith(TOOL_RESULT_TRUNCATED_PREFIX)) return row;
        if (this.shouldPreserveSkillToolResult(row)) return row;
        const toolResultId = row.tool_use_id;
        if (!archive[toolResultId] && !NON_ARCHIVABLE_TOOL_NAMES.has(row.tool_name)) {
          archive[toolResultId] = {
            toolResultId,
            conversationId,
            toolName: row.tool_name,
            toolCallId: row.tool_use_id,
            createdAt: now(),
            sizeBytes: Buffer.byteLength(row.content, "utf8"),
            payload: row.content,
          };
          archivedCount += 1;
          enforceArchiveCap(archive);
        }
        const omitted = Math.max(0, row.content.length - TOOL_RESULT_PREVIEW_CHARS);
        omittedChars += omitted;
        truncatedCount += 1;
        rowChanged = true;
        return {
          ...row,
          content: makeTruncatedToolResultNotice(toolResultId, row.tool_name, row.content),
        };
      });
      if (rowChanged) {
        msg.content = JSON.stringify(nextRows);
        // Critical: historical messages may still carry full-fidelity
        // `_richToolResults`. If we keep it, convertMessage will prefer that
        // path and bypass truncated `content`, causing token growth to remain.
        if (msg.metadata && typeof msg.metadata === "object") {
          const meta = msg.metadata as Record<string, unknown>;
          if ("_richToolResults" in meta) {
            delete meta._richToolResults;
          }
        }
        changed = true;
      }
    }
    return { changed, truncatedCount, archivedCount, omittedChars };
  }

  private shouldPreserveSkillToolResult(row: {
    tool_use_id: string;
    tool_name: string;
    content: string;
  }): boolean {
    if (row.tool_name.startsWith("todo_")) {
      return true;
    }
    if (row.tool_name !== "activate_skill" && row.tool_name !== "deactivate_skill") {
      return false;
    }
    const content = row.content.trim();
    if (content.startsWith("Tool error:")) {
      return false;
    }
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const skill =
        typeof parsed.skill === "string"
          ? parsed.skill
          : undefined;
      if (skill && this.activeSkillNames.has(skill)) {
        return true;
      }
      const activeSkills = Array.isArray(parsed.activeSkills)
        ? parsed.activeSkills.filter((v): v is string => typeof v === "string")
        : [];
      for (const name of activeSkills) {
        if (this.activeSkillNames.has(name)) {
          return true;
        }
      }
    } catch {
      // Non-JSON tool content should not block truncation.
    }
    return false;
  }

  async getTodos(conversationId: string): Promise<TodoItem[]> {
    if (!this.todoStore) return [];
    return this.todoStore.get(conversationId);
  }

  /**
   * Get a memory store, optionally scoped to a tenant.
   * Returns the default (agent-wide) store when tenantId is null/undefined.
   */
  private getMemoryStore(tenantId?: string): MemoryStore | undefined {
    if (!this.memoryConfig?.enabled) return undefined;
    if (!tenantId) return this.memoryStore;

    let store = this.tenantMemoryStores.get(tenantId);
    if (!store) {
      if (this.storageEngine) {
        store = createMemoryStoreFromEngine(this.storageEngine, tenantId);
      } else {
        const agentId = this.parsedAgent?.frontmatter.id ?? this.parsedAgent?.frontmatter.name ?? "unknown";
        store = createMemoryStore(agentId, this.memoryConfig, {
          workingDir: this.workingDir,
          tenantId,
        });
      }
      this.tenantMemoryStores.set(tenantId, store);
      // Evict oldest entries if cache grows too large
      if (this.tenantMemoryStores.size > 100) {
        const oldest = this.tenantMemoryStores.keys().next().value;
        if (oldest) this.tenantMemoryStores.delete(oldest);
      }
    }
    return store;
  }

  private listActiveSkills(): string[] {
    return [...this.activeSkillNames].sort();
  }

  /**
   * Resolve the skill set visible to a given tenant: repo skills plus that
   * tenant's VFS skills, with repo winning on name collision. Cached per
   * tenant; cache invalidates on VFS writes under /skills/ via
   * invalidateSkillsForTenant.
   */
  private async getSkillsForTenant(tenantId: string | undefined | null): Promise<SkillMetadata[]> {
    if (!this.storageEngine) {
      return this.loadedSkills;
    }
    // Mirror the rest of the harness: undefined tenantId falls back to
    // "__default__" so dev-mode (no auth) conversations see the same VFS
    // namespace the Files sidebar writes to.
    const effectiveTenant = tenantId || "__default__";
    // Refresh the engine's path cache before fingerprinting. The cache is
    // the only thing `computeVfsSkillFingerprint` reads, and historically
    // it was only populated by `bash-manager.refreshPathCache` — chat-only
    // flows (no bash) left it empty, the patched writeFile's incremental
    // update became a no-op (it skips when the cache isn't loaded), the
    // fingerprint stuck at "" across runs, and any skill the agent (or a
    // client like PonchOS's iOS Files browser) authored after the harness
    // was first instantiated was invisible from the next turn onward.
    // One SELECT per turn is the cost of correctness here.
    const engineWithRefresh = this.storageEngine as unknown as {
      refreshPathCache?: (tenantId: string) => Promise<void>;
    };
    if (typeof engineWithRefresh.refreshPathCache === "function") {
      await engineWithRefresh.refreshPathCache(effectiveTenant);
    }
    const fingerprint = this.computeVfsSkillFingerprint(effectiveTenant);
    const cached = this.skillCache.get(effectiveTenant);
    if (cached && cached.fingerprint === fingerprint) {
      return cached.skills;
    }
    const vfsSkills = await loadVfsSkillMetadata(this.storageEngine, effectiveTenant);
    const merged = mergeSkills(this.loadedSkills, vfsSkills, (skipped) => {
      const key = `${effectiveTenant}:${skipped.name}`;
      if (this.vfsSkillCollisionWarnings.has(key)) return;
      this.vfsSkillCollisionWarnings.add(key);
      createLogger("skills").warn(
        `VFS skill "${skipped.name}" for tenant ${effectiveTenant} ignored: a repo skill with the same name takes precedence.`,
      );
    });
    this.skillCache.set(effectiveTenant, { skills: merged, fingerprint });
    return merged;
  }

  invalidateSkillsForTenant(tenantId: string): void {
    this.skillCache.delete(tenantId);
  }

  private computeVfsSkillFingerprint(tenantId: string): string {
    if (!this.storageEngine) return "";
    const paths = this.storageEngine.vfs
      .listAllPaths(tenantId)
      .filter((p) => p === "/skills" || p.startsWith("/skills/"))
      .sort();
    return paths.join("\n");
  }

  private getAgentMcpIntent(): string[] {
    return this.parsedAgent?.frontmatter.allowedTools?.mcp ?? [];
  }

  private getAgentScriptIntent(): string[] {
    return this.parsedAgent?.frontmatter.allowedTools?.scripts ?? [];
  }

  private getAgentMcpApprovalPatterns(): string[] {
    return this.parsedAgent?.frontmatter.approvalRequired?.mcp ?? [];
  }

  private getAgentScriptApprovalPatterns(): string[] {
    return this.parsedAgent?.frontmatter.approvalRequired?.scripts ?? [];
  }

  /**
   * Return the set of MCP server names that have at least one tool claimed by
   * any loaded skill's `allowedTools.mcp`.  When ANY skill claims tools from a
   * server, the entire server is considered "skill-managed" — none of its tools
   * are auto-exposed globally; only explicitly declared tools become available
   * (via agent-level allowed-tools or active skill allowed-tools).
   */
  private getSkillManagedMcpServers(): Set<string> {
    const servers = new Set<string>();
    for (const skill of this.loadedSkills) {
      for (const pattern of skill.allowedTools.mcp) {
        const slash = pattern.indexOf("/");
        if (slash > 0) {
          servers.add(pattern.slice(0, slash));
        }
      }
    }
    return servers;
  }

  private getRequestedMcpPatterns(): string[] {
    const patterns = new Set<string>(this.getAgentMcpIntent());

    // Add patterns from active skills.
    for (const skillName of this.activeSkillNames) {
      const skill = this.loadedSkills.find((entry) => entry.name === skillName);
      if (!skill) {
        continue;
      }
      for (const pattern of skill.allowedTools.mcp) {
        patterns.add(pattern);
      }
    }

    // MCP servers whose tools are NOT claimed by any skill are "unmanaged" —
    // all their discovered tools are globally available so that configuring a
    // server in poncho.config.js makes its tools accessible by default.
    //
    // Once ANY skill claims tools from a server (even a single tool), that
    // server becomes "skill-managed" and ALL of its tools require explicit
    // declaration (agent-level or active-skill) to be available.
    if (this.mcpBridge) {
      const managedServers = this.getSkillManagedMcpServers();
      const discoveredTools = this.mcpBridge.listDiscoveredTools();
      for (const toolName of discoveredTools) {
        const slash = toolName.indexOf("/");
        const serverName = slash > 0 ? toolName.slice(0, slash) : toolName;
        if (!managedServers.has(serverName)) {
          patterns.add(toolName);
        }
      }
    }

    return [...patterns];
  }

  private getRequestedScriptPatterns(): string[] {
    const patterns = new Set<string>(this.getAgentScriptIntent());
    for (const skillName of this.activeSkillNames) {
      const skill = this.loadedSkills.find((entry) => entry.name === skillName);
      if (!skill) {
        continue;
      }
      for (const pattern of skill.allowedTools.scripts) {
        patterns.add(pattern);
      }
    }
    return [...patterns];
  }

  private getRequestedMcpApprovalPatterns(): string[] {
    const patterns = new Set<string>(this.getAgentMcpApprovalPatterns());
    for (const skillName of this.activeSkillNames) {
      const skill = this.loadedSkills.find((entry) => entry.name === skillName);
      if (!skill) {
        continue;
      }
      for (const pattern of skill.approvalRequired.mcp) {
        patterns.add(pattern);
      }
    }
    return [...patterns];
  }

  private getRequestedScriptApprovalPatterns(): string[] {
    const patterns = new Set<string>(this.getAgentScriptApprovalPatterns());
    for (const skillName of this.activeSkillNames) {
      const skill = this.loadedSkills.find((entry) => entry.name === skillName);
      if (!skill) {
        continue;
      }
      for (const pattern of skill.approvalRequired.scripts) {
        patterns.add(pattern);
      }
    }
    return [...patterns];
  }

  private isScriptAllowedByPolicy(skill: string, scriptPath: string): boolean {
    const normalizedScriptPath = normalizeRelativeScriptPattern(
      scriptPath,
      "run_skill_script input.script",
    );
    const isSkillRootScript =
      normalizedScriptPath.startsWith("./") &&
      !normalizedScriptPath.slice(2).includes("/");
    if (isSiblingScriptsPattern(normalizedScriptPath) || isSkillRootScript) {
      return true;
    }
    const skillPatterns =
      this.loadedSkills.find((entry) => entry.name === skill)?.allowedTools.scripts ?? [];
    const intentPatterns = new Set<string>([
      ...this.getAgentScriptIntent(),
      ...skillPatterns,
      ...this.getRequestedScriptPatterns(),
    ]);
    return [...intentPatterns].some((pattern) =>
      matchesRelativeScriptPattern(normalizedScriptPath, pattern),
    );
  }

  private isRootScriptAllowedByPolicy(scriptPath: string): boolean {
    const normalizedScriptPath = normalizeRelativeScriptPattern(
      scriptPath,
      "run_skill_script input.script",
    );
    if (isSiblingScriptsPattern(normalizedScriptPath)) {
      return true;
    }
    const patterns = this.getAgentScriptIntent();
    return patterns.some((pattern) =>
      matchesRelativeScriptPattern(normalizedScriptPath, pattern),
    );
  }

  private requiresApprovalForToolCall(
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    if (this.resolveToolMode(toolName).access === "approval") {
      return true;
    }
    if (toolName === "run_skill_script") {
      const rawScript = typeof input.script === "string" ? input.script.trim() : "";
      if (!rawScript) {
        return false;
      }
      let canonicalPath: string;
      try {
        canonicalPath = normalizeRelativeScriptPattern(
          `./${normalizeScriptPolicyPath(rawScript)}`,
          "run_skill_script input.script",
        );
      } catch {
        return true;
      }
      const scriptPatterns = this.getRequestedScriptApprovalPatterns();
      return scriptPatterns.some((pattern) =>
        matchesRelativeScriptPattern(canonicalPath, pattern),
      );
    }
    const mcpPatterns = this.getRequestedMcpApprovalPatterns();
    return mcpPatterns.some((pattern) => matchesSlashPattern(toolName, pattern));
  }

  private async refreshMcpTools(reason: string): Promise<void> {
    if (!this.mcpBridge) {
      return;
    }

    const requestedPatterns = this.getRequestedMcpPatterns();
    this.dispatcher.unregisterMany(this.registeredMcpToolNames);
    this.registeredMcpToolNames.clear();
    if (requestedPatterns.length === 0) {
      mcpLog.debug(`tools cleared (reason=${reason})`);
      return;
    }
    const tools = await this.mcpBridge.loadTools(requestedPatterns);
    this.dispatcher.registerMany(tools);
    for (const tool of tools) {
      this.registeredMcpToolNames.add(tool.name);
    }
    mcpLog.debug(
      `tools refreshed (reason=${reason}, registered=${tools.length}, patterns=${requestedPatterns.length})`,
    );
  }

  private buildSkillFingerprint(skills: SkillMetadata[]): string {
    return skills
      .map((skill) =>
        JSON.stringify({
          name: skill.name,
          description: skill.description,
          skillPath: skill.skillPath,
          allowedMcp: [...skill.allowedTools.mcp].sort(),
          allowedScripts: [...skill.allowedTools.scripts].sort(),
          approvalMcp: [...skill.approvalRequired.mcp].sort(),
          approvalScripts: [...skill.approvalRequired.scripts].sort(),
        }),
      )
      .sort()
      .join("\n");
  }

  private registerSkillTools(): void {
    this.dispatcher.unregisterMany(SKILL_TOOL_NAMES);
    this.dispatcher.registerMany(
      createSkillTools({
        getSkills: (tenantId) => this.getSkillsForTenant(tenantId),
        storageEngine: () => this.storageEngine,
        onActivateSkill: async (name: string) => {
          this.activeSkillNames.add(name);
          await this.refreshMcpTools(`activate:${name}`);
          return this.listActiveSkills();
        },
        onDeactivateSkill: async (name: string) => {
          this.activeSkillNames.delete(name);
          await this.refreshMcpTools(`deactivate:${name}`);
          return this.listActiveSkills();
        },
        onListActiveSkills: () => this.listActiveSkills(),
        isScriptAllowed: (skill: string, scriptPath: string) =>
          this.isScriptAllowedByPolicy(skill, scriptPath),
        isRootScriptAllowed: (scriptPath: string) =>
          this.isRootScriptAllowedByPolicy(scriptPath),
        workingDir: this.workingDir,
      }),
    );
  }

  private static readonly SKILL_REFRESH_DEBOUNCE_MS = 3000;

  /**
   * Re-read AGENT.md and update the parsed agent when the file has changed
   * on disk.  Returns `true` when the agent was actually re-parsed.
   *
   * Preserves the agent identity (id) across reloads so conversation
   * continuity isn't broken.
   */
  private async refreshAgentIfChanged(): Promise<boolean> {
    if (this.environment !== "development") {
      return false;
    }
    if (this.injectedAgentDefinition !== undefined) {
      // Caller owns the agent definition — re-instantiate the harness to
      // pick up changes rather than re-reading from disk.
      return false;
    }
    try {
      const agentFilePath = resolve(this.workingDir, "AGENT.md");
      const rawContent = await readFile(agentFilePath, "utf8");
      if (rawContent === this.agentFileFingerprint) {
        return false;
      }
      const parsed = parseAgentMarkdown(rawContent);
      // Preserve the resolved agent identity so existing conversations
      // keep working after an AGENT.md edit.
      if (!parsed.frontmatter.id && this.parsedAgent?.frontmatter.id) {
        parsed.frontmatter.id = this.parsedAgent.frontmatter.id;
      }
      this.parsedAgent = parsed;
      this.agentFileFingerprint = rawContent;
      return true;
    } catch (error) {
      createLogger("agent").warn(`failed to refresh AGENT.md in dev: ${fmtErr(error)}`);
      return false;
    }
  }

  /**
   * Re-scan skill directories and update metadata, tools, and context window
   * when skills have changed on disk. Returns `true` when the skill set was
   * actually updated.
   *
   * @param force - bypass the time-based debounce (used for mid-run refreshes
   *   after the agent may have written new skill files).
   */
  private async refreshSkillsIfChanged(force = false): Promise<boolean> {
    if (this.environment !== "development") {
      return false;
    }
    if (!force) {
      const elapsed = Date.now() - this.lastSkillRefreshAt;
      if (this.lastSkillRefreshAt > 0 && elapsed < AgentHarness.SKILL_REFRESH_DEBOUNCE_MS) {
        return false;
      }
    }
    this.lastSkillRefreshAt = Date.now();
    try {
      const latestSkills = await loadSkillMetadata(
        this.workingDir,
        this.loadedConfig?.skillPaths,
      );
      const nextFingerprint = this.buildSkillFingerprint(latestSkills);
      if (nextFingerprint === this.skillFingerprint) {
        return false;
      }
      this.loadedSkills = latestSkills;
      this.skillFingerprint = nextFingerprint;
      this.registerSkillTools();
      // Repo skills changed; tenant caches merge against the new repo set.
      this.skillCache.clear();
      // Prune active skills that no longer exist in the updated metadata,
      // but preserve ones that were merely updated (same name).  This keeps
      // MCP tools from active skills registered when their allowed-tools
      // list changes, instead of forcing the agent to re-activate.
      const latestSkillNames = new Set(latestSkills.map(s => s.name));
      for (const name of this.activeSkillNames) {
        if (!latestSkillNames.has(name)) {
          this.activeSkillNames.delete(name);
        }
      }
      // Re-discover MCP server catalogs so newly advertised tools are visible,
      // then refresh the registered tool set with updated skill patterns.
      if (this.mcpBridge) {
        await this.mcpBridge.discoverTools();
      }
      await this.refreshMcpTools("skills:changed");
      return true;
    } catch (error) {
      createLogger("skills").warn(`failed to refresh skills in dev: ${fmtErr(error)}`);
      return false;
    }
  }

  async initialize(): Promise<void> {
    if (this.injectedAgentDefinition !== undefined) {
      this.parsedAgent = typeof this.injectedAgentDefinition === "string"
        ? parseAgentMarkdown(this.injectedAgentDefinition)
        : this.injectedAgentDefinition;
      this.agentFileFingerprint = "";
      // The injected StorageEngine is the source of truth for agentId.
      // Mirror it onto frontmatter.id so existing downstream readers
      // (`frontmatter.id ?? frontmatter.name`) keep resolving correctly.
      if (this.storageEngine) {
        this.parsedAgent.frontmatter.id = this.storageEngine.agentId;
      }
    } else {
      const agentFilePath = resolve(this.workingDir, "AGENT.md");
      const agentRawContent = await readFile(agentFilePath, "utf8");
      this.parsedAgent = parseAgentMarkdown(agentRawContent);
      this.agentFileFingerprint = agentRawContent;
      const identity = await ensureAgentIdentity(this.workingDir);
      if (!this.parsedAgent.frontmatter.id) {
        this.parsedAgent.frontmatter.id = identity.id;
      }
    }
    const config = this.injectedConfig ?? await loadPonchoConfig(this.workingDir);
    this.loadedConfig = config;
    this.registerConfiguredBuiltInTools(config);
    const provider = this.parsedAgent.frontmatter.model?.provider ?? "anthropic";
    const memoryConfig = resolveMemoryConfig(config);
    if (!this.modelProviderInjected) {
      this.modelProvider = createModelProvider(provider, config?.providers);
    }
    const bridge = new LocalMcpBridge(config);
    this.mcpBridge = bridge;
    const extraSkillPaths = config?.skillPaths;
    const skillMetadata = await loadSkillMetadata(this.workingDir, extraSkillPaths);
    this.loadedSkills = skillMetadata;
    this.skillFingerprint = this.buildSkillFingerprint(skillMetadata);
    this.registerSkillTools();
    const agentId = this.parsedAgent.frontmatter.id ?? this.parsedAgent.frontmatter.name;

    // --- Unified Storage Engine ---
    let engine: StorageEngine;
    if (this.injectedStorageEngine && this.storageEngine) {
      // Caller-constructed engine; assume already initialized or will be
      // initialized by them (initialize() is idempotent in current impls).
      engine = this.storageEngine;
      await engine.initialize();
    } else {
      const storageProvider = (config?.storage?.provider ?? "sqlite") as StorageProvider;
      engine = createStorageEngine({
        provider: storageProvider,
        workingDir: this.workingDir,
        agentId,
        urlEnv: config?.storage?.urlEnv,
      });
      await engine.initialize();
      this.storageEngine = engine;
    }

    // --- Bash Environment Manager ---
    const maxFileSize = config?.storage?.limits?.maxFileSize ?? 100 * 1024 * 1024; // 100MB
    const maxTotalStorage = config?.storage?.limits?.maxTotalStorage ?? 1024 * 1024 * 1024; // 1GB
    const bashWorkingDir = this.environment === "production" ? null : this.workingDir;
    this.bashManager = new BashEnvironmentManager(
      engine,
      { maxFileSize, maxTotalStorage },
      bashWorkingDir,
      config?.bash,
      config?.network,
      this.virtualMounts,
    );
    // Register VFS tools
    this.registerIfMissing(createBashTool(this.bashManager));
    const getFs = (tenantId: string) => this.bashManager!.getFs(tenantId);
    this.registerIfMissing(createReadFileTool(getFs));
    this.registerIfMissing(createEditFileTool(getFs));
    this.registerIfMissing(createWriteFileTool(getFs));

    // --- Isolate (V8 sandboxed code execution) ---
    if (config?.isolate) {
      const { createRunCodeTool, buildRunCodeDescription, bundleLibraries } = await import("./isolate/index.js");
      let libraryPreamble: string | null = null;
      if (config.isolate.libraries?.length) {
        libraryPreamble = await bundleLibraries(config.isolate.libraries, this.workingDir);
      }
      const runCodeTool = createRunCodeTool({
        config: config.isolate,
        bashManager: this.bashManager,
        libraryPreamble,
        description: buildRunCodeDescription(config.isolate, !!config.network),
        network: config.network,
      });
      this.registerIfMissing(runCodeTool);
    }

    // --- Memory (engine-backed or legacy fallback) ---
    this.memoryConfig = memoryConfig ?? undefined;
    if (memoryConfig?.enabled) {
      this.memoryStore = createMemoryStoreFromEngine(engine);
      this.dispatcher.registerMany(
        createMemoryTools(
          (ctx) => this.getMemoryStore(ctx.tenantId) ?? this.memoryStore!,
          { maxRecallConversations: memoryConfig.maxRecallConversations },
        ),
      );
    }

    // --- Todos (engine-backed) ---
    this.todoStore = createTodoStoreFromEngine(engine);
    for (const tool of createTodoTools(this.todoStore)) {
      if (this.isToolEnabled(tool.name)) {
        this.registerIfMissing(tool);
      }
    }

    // --- Reminders (engine-backed) ---
    if (config?.reminders?.enabled) {
      this.reminderStore = createReminderStoreFromEngine(engine);
      for (const tool of createReminderTools(this.reminderStore)) {
        if (this.isToolEnabled(tool.name)) {
          this.registerIfMissing(tool);
        }
      }
    }

    if (config?.browser) {
      await this.initBrowserTools(config)
        .catch((e) => {
          createLogger("browser").warn(`failed to load browser tools: ${fmtErr(e)}`);
        });
    }

    // Secrets store for per-tenant env var overrides
    const stateConfig = resolveStateConfig(config);
    const authTokenEnv = config?.auth?.tokenEnv ?? "PONCHO_AUTH_TOKEN";
    const authToken = process.env[authTokenEnv];
    if (authToken) {
      this.secretsStore = createSecretsStore(agentId, authToken, stateConfig, { workingDir: this.workingDir });
      bridge.setEnvResolver(async (tenantId, envName) => {
        return resolveEnv(this.secretsStore, tenantId, envName);
      });
    }

    await bridge.startLocalServers();
    await bridge.discoverTools();
    await this.refreshMcpTools("initialize");

    const telemetryEnabled = config?.telemetry?.enabled !== false;
    const otlpConfig = telemetryEnabled ? normalizeOtlp(config?.telemetry?.otlp) : undefined;
    if (otlpConfig) {
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
      const exporter = new OTLPTraceExporter({
        url: otlpConfig.url,
        headers: otlpConfig.headers,
      });
      const processor = new BatchSpanProcessor(exporter);
      this.otlpSpanProcessor = processor;
      const provider = new NodeTracerProvider({
        spanProcessors: [processor],
      });
      provider.register();
      this.otlpTracerProvider = provider;
      this.hasOtlpExporter = true;
      telemetryLog.item(`OTLP trace exporter active → ${urlColor(otlpConfig.url)}`);
    }
  }

  private async buildBrowserStoragePersistence(
    config: PonchoConfig,
    sessionId: string,
  ): Promise<{ save(json: string): Promise<void>; load(): Promise<string | undefined> } | undefined> {
    const provider = config.storage?.provider ?? (config.state as Record<string, unknown> | undefined)?.provider as string | undefined ?? "local";
    const stateKey = `poncho:browser:state:${sessionId}`;

    if (provider === "memory") return undefined;

    if (provider === "local") {
      const { resolve: pathResolve } = await import("node:path");
      const { homedir: home } = await import("node:os");
      const stateDir = pathResolve(home(), ".poncho", "browser-state");
      const filePath = pathResolve(stateDir, `${sessionId}.json`);
      return {
        async save(json: string) {
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(stateDir, { recursive: true });
          await writeFile(filePath, json, "utf8");
        },
        async load() {
          const { readFile } = await import("node:fs/promises");
          try { return await readFile(filePath, "utf8"); } catch { return undefined; }
        },
      };
    }

    // For sqlite, postgresql, and all other providers: use local file persistence
    // (same as "local" above). The old upstash/redis branches have been removed.
    if (provider === "sqlite" || provider === "postgresql") {
      const { resolve: pathResolve } = await import("node:path");
      const { homedir: home } = await import("node:os");
      const stateDir = pathResolve(home(), ".poncho", "browser-state");
      const filePath = pathResolve(stateDir, `${sessionId}.json`);
      return {
        async save(json: string) {
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(stateDir, { recursive: true });
          await writeFile(filePath, json, "utf8");
        },
        async load() {
          const { readFile } = await import("node:fs/promises");
          try { return await readFile(filePath, "utf8"); } catch { return undefined; }
        },
      };
    }

    return undefined;
  }

  private async initBrowserTools(config: PonchoConfig): Promise<void> {
    const spec = ["@poncho-ai", "browser"].join("/");
    let browserMod: {
      createBrowserTools: (getSession: () => unknown, getConversationId?: () => string) => ToolDefinition[];
      BrowserSession: new (sessionId: string, cfg?: Record<string, unknown>) => unknown;
    };
    try {
      // Resolve from the agent project's node_modules (not the harness dist
      // location).  Walk up from workingDir the same way Node's resolution
      // algorithm does, then dynamically import the ESM entry point.
      const { existsSync } = await import("node:fs");
      const { join, dirname } = await import("node:path");
      const { pathToFileURL } = await import("node:url");

      let searchDir = this.workingDir;
      let entryPath: string | undefined;
      for (;;) {
        const candidate = join(searchDir, "node_modules", "@poncho-ai", "browser", "dist", "index.js");
        if (existsSync(candidate)) { entryPath = candidate; break; }
        const parent = dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
      }
      if (!entryPath) throw new Error("not installed");
      browserMod = await import(pathToFileURL(entryPath).href);
    } catch {
      throw new Error(
        `browser: true is set in poncho.config but @poncho-ai/browser is not installed.\n` +
        `  Run: pnpm add @poncho-ai/browser`,
      );
    }

    this._browserMod = browserMod;
    const browserCfg: Record<string, unknown> = typeof config.browser === "object" ? { ...config.browser } : {};
    const agentId = this.parsedAgent?.frontmatter.id ?? this.parsedAgent?.frontmatter.name ?? "default";
    const sessionId = `poncho-${agentId}`;

    const storagePersistence = await this.buildBrowserStoragePersistence(config, sessionId);
    if (storagePersistence) {
      browserCfg.storagePersistence = storagePersistence;
    }

    const session = new browserMod.BrowserSession(sessionId, browserCfg);
    this._browserSession = session;

    const tools = browserMod.createBrowserTools(
      () => session,
      // Backward compat: older @poncho-ai/browser versions expect a second
      // getConversationId callback.  Current versions read from ToolContext
      // and ignore extra args.
      () => "__default__",
    );
    for (const tool of tools) {
      if (this.isToolEnabled(tool.name)) {
        this.registerIfMissing(tool);
      }
    }
  }


  get browserSession(): unknown {
    return this._browserSession;
  }

  async shutdown(): Promise<void> {
    if (this._browserSession) {
      try { await (this._browserSession as { close(): Promise<void> }).close(); } catch { /* best-effort */ }
      this._browserSession = undefined;
    }

    await this.mcpBridge?.stopLocalServers();
    if (this.otlpSpanProcessor) {
      await this.otlpSpanProcessor.shutdown().catch((err) => {
        telemetryLog.warn(`OTLP span processor shutdown error: ${formatOtlpError(err)}`);
      });
      this.otlpSpanProcessor = undefined;
    }
    if (this.otlpTracerProvider) {
      await this.otlpTracerProvider.shutdown().catch((err) => {
        telemetryLog.warn(`OTLP tracer provider shutdown error: ${formatOtlpError(err)}`);
      });
      this.otlpTracerProvider = undefined;
    }
    this.hasOtlpExporter = false;

    // Cleanup bash environments and storage engine
    this.bashManager?.destroyAll();
    await this.storageEngine?.close();
  }

  listTools(): ToolDefinition[] {
    return this.dispatcher.list();
  }

  listSkills(): Array<{ name: string; description: string }> {
    return this.loadedSkills.map((s) => ({ name: s.name, description: s.description }));
  }

  async listSkillsForTenant(
    tenantId: string | undefined | null,
  ): Promise<Array<{ name: string; description: string }>> {
    const skills = await this.getSkillsForTenant(tenantId);
    return skills.map((s) => ({ name: s.name, description: s.description }));
  }

  /**
   * Wraps the run() generator with an OTel root span (invoke_agent) so all
   * child spans (LLM calls via AI SDK, tool execution) group under one trace.
   */
  async *runWithTelemetry(input: RunInput): AsyncGenerator<AgentEvent> {
    if (this.hasOtlpExporter && this.otlpTracerProvider) {
      const tracer = this.otlpTracerProvider.getTracer("gen_ai");
      const agentName = this.parsedAgent?.frontmatter.name ?? "agent";

      const rootSpan = tracer.startSpan(`invoke_agent ${agentName}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          ...(input.conversationId ? { "gen_ai.conversation.id": input.conversationId } : {}),
          ...(input.tenantId ? { "tenant.id": input.tenantId } : {}),
        },
      });

      const spanContext = trace.setSpan(otelContext.active(), rootSpan);

      try {
        const gen = this.run(input);
        let next: IteratorResult<AgentEvent>;
        do {
          next = await otelContext.with(spanContext, () => gen.next());
          if (!next.done) yield next.value;
        } while (!next.done);
        rootSpan.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        rootSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        rootSpan.recordException(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        rootSpan.end();
        try {
          await this.otlpSpanProcessor?.forceFlush();
        } catch (err: unknown) {
          const detail = formatOtlpError(err);
          telemetryLog.warn(`OTLP span flush failed: ${detail}`);
        }
      }
    } else {
      yield* this.run(input);
    }
  }

  async compact(
    messages: Message[],
    options?: CompactMessagesOptions,
  ): Promise<CompactResult> {
    if (!this.parsedAgent) {
      await this.initialize();
    }
    const agent = this.parsedAgent!;
    const modelName = agent.frontmatter.model?.name ?? "claude-opus-4-5";
    const modelInstance = this.modelProvider(modelName);
    const config = resolveCompactionConfig(agent.frontmatter.compaction);
    return compactMessages(modelInstance, messages, config, options);
  }

  async *run(input: RunInput): AsyncGenerator<AgentEvent> {
    if (!this.parsedAgent) {
      await this.initialize();
    }
    // Start memory + todo fetches early so they overlap with refresh I/O
    const activeMemoryStore = this.getMemoryStore(input.tenantId);
    const memoryPromise = activeMemoryStore
      ? activeMemoryStore.getMainMemory()
      : undefined;
    const todosPromise = this.todoStore
      ? this.todoStore.get(input.conversationId ?? "__default__")
      : undefined;
    await this.refreshAgentIfChanged();
    await this.refreshSkillsIfChanged();

    // Deferred MCP discovery: servers that couldn't discover at startup because the
    // env var was missing (tenant secrets provide the token instead).
    if (input.tenantId && this.mcpBridge?.hasDeferredServers()) {
      const newTools = await this.mcpBridge.discoverAndLoadDeferred(input.tenantId);
      for (const tool of newTools) {
        this.dispatcher.register(tool);
        this.registeredMcpToolNames.add(tool.name);
      }
    }

    let agent = this.parsedAgent as ParsedAgent;
    const runId = `run_${randomUUID()}`;
    const start = now();
    const maxSteps = agent.frontmatter.limits?.maxSteps ?? 20;
    const configuredTimeout = agent.frontmatter.limits?.timeout;
    const timeoutMs = this.environment === "development" && configuredTimeout == null
      ? 0 // no hard timeout in development unless explicitly configured
      : (configuredTimeout ?? 300) * 1000;
    const platformMaxDurationSec = Number(process.env.PONCHO_MAX_DURATION) || 0;
    const softDeadlineMs = (input.disableSoftDeadline || platformMaxDurationSec <= 0)
      ? 0
      : platformMaxDurationSec * 800;
    const messages: Message[] = [...(input.messages ?? [])];
    const conversationId = input.conversationId ?? "__default__";
    this.seedToolResultArchive(conversationId, input.parameters);
    const truncationSummary = this.truncateHistoricalToolResults(messages, conversationId);
    if (truncationSummary.changed) {
      costLog.debug(
        `truncated ${truncationSummary.truncatedCount} historical tool result(s) ` +
        `(archived=${truncationSummary.archivedCount}, omitted=${truncationSummary.omittedChars} chars) ` +
        `conv=${conversationId.slice(0, 8)}`,
      );
    }
    const hasFullToolResults = hasUntruncatedToolResults(messages);
    if (hasFullToolResults) {
      costLog.debug(`cache breakpoint before untruncated tool results (run=${runId.slice(0, 12)})`);
    } else {
      costLog.debug(`cache breakpoint at history tail (run=${runId.slice(0, 12)})`);
    }
    const inputMessageCount = messages.length;
    const events: AgentEvent[] = [];

    const renderCurrentAgentPrompt = (): string =>
      renderAgentPrompt(this.parsedAgent!, {
        parameters: input.parameters,
        runtime: {
          runId,
          agentId: this.parsedAgent!.frontmatter.id ?? this.parsedAgent!.frontmatter.name,
          environment: this.environment,
          workingDir: this.workingDir,
        },
      });
    const developmentContext =
      this.environment === "development" ? `\n\n${DEVELOPMENT_MODE_CONTEXT}` : "";
    const browserContext = this._browserSession
      ? `\n\n## Browser Tools

The user has a live browser viewport displayed alongside the conversation. They can see everything the browser shows in real time and interact with it directly (click, type, scroll, paste).

### Authentication
When a website requires authentication or credentials, do NOT ask the user to send them in the chat. Instead, navigate to the login page and let the user enter their credentials directly in the browser viewport. Wait for them to confirm they have logged in before continuing.

### Session persistence
Browser sessions (cookies, localStorage, login state) are automatically saved and restored across conversations. If the user logged into a website in a previous conversation, that session is likely still active. Try navigating directly to the authenticated page before asking the user to log in again.

### Reading page content
- Use \`browser_content\` to read the visible text on a page. This is fast and token-efficient.
- Use \`browser_snapshot\` to get the accessibility tree with interactive element refs for clicking and typing.
- Use \`browser_screenshot\` only when you need to see visual layout or images. Screenshots consume significantly more tokens.
- The accessibility tree may be sparse on some pages. If \`browser_snapshot\` returns little or no content, fall back to \`browser_content\` or \`browser_screenshot\`.

### Tabs and resources
Each conversation gets its own browser tab sharing a single browser instance. Call \`browser_close\` when done to free the tab. If you don't close it, the tab stays open and the user can continue interacting with it.`
      : "";
    const mainMemory = await memoryPromise;
    const boundedMainMemory =
      mainMemory && mainMemory.content.length > 4000
        ? `${mainMemory.content.slice(0, 4000)}\n...[truncated]`
        : mainMemory?.content;
    const memoryContext =
      boundedMainMemory && boundedMainMemory.trim().length > 0
        ? `
## Persistent Memory

${boundedMainMemory.trim()}`
        : "";

    const openTodos = (await todosPromise)?.filter(
      (t) => t.status === "pending" || t.status === "in_progress",
    ) ?? [];
    const todoContext =
      openTodos.length > 0
        ? `\n\n## Open Tasks\n\n${openTodos.map((t) => `- [${t.status === "in_progress" ? "IN PROGRESS" : "PENDING"}] ${t.content} (id: ${t.id})`).join("\n")}`
        : "";

    const fsContext = this.bashManager
      ? `\n\n## Filesystem

You have a persistent virtual filesystem at \`/\`. Files you create are durable across conversations.
Use the \`bash\` tool for all file operations (cat, echo, grep, awk, jq, sed, find, etc.).

Filesystem layout:
- \`/\` — your working directory (persistent, database-backed)${
          this.environment !== "production"
            ? `\n- \`/project/\` — the project source code (read-write in dev; protected paths like .env, .git/ are blocked)`
            : ""
        }

Examples:${
          this.environment !== "production"
            ? `\n- Read a project file: \`cat /project/src/index.ts\``
            : ""
        }
- Write a working file: \`echo "data" > /notes.txt\`
- Process data: \`cat /data.csv | awk -F, '{print $2}' | sort | uniq -c\`

Files in the VFS are accessible to the user via \`/api/vfs/{path}\`. For example, a file at \`/downloads/report.pdf\` can be linked as \`/api/vfs/downloads/report.pdf\`. Use this to share downloadable files with the user.`
      : "";

    // Isolate context (code execution guidance + type stubs)
    let isolateContext = "";
    if (this.loadedConfig?.isolate && this.dispatcher.get("run_code")) {
      const { generateIsolateTypeStubs } = await import("./isolate/index.js");
      const typeStubs = generateIsolateTypeStubs(this.loadedConfig.isolate);
      isolateContext = `\n\n## Code Execution

You have a \`run_code\` tool for executing JavaScript/TypeScript in a sandboxed V8 isolate.

**When to use \`run_code\` vs \`bash\`:**
- \`bash\`: file manipulation, text processing with unix tools, shell pipelines
- \`run_code\`: complex data processing, structured data, npm libraries, multi-step logic, binary file generation

**API reference (available inside the isolate):**
\`\`\`typescript
${typeStubs}
\`\`\`

Code is wrapped in an async IIFE — use \`return\` to return a value to the tool result.`;
    }

    const buildSystemPrompt = async (): Promise<string> => {
      const agentPrompt = renderCurrentAgentPrompt();
      const tenantSkills = await this.getSkillsForTenant(input.tenantId);
      const skillContextWindow = buildSkillContextWindow(tenantSkills);
      const promptWithSkills = skillContextWindow
        ? `${agentPrompt}${developmentContext}\n\n${skillContextWindow}${browserContext}${fsContext}${isolateContext}`
        : `${agentPrompt}${developmentContext}${browserContext}${fsContext}${isolateContext}`;
      // Quantize to the hour so the system prompt is stable across runs
      // within the same hour. Including a per-millisecond timestamp would
      // invalidate the prompt cache on every run, since the system prompt
      // is the first block the cache tries to match.
      const hourlyTime = (() => {
        const d = new Date();
        d.setUTCMinutes(0, 0, 0);
        const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
        return `${weekday} ${d.toISOString()}`;
      })();
      const timeContext = this.reminderStore
        ? `\n\nCurrent UTC time (hour precision): ${hourlyTime}`
        : "";
      return `${promptWithSkills}${memoryContext}${todoContext}${timeContext}`;
    };
    let systemPrompt = await buildSystemPrompt();
    let lastPromptFingerprint = `${this.agentFileFingerprint}\n${this.skillFingerprint}`;

    const pushEvent = (event: AgentEvent): AgentEvent => {
      events.push(event);
      return event;
    };
    const isCancelled = (): boolean => input.abortSignal?.aborted === true;
    let cancellationEmitted = false;
    const emitCancellation = (): AgentEvent => {
      cancellationEmitted = true;
      // Snapshot the in-flight messages so the orchestrator can persist them
      // as the canonical history. Drop a trailing assistant tool_use message
      // that has no matching tool result — sending that to the API on the next
      // turn would be rejected.
      const snapshot = trimToValidPrefix([...messages]);
      return pushEvent({ type: "run:cancelled", runId, messages: snapshot });
    };

    const resolvedModelName = agent.frontmatter.model?.name ?? "claude-opus-4-5";
    const contextWindow =
      agent.frontmatter.model?.contextWindow ?? getModelContextWindow(resolvedModelName);

    yield pushEvent({
      type: "run:started",
      runId,
      agentId: agent.frontmatter.id ?? agent.frontmatter.name,
      contextWindow,
    });

    // Subscribe to browser frame/status events for this conversation's tab.
    //
    // CRITICAL: build the listener closures via a factory whose only captured
    // variable is `browserEventQueue`. Inlining the arrow functions here would
    // make V8 capture the entire run() scope into the closures' Context object
    // — including `input.parameters.__toolResultArchive`, which can be tens
    // of MB. If a listener fails to be removed (run errors, generator abandoned)
    // the runInput snapshot stays pinned on BrowserSession.tabs[cid].statusListeners.
    // We saw this leak retain ~3.4 GB across runs in production.
    const browserEventQueue: AgentEvent[] = [];
    const browserCleanups: Array<() => void> = [];
    const browserSession = this._browserSession as
      | { onFrame: (cid: string, cb: (f: { data: string; width: number; height: number }) => void) => () => void;
          onStatus: (cid: string, cb: (s: { active: boolean; url?: string; interactionAllowed: boolean }) => void) => () => void;
          saveState: (path: string) => Promise<void>;
          close: () => Promise<void>;
          profileDir: string;
          isLaunched: boolean }
      | undefined;
    if (browserSession) {
      browserCleanups.push(
        browserSession.onFrame(conversationId, makeBrowserFrameListener(browserEventQueue)),
        browserSession.onStatus(conversationId, makeBrowserStatusListener(browserEventQueue)),
      );
    }
    const drainBrowserEvents = function* (): Generator<AgentEvent> {
      while (browserEventQueue.length > 0) {
        yield browserEventQueue.shift()!;
      }
    };

    try {
    if (input.task != null) {
      if (input.files && input.files.length > 0) {
        const parts: ContentPart[] = [
          { type: "text", text: input.task } satisfies TextContentPart,
        ];
        for (const file of input.files) {
          if (this.uploadStore) {
            const buf = await decodeFileInputData(file.data);
            const key = deriveUploadKey(buf, file.mediaType);
            const ref = await this.uploadStore.put(key, buf, file.mediaType);
            parts.push({
              type: "file",
              data: ref,
              mediaType: file.mediaType,
              filename: file.filename,
            } satisfies FileContentPart);
          } else {
            parts.push({
              type: "file",
              data: file.data,
              mediaType: file.mediaType,
              filename: file.filename,
            } satisfies FileContentPart);
          }
        }
        messages.push({
          role: "user",
          content: parts,
          metadata: { timestamp: now(), id: randomUUID() },
        });
      } else {
        messages.push({
          role: "user",
          content: input.task,
          metadata: { timestamp: now(), id: randomUUID() },
        });
      }
    } else {
      // Continuation run (no explicit task). Some providers (Anthropic) require
      // the conversation to end with a user message. Inject a transient signal
      // that is sent to the LLM but never persisted to the conversation store.
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role !== "user") {
        messages.push({
          role: "user",
          content: "[System: Your previous turn was interrupted by a time limit. Your partial response above is already visible to the user. Continue EXACTLY from where you left off — do NOT restart, re-summarize, or repeat any content you already produced. If you were mid-sentence or mid-table, continue that sentence or table. Proceed directly with the next action or output.]",
          metadata: { timestamp: now(), id: randomUUID() },
        });
      }
    }

    let responseText = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let totalCacheWriteTokens = 0;
    let transientStepRetryCount = 0;
    let latestContextTokens = 0;
    let toolOutputEstimateSinceModel = 0;
    let cachedCoreMessages: ModelMessage[] = [];
    let convertedUpTo = 0;

    for (let step = 1; step <= maxSteps; step += 1) {
      try {
        yield* drainBrowserEvents();
        if (isCancelled()) {
          yield emitCancellation();
          return;
        }
        if (timeoutMs > 0 && now() - start > timeoutMs) {
          yield pushEvent({
            type: "run:error",
            runId,
            error: {
              code: "TIMEOUT",
              message: `Run exceeded timeout of ${Math.floor(timeoutMs / 1000)}s`,
            },
          });
          return;
        }
        if (softDeadlineMs > 0 && now() - start > softDeadlineMs) {
          const result: RunResult = {
            status: "completed",
            response: responseText,
            steps: step - 1,
            tokens: {
              input: totalInputTokens,
              output: totalOutputTokens,
              cached: totalCachedTokens,
              cacheWrite: totalCacheWriteTokens,
            },
            duration: now() - start,
            continuation: true,
            continuationMessages: [...messages],
            maxSteps,
            contextTokens: latestContextTokens + toolOutputEstimateSinceModel,
            contextWindow,
          };
          yield pushEvent({ type: "run:completed", runId, result });
          return;
        }

        const stepStart = now();
        yield pushEvent({ type: "step:started", step });

        const dispatcherTools = this.dispatcher.list();
      const exposedToolNames = new Map<string, string>();
      const usedProviderToolNames = new Set<string>();
      const modelTools = dispatcherTools.map((tool, index) => {
        const safeName = toProviderSafeToolName(tool.name, index, usedProviderToolNames);
        exposedToolNames.set(safeName, tool.name);
        if (safeName === tool.name) {
          return tool;
        }
        return { ...tool, name: safeName };
      });

      // Convert tools to Vercel AI SDK format
      const tools: Record<string, { description: string; inputSchema: any }> = {};
      for (const tool of modelTools) {
        tools[tool.name] = {
          description: tool.description,
          inputSchema: jsonSchemaToZod(tool.inputSchema),
        };
      }
      const toolDefsJsonForEstimate = JSON.stringify(
        dispatcherTools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      );
      const requestTokenEstimate = estimateTotalTokens(systemPrompt, messages, toolDefsJsonForEstimate);
      yield pushEvent({ type: "model:request", tokens: requestTokenEstimate });

        // Convert messages to ModelMessage format
        const convertMessage = async (msg: Message): Promise<ModelMessage[]> => {
          if (msg.role === "tool") {
            // When rich (multi-part) tool results are attached from the
            // current run, use them directly — they include proper image
            // content blocks instead of base64 text.
            const meta = msg.metadata as Record<string, unknown> | undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rich = (meta as any)?._richToolResults as unknown[] | undefined;
            if (rich && rich.length > 0) {
              // Resolve any vfs:// references in media items before sending
              // to the model. This keeps conversation history lightweight
              // (only stores the reference) while materializing the actual
              // bytes on demand at model-request time.
              if (this.storageEngine) {
                const tid = input.tenantId ?? "__default__";
                for (const part of rich) {
                  const p = part as Record<string, unknown>;
                  if (p.output && typeof p.output === "object") {
                    const out = p.output as Record<string, unknown>;
                    if (Array.isArray(out.value)) {
                      for (let i = 0; i < out.value.length; i++) {
                        const item = out.value[i] as Record<string, unknown>;
                        if (
                          item.type === "media" &&
                          typeof item.data === "string" &&
                          (item.data as string).startsWith(VFS_SCHEME)
                        ) {
                          try {
                            const vfsPath = (item.data as string).slice(VFS_SCHEME.length);
                            const buf = await this.storageEngine.vfs.readFile(tid, vfsPath);
                            item.data = Buffer.from(buf).toString("base64");
                          } catch {
                            // File no longer available; leave as-is
                          }
                        }
                      }
                    }
                  }
                }
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return [{ role: "tool" as const, content: rich as any }];
            }

            // Fallback for historical messages loaded from storage (base64
            // already stripped, so this is always token-safe).
            const textContent = typeof msg.content === "string" ? msg.content : getTextContent(msg);
            try {
              const parsed: unknown = JSON.parse(textContent);
              if (!Array.isArray(parsed)) {
                return [];
              }
              const toolResults = parsed
                .filter((item: unknown): item is { tool_use_id: string; tool_name: string; content: string } => {
                  if (typeof item !== "object" || item === null) {
                    return false;
                  }
                  const row = item as Record<string, unknown>;
                  return (
                    typeof row.tool_use_id === "string" &&
                    typeof row.tool_name === "string" &&
                    typeof row.content === "string"
                  );
                });
              if (toolResults.length === 0) {
                return [];
              }
              return [{
                role: "tool" as const,
                content: toolResults.map((tr) => {
                  if (tr.content.startsWith("Tool error:")) {
                    return {
                      type: "tool-result" as const,
                      toolCallId: tr.tool_use_id,
                      toolName: tr.tool_name,
                      output: { type: "text" as const, value: tr.content },
                    };
                  }
                  try {
                    const resultValue = JSON.parse(tr.content);
                    return {
                      type: "tool-result" as const,
                      toolCallId: tr.tool_use_id,
                      toolName: tr.tool_name,
                      output: { type: "json" as const, value: resultValue },
                    };
                  } catch {
                    return {
                      type: "tool-result" as const,
                      toolCallId: tr.tool_use_id,
                      toolName: tr.tool_name,
                      output: { type: "text" as const, value: tr.content },
                    };
                  }
                }),
              }];
            } catch {
              return [];
            }
          }

          if (msg.role === "assistant") {
            // Assistant messages may contain serialized tool calls from previous runs.
            // Keep only valid tool-call records to avoid broken continuation payloads.
            const assistantText = typeof msg.content === "string" ? msg.content : getTextContent(msg);
            try {
              const parsed: unknown = JSON.parse(assistantText);
              if (typeof parsed === "object" && parsed !== null) {
                const parsedRecord = parsed as { text?: unknown; tool_calls?: unknown };
                if (!Array.isArray(parsedRecord.tool_calls)) {
                  return [{ role: "assistant" as const, content: assistantText }];
                }
                const textPart = typeof parsedRecord.text === "string" ? parsedRecord.text : "";
                const validToolCalls = parsedRecord.tool_calls
                  .filter((tc: unknown): tc is { id: string; name: string; input: Record<string, unknown> } => {
                    if (typeof tc !== "object" || tc === null) {
                      return false;
                    }
                    const toolCall = tc as Record<string, unknown>;
                    return (
                      typeof toolCall.id === "string" &&
                      typeof toolCall.name === "string" &&
                      toolCall.input !== null &&
                      typeof toolCall.input === "object"
                    );
                  })
                  .map((tc: { id: string; name: string; input: Record<string, unknown> }) => ({
                    type: "tool-call" as const,
                    toolCallId: tc.id,
                    toolName: tc.name,
                    input: tc.input,
                  }));
                if (textPart.length === 0 && validToolCalls.length === 0) {
                  return [];
                }
                return [{
                  role: "assistant" as const,
                  content: [
                    ...(textPart.length > 0 ? [{ type: "text" as const, text: textPart }] : []),
                    ...validToolCalls,
                  ],
                }];
              }
            } catch {
              // Not JSON, treat as regular assistant text.
            }
            if (!assistantText || assistantText.trim().length === 0) {
              return [];
            }
            return [{ role: "assistant" as const, content: assistantText }];
          }

          if (msg.role === "system") {
            return [{
              role: "system" as const,
              content: typeof msg.content === "string" ? msg.content : getTextContent(msg),
            }];
          }

          if (msg.role === "user") {
            if (typeof msg.content === "string") {
              return [{ role: "user" as const, content: msg.content }];
            }
            // Convert ContentPart[] to Vercel AI SDK UserContent.
            // Only specific media types can be sent as binary attachments —
            // everything else is inlined as text or skipped gracefully.
            const MODEL_IMAGE_TYPES = new Set([
              "image/jpeg", "image/png", "image/gif", "image/webp",
            ]);
            const MODEL_FILE_TYPES = new Set([
              "application/pdf",
            ]);
            const isTextBasedMime = (mt: string): boolean =>
              mt.startsWith("text/") ||
              mt === "application/json" ||
              mt === "application/xml" ||
              mt === "application/x-yaml" ||
              mt.endsWith("+json") ||
              mt.endsWith("+xml");

            const userContent = await Promise.all(
              msg.content.map(async (part) => {
                if (part.type === "text") {
                  return { type: "text" as const, text: part.text };
                }

                const isSupportedImage = MODEL_IMAGE_TYPES.has(part.mediaType);
                const isSupportedFile = MODEL_FILE_TYPES.has(part.mediaType);

                // Text-based files: inline the content so the model can read it
                if (!isSupportedImage && !isSupportedFile && isTextBasedMime(part.mediaType)) {
                  let textContent: string;
                  try {
                    if (part.data.startsWith(VFS_SCHEME) && this.storageEngine) {
                      const vfsPath = part.data.slice(VFS_SCHEME.length);
                      const buf = await this.storageEngine.vfs.readFile(input.tenantId ?? "__default__", vfsPath);
                      textContent = Buffer.from(buf).toString("utf8");
                    } else if (part.data.startsWith(PONCHO_UPLOAD_SCHEME) && this.uploadStore) {
                      const buf = await this.uploadStore.get(part.data);
                      textContent = buf.toString("utf8");
                    } else if (part.data.startsWith("https://") || part.data.startsWith("http://")) {
                      const resp = await fetch(part.data);
                      textContent = await resp.text();
                    } else {
                      textContent = Buffer.from(part.data, "base64").toString("utf8");
                    }
                  } catch {
                    textContent = "(could not read file)";
                  }
                  const label = part.filename ?? part.mediaType;
                  return { type: "text" as const, text: `[File: ${label}]\n${textContent}` };
                }

                // Unsupported binary formats (e.g. AVIF, HEIC, MP4): skip with a note
                if (!isSupportedImage && !isSupportedFile) {
                  const label = part.filename ?? part.mediaType;
                  return {
                    type: "text" as const,
                    text: `[Attached file: ${label} (${part.mediaType}) — this format is not supported by the model and was skipped]`,
                  };
                }

                // Always resolve to base64 so the model doesn't need to
                // fetch URLs itself (which fails for private blob stores).
                let resolvedData: string;
                try {
                  if (part.data.startsWith(VFS_SCHEME) && this.storageEngine) {
                    const vfsPath = part.data.slice(VFS_SCHEME.length);
                    const buf = await this.storageEngine.vfs.readFile(input.tenantId ?? "__default__", vfsPath);
                    resolvedData = Buffer.from(buf).toString("base64");
                  } else if (part.data.startsWith(PONCHO_UPLOAD_SCHEME) && this.uploadStore) {
                    const buf = await this.uploadStore.get(part.data);
                    resolvedData = buf.toString("base64");
                  } else if (part.data.startsWith("https://") || part.data.startsWith("http://")) {
                    if (this.uploadStore) {
                      const buf = await this.uploadStore.get(part.data);
                      resolvedData = buf.toString("base64");
                    } else {
                      const resp = await fetch(part.data);
                      resolvedData = Buffer.from(await resp.arrayBuffer()).toString("base64");
                    }
                  } else {
                    resolvedData = part.data;
                  }
                } catch {
                  const label = part.filename ?? part.mediaType;
                  return { type: "text" as const, text: `[Attached file: ${label} — file is no longer available]` };
                }
                if (isSupportedImage) {
                  return {
                    type: "image" as const,
                    image: resolvedData,
                    mediaType: part.mediaType,
                  };
                }
                return {
                  type: "file" as const,
                  data: resolvedData,
                  mediaType: part.mediaType,
                  filename: part.filename,
                };
              }),
            );
            return [{ role: "user" as const, content: userContent }];
          }

          return [];
        };

        const modelName = agent.frontmatter.model?.name ?? "claude-opus-4-5";
        if (step === 1) {
          modelLog.item(`${modelName} (provider=${agent.frontmatter.model?.provider ?? "anthropic"})`);
        }
        const modelInstance = this.modelProvider(modelName);

        // --- Auto-compaction ---
        // Re-check every N steps to curb runaway context growth in longer runs.
        const compactionConfig = resolveCompactionConfig(agent.frontmatter.compaction);
        if (compactionConfig.enabled && (step === 1 || step % COMPACTION_CHECK_INTERVAL_STEPS === 0)) {
          const estimated = estimateTotalTokens(systemPrompt, messages, toolDefsJsonForEstimate);
          // Use the actual context size from the last model response (input tokens
          // + tool output accumulated since), not totalInputTokens which is a
          // cumulative sum across all steps and would wildly overcount.
          const lastReportedContext = latestContextTokens > 0
            ? latestContextTokens + toolOutputEstimateSinceModel
            : 0;
          const effectiveTokens = Math.max(estimated, lastReportedContext);

          if (effectiveTokens > compactionConfig.trigger * contextWindow) {
            yield pushEvent({ type: "compaction:started", estimatedTokens: effectiveTokens });

            const compactResult = await compactMessages(
              modelInstance,
              messages,
              compactionConfig,
            );
            if (compactResult.compacted) {
              messages.length = 0;
              messages.push(...compactResult.messages);
              let emittedMessages: Message[] | undefined;
              if (step === 1) {
                // Strip the trailing user task message so runners can use
                // compactedMessages directly as historyMessages without
                // duplicating the user turn they append themselves.
                emittedMessages = [...compactResult.messages];
                if (emittedMessages.length > 0 && emittedMessages[emittedMessages.length - 1].role === "user") {
                  emittedMessages.pop();
                }
              }
              const tokensAfterCompaction = estimateTotalTokens(systemPrompt, messages, toolDefsJsonForEstimate);
              latestContextTokens = tokensAfterCompaction;
              toolOutputEstimateSinceModel = 0;
              yield pushEvent({
                type: "compaction:completed",
                tokensBefore: effectiveTokens,
                tokensAfter: tokensAfterCompaction,
                messagesBefore: compactResult.messagesBefore!,
                compactedMessages: emittedMessages,
                messagesAfter: compactResult.messagesAfter!,
              });
            } else if (compactResult.warning) {
              yield pushEvent({ type: "compaction:warning", reason: compactResult.warning });
            }
          }
        }

        // Only convert messages added since the last step
        if (convertedUpTo > messages.length) {
          // Compaction replaced the array — invalidate cache
          cachedCoreMessages = [];
          convertedUpTo = 0;
        }
        const newMessages = messages.slice(convertedUpTo);
        const newCoreMessages: ModelMessage[] = newMessages.length > 0
          ? (await Promise.all(newMessages.map(convertMessage))).flat()
          : [];
        cachedCoreMessages = [...cachedCoreMessages, ...newCoreMessages];
        convertedUpTo = messages.length;
        const coreMessages = cachedCoreMessages;

        const temperature = agent.frontmatter.model?.temperature ?? 0.2;
        const maxTokens = agent.frontmatter.model?.maxTokens;
        // Place the breakpoint before any untruncated tool-result so we
        // cache only the stable prefix when prior-run tool results are
        // still full-fidelity. Otherwise cache at the history tail.
        const breakpointIndex = hasFullToolResults
          ? findLastStableCacheIndex(coreMessages)
          : coreMessages.length - 1;
        const cachedMessages = addPromptCacheBreakpoints(
          coreMessages,
          modelInstance,
          breakpointIndex,
        );

        const telemetryEnabled = this.loadedConfig?.telemetry?.enabled !== false;


        const result = await streamText({
          model: modelInstance,
          system: systemPrompt,
          messages: cachedMessages,
          tools,
          temperature,
          abortSignal: input.abortSignal,
          ...(typeof maxTokens === "number" ? { maxTokens } : {}),
          experimental_telemetry: {
            isEnabled: telemetryEnabled && this.hasOtlpExporter,
            recordInputs: true,
            recordOutputs: true,
          },
        });
        // Stream full response — use fullStream to get visibility into
        // tool-call generation (tool-input-start) in addition to text deltas.
        // Enforce overall run timeout per part.
        let fullText = "";
        let chunkCount = 0;
        const hasRunTimeout = timeoutMs > 0;
        const streamDeadline = hasRunTimeout ? start + timeoutMs : 0;
        const hasSoftDeadline = softDeadlineMs > 0;
        const INTER_CHUNK_TIMEOUT_MS = 60_000;
        const fullStreamIterator = result.fullStream[Symbol.asyncIterator]();
        let softDeadlineFiredDuringStream = false;
        try {
          while (true) {
            if (isCancelled()) {
              yield emitCancellation();
              return;
            }
            if (hasRunTimeout) {
              const remaining = streamDeadline - now();
              if (remaining <= 0) {
                yield pushEvent({
                  type: "run:error",
                  runId,
                  error: {
                    code: "TIMEOUT",
                    message: `Model "${modelName}" did not respond within the ${Math.floor(timeoutMs / 1000)}s run timeout.`,
                  },
                });
                harnessLog.error(
                  `stream timeout: model=${modelName} step=${step} elapsed=${now() - start}ms`,
                );
                return;
              }
            }
            if (hasSoftDeadline && chunkCount > 0 && now() - start >= softDeadlineMs) {
              softDeadlineFiredDuringStream = true;
              break;
            }
            const hardRemaining = hasRunTimeout ? streamDeadline - now() : Infinity;
            const softRemaining = hasSoftDeadline ? Math.max(0, (start + softDeadlineMs) - now()) : Infinity;
            const deadlineRemaining = Math.min(hardRemaining, softRemaining);
            const timeout = chunkCount === 0
              ? Math.min(deadlineRemaining, FIRST_CHUNK_TIMEOUT_MS)
              : Math.min(deadlineRemaining, INTER_CHUNK_TIMEOUT_MS);
            let nextPart: IteratorResult<(typeof result.fullStream) extends AsyncIterable<infer T> ? T : never> | null;
            if (timeout <= 0 && chunkCount > 0 && !hasSoftDeadline) {
              nextPart = await fullStreamIterator.next();
            } else {
              const effectiveTimeout = Math.max(timeout, 1);
              let timer: ReturnType<typeof setTimeout> | undefined;
              nextPart = await Promise.race([
                fullStreamIterator.next(),
                new Promise<null>((resolve) => {
                  timer = setTimeout(() => resolve(null), effectiveTimeout);
                }),
              ]);
              clearTimeout(timer);
            }

            if (nextPart === null) {
              if (hasSoftDeadline && deadlineRemaining <= INTER_CHUNK_TIMEOUT_MS) {
                softDeadlineFiredDuringStream = true;
                break;
              }
              const isFirstChunk = chunkCount === 0;
              harnessLog.error(
                `stream timeout waiting for ${isFirstChunk ? "first" : "next"} chunk: model=${modelName} step=${step} chunks=${chunkCount} elapsed=${now() - start}ms`,
              );
              if (isFirstChunk) {
                throw new FirstChunkTimeoutError(modelName, FIRST_CHUNK_TIMEOUT_MS);
              }
              yield pushEvent({
                type: "run:error",
                runId,
                error: {
                  code: "TIMEOUT",
                  message: `Model "${modelName}" stopped responding during streaming (run timeout ${Math.floor(timeoutMs / 1000)}s exceeded).`,
                },
              });
              return;
            }

            if (nextPart.done) break;
            const part = nextPart.value;

            if (part.type === "text-delta") {
              chunkCount += 1;
              fullText += part.text;
              yield pushEvent({ type: "model:chunk", content: part.text });
            } else if (part.type === "tool-input-start") {
              chunkCount += 1;
              yield pushEvent({ type: "tool:generating", tool: part.toolName, toolCallId: part.id });
            }
          }
        } finally {
          fullStreamIterator.return?.(undefined)?.catch?.(() => {});
        }

        if (softDeadlineFiredDuringStream) {
          if (fullText.length > 0) {
            messages.push({
              role: "assistant",
              content: fullText,
              metadata: { timestamp: now(), id: randomUUID(), step, runId },
            });
          }
          const result_: RunResult = {
            status: "completed",
            response: responseText + fullText,
            steps: step,
            tokens: {
              input: totalInputTokens,
              output: totalOutputTokens,
              cached: totalCachedTokens,
              cacheWrite: totalCacheWriteTokens,
            },
            duration: now() - start,
            continuation: true,
            continuationMessages: [...messages],
            maxSteps,
            contextTokens: latestContextTokens + toolOutputEstimateSinceModel,
            contextWindow,
          };
          harnessLog.info(`soft deadline fired mid-stream at step ${step} (${(now() - start).toFixed(0)}ms); checkpointing with ${fullText.length} chars of partial text`);
          yield pushEvent({ type: "run:completed", runId, result: result_ });
          return;
        }

        if (isCancelled()) {
          yield emitCancellation();
          return;
        }

      // Post-streaming soft deadline: if the model stream took long enough to
      // push past the soft deadline, checkpoint now before tool execution.
      if (softDeadlineMs > 0 && now() - start > softDeadlineMs) {
        if (fullText.length > 0) {
          messages.push({
            role: "assistant",
            content: fullText,
            metadata: { timestamp: now(), id: randomUUID(), step, runId },
          });
        }
        const result_: RunResult = {
          status: "completed",
          response: responseText + fullText,
          steps: step,
          tokens: {
            input: totalInputTokens,
            output: totalOutputTokens,
            cached: totalCachedTokens,
            cacheWrite: totalCacheWriteTokens,
          },
          duration: now() - start,
          continuation: true,
          continuationMessages: [...messages],
          maxSteps,
          contextTokens: latestContextTokens + toolOutputEstimateSinceModel,
          contextWindow,
        };
        yield pushEvent({ type: "run:completed", runId, result: result_ });
        return;
      }

      // Check finish reason for error / abnormal completions.
      const finishReason = await result.finishReason;

      if (finishReason === "error") {
        yield pushEvent({
          type: "run:error",
          runId,
          error: {
            code: "MODEL_ERROR",
            message: `Model "${modelName}" returned an error. This may indicate the model is not supported by the current provider SDK version, or the API returned an error response.`,
          },
        });
        harnessLog.error(`model error: finishReason="error" model=${modelName} step=${step}`);
        return;
      }

      if (finishReason === "content-filter") {
        yield pushEvent({
          type: "run:error",
          runId,
          error: {
            code: "CONTENT_FILTER",
            message: `Response was blocked by the provider's content filter (model: ${modelName}).`,
          },
        });
        return;
      }

      // Get full response with usage and tool calls
      const fullResult = await result.response;
      const usage = await result.usage;
      const toolCallsResult = await result.toolCalls;

      // Update token usage
      const details = (usage.inputTokenDetails ?? {}) as Record<string, unknown>;
      const stepCachedTokens = typeof details.cacheReadTokens === "number" ? details.cacheReadTokens : 0;
      const stepCacheWriteTokens =
        typeof details.cacheWriteTokens === "number"
          ? details.cacheWriteTokens
          : typeof details.cacheCreationTokens === "number"
            ? details.cacheCreationTokens
            : typeof details.cacheCreationInputTokens === "number"
              ? details.cacheCreationInputTokens
              : 0;
      const stepInputTokens = usage.inputTokens ?? 0;
      totalInputTokens += stepInputTokens;
      totalOutputTokens += usage.outputTokens ?? 0;
      totalCachedTokens += stepCachedTokens;
      totalCacheWriteTokens += stepCacheWriteTokens;
      latestContextTokens = stepInputTokens;
      toolOutputEstimateSinceModel = 0;

      yield pushEvent({
        type: "model:response",
        usage: {
          input: stepInputTokens,
          output: usage.outputTokens ?? 0,
          cached: stepCachedTokens,
          cacheWrite: stepCacheWriteTokens,
        },
      });
      costLog.debug(
        `step=${step} in=${stepInputTokens} out=${usage.outputTokens ?? 0} ` +
        `cached=${stepCachedTokens} cw=${stepCacheWriteTokens} ` +
        `totals(in=${totalInputTokens} out=${totalOutputTokens} cached=${totalCachedTokens} cw=${totalCacheWriteTokens})`,
      );

      // Extract tool calls
      const toolCalls = toolCallsResult.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: (tc as any).input as Record<string, unknown>,
      }));

      if (toolCalls.length === 0) {
        // Detect silent empty responses — likely an SDK or model
        // compatibility issue, or an unexpected provider error that
        // the SDK didn't surface through finishReason.
        if (fullText.length === 0) {
          const isExpectedEmpty = finishReason === "stop";
          if (!isExpectedEmpty) {
            yield pushEvent({
              type: "run:error",
              runId,
              error: {
                code: "EMPTY_RESPONSE",
                message: `Model "${modelName}" returned no content (finish reason: ${finishReason}). The model may not be supported by the current provider SDK version.`,
              },
            });
            harnessLog.error(`empty response: finishReason="${finishReason}" model=${modelName} step=${step}`);
            return;
          }
          harnessLog.warn(`model "${modelName}" returned empty response with finishReason="stop" on step ${step}`);
        }
        if (fullText.length > 0) {
          messages.push({
            role: "assistant",
            content: fullText,
            metadata: { timestamp: now(), id: randomUUID(), step, runId },
          });
        }
        responseText = fullText;
        yield pushEvent({
          type: "step:completed",
          step,
          duration: now() - stepStart,
        });
        const result: RunResult = {
          status: "completed",
          response: responseText,
          steps: step,
          tokens: {
            input: totalInputTokens,
            output: totalOutputTokens,
            cached: totalCachedTokens,
            cacheWrite: totalCacheWriteTokens,
          },
          duration: now() - start,
          contextTokens: latestContextTokens + toolOutputEstimateSinceModel,
          contextWindow,
          continuationMessages: [...messages],
        };
        yield pushEvent({ type: "run:completed", runId, result });
        return;
      }

      const toolContext: ToolContext = {
        runId,
        agentId: agent.frontmatter.id ?? agent.frontmatter.name,
        step,
        workingDir: this.workingDir,
        parameters: input.parameters ?? {},
        abortSignal: input.abortSignal,
        conversationId: input.conversationId,
        tenantId: input.tenantId,
        vfs: this.bashManager
          ? this.createVfsAccess(input.tenantId ?? "__default__")
          : undefined,
      };

      const toolResultsForModel: Array<{
        type: "tool_result";
        tool_use_id: string;
        tool_name: string;
        content: string;
      }> = [];

      // Rich tool results that use multi-part content for images (proper
      // vision tokens instead of base64 text).  Used for the *current* step
      // model call; the `toolResultsForModel` array holds the storage-safe
      // version with base64 stripped.
      const richToolResults: Array<{
        type: "tool-result";
        toolCallId: string;
        toolName: string;
        output: { type: "json"; value: unknown } | { type: "content"; value: Array<{ type: "text"; text: string } | { type: "media"; data: string; mediaType: string }> };
      }> = [];

      const approvedCalls: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];
      const approvalNeeded: Array<{
        approvalId: string;
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];
      const deviceNeeded: Array<{
        approvalId: string;
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];

      // Phase 1: classify all tool calls.
      // Approval gates run first; device dispatch fires only after approval is
      // cleared. On a device+approval tool the first dispatch pass yields the
      // approval, and the post-resume pass (where access is no longer required
      // because the message stream has the approve decision baked in) sees
      // dispatch="device" still set and falls into deviceNeeded below.
      for (const call of toolCalls) {
        if (isCancelled()) {
          yield emitCancellation();
          return;
        }
        const runtimeToolName = exposedToolNames.get(call.name) ?? call.name;
        yield pushEvent({ type: "tool:started", tool: runtimeToolName, input: call.input });
        if (this.requiresApprovalForToolCall(runtimeToolName, call.input)) {
          approvalNeeded.push({
            approvalId: `approval_${randomUUID()}`,
            id: call.id,
            name: runtimeToolName,
            input: call.input,
          });
        } else if (this.resolveToolMode(runtimeToolName).dispatch === "device") {
          deviceNeeded.push({
            approvalId: `device_${randomUUID()}`,
            id: call.id,
            name: runtimeToolName,
            input: call.input,
          });
        } else {
          approvedCalls.push({
            id: call.id,
            name: runtimeToolName,
            input: call.input,
          });
        }
      }

      // Phase 2a: if any tools need approval, emit events for ALL of them and checkpoint
      if (approvalNeeded.length > 0) {
        for (const an of approvalNeeded) {
          yield pushEvent({
            type: "tool:approval:required",
            tool: an.name,
            input: an.input,
            approvalId: an.approvalId,
          });
        }

        const assistantContent = JSON.stringify({
          text: fullText,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            name: exposedToolNames.get(tc.name) ?? tc.name,
            input: tc.input,
          })),
        });
        const assistantMsg: Message = {
          role: "assistant",
          content: assistantContent,
          metadata: { timestamp: now(), id: randomUUID(), step, runId },
        };
        const deltaMessages = [...messages.slice(inputMessageCount), assistantMsg];
        yield pushEvent({
          type: "tool:approval:checkpoint",
          approvals: approvalNeeded.map(an => ({
            approvalId: an.approvalId,
            tool: an.name,
            toolCallId: an.id,
            input: an.input,
          })),
          checkpointMessages: deltaMessages,
          pendingToolCalls: toolCalls.map(tc => ({
            id: tc.id,
            name: exposedToolNames.get(tc.name) ?? tc.name,
            input: tc.input,
          })),
        });
        return;
      }

      // Phase 2a': if any tools must dispatch to a connected device, emit
      // tool:device:required events for each and checkpoint with kind="device".
      // Consumers (e.g. PonchOS) route the events to the right WS and POST
      // the resulting tool output back through resumeRunFromCheckpoint.
      if (deviceNeeded.length > 0) {
        for (const dn of deviceNeeded) {
          yield pushEvent({
            type: "tool:device:required",
            tool: dn.name,
            input: dn.input,
            requestId: dn.approvalId,
          });
        }

        const assistantContent = JSON.stringify({
          text: fullText,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            name: exposedToolNames.get(tc.name) ?? tc.name,
            input: tc.input,
          })),
        });
        const assistantMsg: Message = {
          role: "assistant",
          content: assistantContent,
          metadata: { timestamp: now(), id: randomUUID(), step, runId },
        };
        const deltaMessages = [...messages.slice(inputMessageCount), assistantMsg];
        yield pushEvent({
          type: "tool:device:checkpoint",
          approvals: deviceNeeded.map(dn => ({
            approvalId: dn.approvalId,
            tool: dn.name,
            toolCallId: dn.id,
            input: dn.input,
          })),
          checkpointMessages: deltaMessages,
          pendingToolCalls: toolCalls.map(tc => ({
            id: tc.id,
            name: exposedToolNames.get(tc.name) ?? tc.name,
            input: tc.input,
          })),
        });
        return;
      }

      // Phase 2b: no approvals needed — execute all auto-approved calls
      const batchStart = now();
      if (isCancelled()) {
        yield emitCancellation();
        return;
      }

      // OTel GenAI execute_tool spans for tool call visibility in traces
      type OtelSpan = ReturnType<ReturnType<typeof trace.getTracer>["startSpan"]>;
      const toolSpans = new Map<string, OtelSpan>();
      if (this.hasOtlpExporter && this.otlpTracerProvider) {
        const tracer = this.otlpTracerProvider.getTracer("gen_ai");
        for (const call of approvedCalls) {
          const toolDef = this.dispatcher.get(call.name);
          toolSpans.set(call.id, tracer.startSpan(`execute_tool ${call.name}`, {
            kind: SpanKind.INTERNAL,
            attributes: {
              "gen_ai.operation.name": "execute_tool",
              "gen_ai.tool.name": call.name,
              "gen_ai.tool.call.id": call.id,
              "gen_ai.tool.type": "function",
              ...(toolDef?.description ? { "gen_ai.tool.description": toolDef.description } : {}),
              "gen_ai.tool.call.arguments": JSON.stringify(call.input),
            },
          }));
        }
      }

      // Race tool execution against the soft deadline so long-running tool
      // batches (e.g. 4 parallel web_search calls) can't push us past the
      // hard platform timeout.  If the deadline fires first, we checkpoint
      // with the pre-tool messages and the step will be re-done on
      // continuation (assistant + tool results are not yet in `messages`).
      const TOOL_DEADLINE_SENTINEL = Symbol("tool_deadline");
      const toolDeadlineRemainingMs = softDeadlineMs > 0
        ? softDeadlineMs - (now() - start)
        : Infinity;

      let batchResults: Awaited<ReturnType<typeof this.dispatcher.executeBatch>>;
      if (approvedCalls.length === 0) {
        batchResults = [];
      } else if (toolDeadlineRemainingMs <= 0) {
        batchResults = TOOL_DEADLINE_SENTINEL as never;
      } else if (toolDeadlineRemainingMs < Infinity) {
        const raced = await Promise.race([
          this.dispatcher.executeBatch(approvedCalls, toolContext),
          new Promise<typeof TOOL_DEADLINE_SENTINEL>((resolve) =>
            setTimeout(() => resolve(TOOL_DEADLINE_SENTINEL), toolDeadlineRemainingMs),
          ),
        ]);
        if (raced === TOOL_DEADLINE_SENTINEL) {
          batchResults = TOOL_DEADLINE_SENTINEL as never;
        } else {
          batchResults = raced;
        }
      } else {
        batchResults = await this.dispatcher.executeBatch(approvedCalls, toolContext);
      }

      if ((batchResults as unknown) === TOOL_DEADLINE_SENTINEL) {
        if (fullText.length > 0) {
          messages.push({
            role: "assistant",
            content: fullText,
            metadata: { timestamp: now(), id: randomUUID(), step, runId },
          });
        }
        const result_: RunResult = {
          status: "completed",
          response: responseText + fullText,
          steps: step,
          tokens: {
            input: totalInputTokens,
            output: totalOutputTokens,
            cached: totalCachedTokens,
            cacheWrite: totalCacheWriteTokens,
          },
          duration: now() - start,
          continuation: true,
          continuationMessages: [...messages],
          maxSteps,
          contextTokens: latestContextTokens + toolOutputEstimateSinceModel,
          contextWindow,
        };
        yield pushEvent({ type: "run:completed", runId, result: result_ });
        return;
      }

      if (isCancelled()) {
        yield emitCancellation();
        return;
      }

      const callInputMap = new Map(approvedCalls.map((c) => [c.id, c.input]));
      for (const result of batchResults) {
        const span = toolSpans.get(result.callId);
        if (result.error) {
          if (span) {
            span.setAttribute("error.type", "Error");
            span.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
            span.recordException(new Error(result.error));
            span.end();
          }
          yield pushEvent({
            type: "tool:error",
            tool: result.tool,
            error: result.error,
            recoverable: true,
          });
          toolResultsForModel.push({
            type: "tool_result",
            tool_use_id: result.callId,
            tool_name: result.tool,
            content: `Tool error: ${result.error}`,
          });
          {
            const archive = this.archivedToolResultsByConversation.get(conversationId);
            if (archive) {
              archive[result.callId] = {
                toolResultId: result.callId,
                conversationId,
                toolName: result.tool,
                toolCallId: result.callId,
                createdAt: now(),
                sizeBytes: Buffer.byteLength(`Tool error: ${result.error}`, "utf8"),
                payload: `Tool error: ${result.error}`,
              };
            }
          }
          richToolResults.push({
            type: "tool-result",
            toolCallId: result.callId,
            toolName: result.tool,
            output: { type: "json", value: { error: result.error } },
          });
        } else {
          if (span) {
            span.setAttribute("gen_ai.tool.call.result", JSON.stringify(result.output ?? null));
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
          }
          const serialized = JSON.stringify(result.output ?? null);
          const outputTokenEstimate = Math.ceil(serialized.length / 4);
          toolOutputEstimateSinceModel += outputTokenEstimate;
          yield pushEvent({
            type: "tool:completed",
            tool: result.tool,
            input: callInputMap.get(result.callId),
            output: result.output,
            duration: now() - batchStart,
            outputTokenEstimate,
          });

          const { mediaItems, strippedOutput } = extractMediaFromToolOutput(result.output);
          toolResultsForModel.push({
            type: "tool_result",
            tool_use_id: result.callId,
            tool_name: result.tool,
            content: JSON.stringify(strippedOutput ?? null),
          });
          {
            const archive = this.archivedToolResultsByConversation.get(conversationId);
            if (archive && !NON_ARCHIVABLE_TOOL_NAMES.has(result.tool)) {
              const payload = JSON.stringify(result.output ?? null);
              archive[result.callId] = {
                toolResultId: result.callId,
                conversationId,
                toolName: result.tool,
                toolCallId: result.callId,
                createdAt: now(),
                sizeBytes: Buffer.byteLength(payload, "utf8"),
                payload,
              };
              enforceArchiveCap(archive);
            }
          }

          if (mediaItems.length > 0) {
            richToolResults.push({
              type: "tool-result",
              toolCallId: result.callId,
              toolName: result.tool,
              output: {
                type: "content",
                value: [
                  { type: "text", text: JSON.stringify(strippedOutput ?? null) },
                  ...mediaItems,
                ],
              },
            });
          } else {
            richToolResults.push({
              type: "tool-result",
              toolCallId: result.callId,
              toolName: result.tool,
              output: { type: "json", value: result.output ?? null },
            });
          }
        }
      }

      // Store assistant message with tool calls information
      const assistantContent = toolCalls.length > 0
        ? JSON.stringify({
            text: fullText,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id,
              name: tc.name,
              input: tc.input,
            })),
          })
        : fullText;

      messages.push({
        role: "assistant",
        content: assistantContent,
        metadata: { timestamp: now(), id: randomUUID(), step, runId },
      });
      const toolMsgMeta: Record<string, unknown> = {
        timestamp: now(),
        id: randomUUID(),
        step,
        runId,
        _richToolResults: richToolResults,
      };
      messages.push({
        role: "tool",
        content: JSON.stringify(toolResultsForModel),
        metadata: toolMsgMeta as Message["metadata"],
      });

      // Post-tool-execution soft deadline: long-running tool batches (e.g.
      // multiple web_search calls) can push past the deadline. Checkpoint
      // now so the platform doesn't hard-kill us before we can continue.
      if (softDeadlineMs > 0 && now() - start > softDeadlineMs) {
        const result_: RunResult = {
          status: "completed",
          response: responseText + fullText,
          steps: step,
          tokens: {
            input: totalInputTokens,
            output: totalOutputTokens,
            cached: totalCachedTokens,
            cacheWrite: totalCacheWriteTokens,
          },
          duration: now() - start,
          continuation: true,
          continuationMessages: [...messages],
          maxSteps,
          contextTokens: latestContextTokens + toolOutputEstimateSinceModel,
          contextWindow,
        };
        yield pushEvent({ type: "run:completed", runId, result: result_ });
        return;
      }

        // In development, re-read AGENT.md and re-scan skills after tool
        // execution so changes are available on the next step without
        // requiring a server restart.
        if (this.environment === "development") {
          const agentChanged = await this.refreshAgentIfChanged();
          const skillsChanged = await this.refreshSkillsIfChanged(true);
          if (agentChanged || skillsChanged) {
            agent = this.parsedAgent as ParsedAgent;
            const currentFingerprint = `${this.agentFileFingerprint}\n${this.skillFingerprint}`;
            if (currentFingerprint !== lastPromptFingerprint) {
              systemPrompt = await buildSystemPrompt();
              lastPromptFingerprint = currentFingerprint;
            }
          }
        }

        yield pushEvent({
          type: "step:completed",
          step,
          duration: now() - stepStart,
        });
        transientStepRetryCount = 0;
      } catch (error) {
        if (isCancelled() || isAbortError(error)) {
          if (!cancellationEmitted) {
            yield emitCancellation();
          }
          return;
        }
        if (isRetryableModelError(error) && transientStepRetryCount < MAX_TRANSIENT_STEP_RETRIES) {
          transientStepRetryCount += 1;
          const statusCode = getErrorStatusCode(error);
          harnessLog.warn(
            `retrying step ${step} after transient model error (attempt ${transientStepRetryCount}/${MAX_TRANSIENT_STEP_RETRIES})${
              typeof statusCode === "number" ? ` status=${statusCode}` : ""
            }: ${fmtErr(error)}`,
          );
          step -= 1;
          continue;
        }
        const runError = toRunError(error);
        yield pushEvent({
          type: "run:error",
          runId,
          error: runError,
        });
        harnessLog.error(`step ${step} error: ${fmtErr(error)}`);
        return;
      }
    }

    if (softDeadlineMs > 0) {
      const result: RunResult = {
        status: "completed",
        response: responseText,
        steps: maxSteps,
        tokens: {
          input: totalInputTokens,
          output: totalOutputTokens,
          cached: totalCachedTokens,
          cacheWrite: totalCacheWriteTokens,
        },
        duration: now() - start,
        continuation: true,
        continuationMessages: [...messages],
        maxSteps,
        contextTokens: latestContextTokens + toolOutputEstimateSinceModel,
        contextWindow,
      };
      yield pushEvent({ type: "run:completed", runId, result });
    } else {
      yield pushEvent({
        type: "run:error",
        runId,
        error: {
          code: "MAX_STEPS_EXCEEDED",
          message: `Run reached maximum of ${maxSteps} steps`,
        },
      });
    }

    // Drain any remaining browser events
    yield* drainBrowserEvents();
    } finally {
      // Clean up subscriptions even if the run errored or the consumer
      // abandoned the generator. Listeners on BrowserSession.tabs[cid]
      // capture the runInput; leaving them registered pins the
      // __toolResultArchive across runs and was the root of a multi-GB
      // heap leak.
      for (const cleanup of browserCleanups) {
        try { cleanup(); } catch { /* best-effort */ }
      }
    }
  }

  async executeTools(
    calls: ToolCall[],
    context: ToolContext,
  ): Promise<ToolExecutionResult[]> {
    return this.dispatcher.executeBatch(calls, context);
  }

  async *continueFromToolResult(input: {
    messages: Message[];
    toolResults: Array<{ callId: string; toolName: string; result?: unknown; error?: string }>;
    conversationId?: string;
    parameters?: Record<string, unknown>;
    abortSignal?: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    const messages = [...input.messages];
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") {
      throw new Error("continueFromToolResult: last message must be an assistant message with tool calls");
    }

    let allToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    try {
      const parsed = JSON.parse(typeof lastMsg.content === "string" ? lastMsg.content : "");
      allToolCalls = parsed.tool_calls ?? [];
    } catch {
      throw new Error("continueFromToolResult: could not parse tool calls from last assistant message");
    }

    const providedMap = new Map(
      input.toolResults.map(r => [r.callId, r]),
    );
    const toolResultsForModel: Array<{
      type: "tool_result";
      tool_use_id: string;
      tool_name: string;
      content: string;
    }> = [];

    for (const tc of allToolCalls) {
      const provided = providedMap.get(tc.id);
      if (provided) {
        toolResultsForModel.push({
          type: "tool_result",
          tool_use_id: tc.id,
          tool_name: provided.toolName,
          content: provided.error
            ? `Tool error: ${provided.error}`
            : JSON.stringify(provided.result ?? null),
        });
      } else {
        toolResultsForModel.push({
          type: "tool_result",
          tool_use_id: tc.id,
          tool_name: tc.name,
          content: "Tool error: Tool execution deferred (pending approval checkpoint)",
        });
      }
    }

    messages.push({
      role: "tool",
      content: JSON.stringify(toolResultsForModel),
      metadata: { timestamp: Date.now(), id: randomUUID() },
    });

    yield* this.runWithTelemetry({
      messages,
      conversationId: input.conversationId,
      parameters: input.parameters,
      abortSignal: input.abortSignal,
    });
  }

  async runToCompletion(input: RunInput): Promise<HarnessRunOutput> {
    const events: AgentEvent[] = [];
    let runId = "";
    let finalResult: RunResult | undefined;
    const messages: Message[] = [...(input.messages ?? [])];
    if (input.task != null) {
      messages.push({ role: "user", content: input.task });
    }

    for await (const event of this.runWithTelemetry(input)) {
      events.push(event);
      if (event.type === "run:started") {
        runId = event.runId;
      }
      if (event.type === "run:completed") {
        finalResult = event.result;
        messages.push({
          role: "assistant",
          content: event.result.response ?? "",
        });
      }
      if (event.type === "run:error") {
        finalResult = {
          status: "error",
          response: event.error.message,
          steps: 0,
          tokens: { input: 0, output: 0, cached: 0 },
          duration: 0,
        };
      }
      if (event.type === "run:cancelled") {
        finalResult = {
          status: "cancelled",
          steps: 0,
          tokens: { input: 0, output: 0, cached: 0 },
          duration: 0,
        };
      }
    }

    return {
      runId,
      events,
      messages,
      result:
        finalResult ??
        ({
          status: "error",
          response: "Run ended unexpectedly",
          steps: 0,
          tokens: { input: 0, output: 0, cached: 0 },
          duration: 0,
        } satisfies RunResult),
    };
  }
}
