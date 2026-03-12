import { randomUUID } from "node:crypto";
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
import { getTextContent } from "@poncho-ai/sdk";
import type { UploadStore } from "./upload-store.js";
import { PONCHO_UPLOAD_SCHEME, deriveUploadKey } from "./upload-store.js";
import { parseAgentFile, renderAgentPrompt, type ParsedAgent, type AgentFrontmatter } from "./agent-parser.js";
import { loadPonchoConfig, resolveMemoryConfig, type PonchoConfig, type ToolAccess, type BuiltInToolToggles } from "./config.js";
import { createDefaultTools, createDeleteDirectoryTool, createDeleteTool, createWriteTool, ponchoDocsTool } from "./default-tools.js";
import {
  createMemoryStore,
  createMemoryTools,
  type MemoryStore,
} from "./memory.js";
import { LocalMcpBridge } from "./mcp.js";
import { createModelProvider, getModelContextWindow, type ModelProviderFactory, type ProviderConfig } from "./model-factory.js";
import { buildSkillContextWindow, loadSkillMetadata } from "./skill-context.js";
import { generateText, streamText, type ModelMessage } from "ai";
import { addPromptCacheBreakpoints } from "./prompt-cache.js";
import { jsonSchemaToZod } from "./schema-converter.js";
import type { SkillMetadata } from "./skill-context.js";
import { createSkillTools, normalizeScriptPolicyPath } from "./skill-tools.js";
import { createSubagentTools } from "./subagent-tools.js";
import type { SubagentManager } from "./subagent-manager.js";
import { LatitudeTelemetry } from "@latitude-data/telemetry";
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
}

export interface HarnessRunOutput {
  runId: string;
  result: RunResult;
  events: AgentEvent[];
  messages: Message[];
}

const now = (): number => Date.now();
const FIRST_CHUNK_TIMEOUT_MS = 300_000; // 300s to receive the first chunk from the model
const MAX_TRANSIENT_STEP_RETRIES = 2;

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
  if (isNoOutputGeneratedError(error)) {
    return true;
  }
  const statusCode = getErrorStatusCode(error);
  if (typeof statusCode === "number") {
    return statusCode === 429 || statusCode >= 500;
  }
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeMessage = "message" in error ? String(error.message ?? "").toLowerCase() : "";
  return (
    maybeMessage.includes("internal server error") ||
    maybeMessage.includes("service unavailable") ||
    maybeMessage.includes("gateway timeout") ||
    maybeMessage.includes("rate limit")
  );
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

const DEVELOPMENT_MODE_CONTEXT = `## Development Mode Context

You are running locally in development mode. Treat this as an editable agent workspace.

## Understanding Your Environment

- Built-in tools: \`list_directory\` and \`read_file\`
- \`write_file\` is available in development (disabled by default in production)
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

When configuring Latitude telemetry, use **exactly** these field names:

\`\`\`javascript
telemetry: {
  enabled: true,
  latitude: {
    apiKeyEnv: "LATITUDE_API_KEY",       // env var name (default)
    projectIdEnv: "LATITUDE_PROJECT_ID", // env var name (default)
    path: "your/prompt-path",            // optional, defaults to agent name
  },
},
\`\`\`

- \`apiKeyEnv\` specifies the environment variable name for the Latitude API key (defaults to \`"LATITUDE_API_KEY"\`).
- \`projectIdEnv\` specifies the environment variable name for the project ID (defaults to \`"LATITUDE_PROJECT_ID"\`).
- With defaults, you only need \`telemetry: { latitude: {} }\` if the env vars are already named \`LATITUDE_API_KEY\` and \`LATITUDE_PROJECT_ID\`.
- \`path\` must only contain letters, numbers, hyphens, underscores, dots, and slashes.
- For a generic OTLP endpoint instead: \`telemetry: { otlp: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }\`.

## Credential Configuration Pattern

All credentials in \`poncho.config.js\` use the **env var name** pattern (\`*Env\` fields). Config specifies which environment variable to read — never the secret itself. Sensible defaults mean zero config when using conventional env var names.

\`\`\`javascript
// poncho.config.js — credentials use *Env fields with defaults
export default {
  // Model provider API keys (optional, defaults shown)
  providers: {
    anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
    openai: { apiKeyEnv: "OPENAI_API_KEY" },
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
    latitude: {
      apiKeyEnv: "LATITUDE_API_KEY",       // default
      projectIdEnv: "LATITUDE_PROJECT_ID", // default
    },
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
        (obj.mediaType as string).startsWith("image/")
      ) {
        mediaItems.push({
          type: "media",
          data: obj.data as string,
          mediaType: obj.mediaType as string,
        });
        return { type: "file", mediaType: obj.mediaType, filename: obj.filename ?? "image", _stripped: true };
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
  private skillContextWindow = "";
  private memoryStore?: MemoryStore;
  private loadedConfig?: PonchoConfig;
  private loadedSkills: SkillMetadata[] = [];
  private skillFingerprint = "";
  private lastSkillRefreshAt = 0;
  private readonly activeSkillNames = new Set<string>();
  private readonly registeredMcpToolNames = new Set<string>();
  private latitudeTelemetry?: LatitudeTelemetry;
  private insideTelemetryCapture = false;
  private _browserSession?: unknown;
  private _browserMod?: {
    createBrowserTools: (getSession: () => unknown, getConversationId: () => string) => ToolDefinition[];
    BrowserSession: new (sessionId: string, config: Record<string, unknown>) => unknown;
  };

  private parsedAgent?: ParsedAgent;
  private mcpBridge?: LocalMcpBridge;
  private subagentManager?: SubagentManager;

  private resolveToolAccess(toolName: string): ToolAccess {
    const tools = this.loadedConfig?.tools;
    if (!tools) return true;

    const env = this.environment ?? "development";
    const envOverride = tools.byEnvironment?.[env]?.[toolName];
    if (envOverride !== undefined) return envOverride;

    const flatValue = tools[toolName];
    if (typeof flatValue === "boolean" || flatValue === "approval") return flatValue;

    const legacyValue = tools.defaults?.[toolName as keyof BuiltInToolToggles];
    if (legacyValue !== undefined) return legacyValue;

    return true;
  }

  private isToolEnabled(name: string): boolean {
    const access = this.resolveToolAccess(name);
    if (access === false) return false;
    if (name === "write_file" || name === "delete_file" || name === "delete_directory") {
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
      createSubagentTools(
        manager,
        () => this._currentRunConversationId,
        () => this._currentRunOwnerId ?? "anonymous",
      ),
    );
  }

  private registerConfiguredBuiltInTools(config: PonchoConfig | undefined): void {
    for (const tool of createDefaultTools(this.workingDir)) {
      if (this.isToolEnabled(tool.name)) {
        this.registerIfMissing(tool);
      }
    }
    if (this.isToolEnabled("write_file")) {
      this.registerIfMissing(createWriteTool(this.workingDir));
    }
    if (this.isToolEnabled("delete_file")) {
      this.registerIfMissing(createDeleteTool(this.workingDir));
    }
    if (this.isToolEnabled("delete_directory")) {
      this.registerIfMissing(createDeleteDirectoryTool(this.workingDir));
    }
    if (this.environment === "development" && this.isToolEnabled("poncho_docs")) {
      this.registerIfMissing(ponchoDocsTool);
    }
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

    if (options.toolDefinitions?.length) {
      this.dispatcher.registerMany(options.toolDefinitions);
    }
  }

  get frontmatter(): AgentFrontmatter | undefined {
    return this.parsedAgent?.frontmatter;
  }

  private listActiveSkills(): string[] {
    return [...this.activeSkillNames].sort();
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

  private getRequestedMcpPatterns(): string[] {
    const skillPatterns = new Set<string>();
    for (const skillName of this.activeSkillNames) {
      const skill = this.loadedSkills.find((entry) => entry.name === skillName);
      if (!skill) {
        continue;
      }
      for (const pattern of skill.allowedTools.mcp) {
        skillPatterns.add(pattern);
      }
    }
    if (skillPatterns.size > 0) {
      return [...skillPatterns];
    }
    return this.getAgentMcpIntent();
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
    const skillPatterns = new Set<string>();
    for (const skillName of this.activeSkillNames) {
      const skill = this.loadedSkills.find((entry) => entry.name === skillName);
      if (!skill) {
        continue;
      }
      for (const pattern of skill.approvalRequired.mcp) {
        skillPatterns.add(pattern);
      }
    }
    if (skillPatterns.size > 0) {
      return [...skillPatterns];
    }
    return this.getAgentMcpApprovalPatterns();
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
    if (this.resolveToolAccess(toolName) === "approval") {
      return true;
    }
    if (toolName === "run_skill_script") {
      const rawScript = typeof input.script === "string" ? input.script.trim() : "";
      if (!rawScript) {
        return false;
      }
      const canonicalPath = normalizeRelativeScriptPattern(
        `./${normalizeScriptPolicyPath(rawScript)}`,
        "run_skill_script input.script",
      );
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
      console.info(
        `[poncho][mcp] ${JSON.stringify({ event: "tools.cleared", reason, requestedPatterns })}`,
      );
      return;
    }
    const tools = await this.mcpBridge.loadTools(requestedPatterns);
    this.dispatcher.registerMany(tools);
    for (const tool of tools) {
      this.registeredMcpToolNames.add(tool.name);
    }
    console.info(
      `[poncho][mcp] ${JSON.stringify({
        event: "tools.refreshed",
        reason,
        requestedPatterns,
        registeredCount: tools.length,
        activeSkills: this.listActiveSkills(),
      })}`,
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

  private registerSkillTools(skillMetadata: SkillMetadata[]): void {
    this.dispatcher.unregisterMany(SKILL_TOOL_NAMES);
    this.dispatcher.registerMany(
      createSkillTools(skillMetadata, {
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

  private async refreshSkillsIfChanged(): Promise<void> {
    if (this.environment !== "development") {
      return;
    }
    const elapsed = Date.now() - this.lastSkillRefreshAt;
    if (this.lastSkillRefreshAt > 0 && elapsed < AgentHarness.SKILL_REFRESH_DEBOUNCE_MS) {
      return;
    }
    this.lastSkillRefreshAt = Date.now();
    try {
      const latestSkills = await loadSkillMetadata(
        this.workingDir,
        this.loadedConfig?.skillPaths,
      );
      const nextFingerprint = this.buildSkillFingerprint(latestSkills);
      if (nextFingerprint === this.skillFingerprint) {
        return;
      }
      this.loadedSkills = latestSkills;
      this.skillContextWindow = buildSkillContextWindow(latestSkills);
      this.skillFingerprint = nextFingerprint;
      this.registerSkillTools(latestSkills);
      // Skill metadata or layout changed; force re-activation to avoid stale
      // instructions/tooling when files are renamed or moved during development.
      this.activeSkillNames.clear();
      await this.refreshMcpTools("skills:changed");
    } catch (error) {
      console.warn(
        `[poncho][skills] Failed to refresh skills in development mode: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async initialize(): Promise<void> {
    this.parsedAgent = await parseAgentFile(this.workingDir);
    const identity = await ensureAgentIdentity(this.workingDir);
    if (!this.parsedAgent.frontmatter.id) {
      this.parsedAgent.frontmatter.id = identity.id;
    }
    const config = await loadPonchoConfig(this.workingDir);
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
    this.skillContextWindow = buildSkillContextWindow(skillMetadata);
    this.skillFingerprint = this.buildSkillFingerprint(skillMetadata);
    this.registerSkillTools(skillMetadata);
    if (memoryConfig?.enabled) {
      const agentId = this.parsedAgent.frontmatter.id ?? this.parsedAgent.frontmatter.name;
      this.memoryStore = createMemoryStore(
        agentId,
        memoryConfig,
        { workingDir: this.workingDir },
      );
      this.dispatcher.registerMany(
        createMemoryTools(this.memoryStore, {
          maxRecallConversations: memoryConfig.maxRecallConversations,
        }),
      );
    }

    if (config?.browser) {
      await this.initBrowserTools(config)
        .catch((e) => {
          console.warn(
            `[poncho][browser] Failed to load browser tools: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    }

    await bridge.startLocalServers();
    await bridge.discoverTools();
    await this.refreshMcpTools("initialize");

    // Initialize Latitude telemetry once so the OpenTelemetry global state
    // (context manager, tracer provider, propagator) is set up exactly once.
    // Creating a new LatitudeTelemetry per run would break on the second call
    // because @opentelemetry/api silently ignores repeated global registrations.
    const telemetryEnabled = config?.telemetry?.enabled !== false;
    const latitudeBlock = config?.telemetry?.latitude;
    const latApiKeyEnv = latitudeBlock?.apiKeyEnv ?? "LATITUDE_API_KEY";
    const latProjectIdEnv = latitudeBlock?.projectIdEnv ?? "LATITUDE_PROJECT_ID";
    const latitudeApiKey = process.env[latApiKeyEnv];
    const rawProjectId = process.env[latProjectIdEnv];
    const latitudeProjectId = rawProjectId ? parseInt(rawProjectId, 10) : undefined;
    if (telemetryEnabled && latitudeApiKey && latitudeProjectId) {
      this.latitudeTelemetry = new LatitudeTelemetry(latitudeApiKey);
    } else if (telemetryEnabled && latitudeBlock && (!latitudeApiKey || !latitudeProjectId)) {
      const missing: string[] = [];
      if (!latitudeApiKey) missing.push(`${latApiKeyEnv} env var`);
      if (!latitudeProjectId) missing.push(`${latProjectIdEnv} env var`);
      console.warn(
        `[poncho][telemetry] Latitude telemetry is configured but missing: ${missing.join(", ")}. Traces will NOT be sent.`,
      );
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

    if (provider === "upstash") {
      const urlEnv = config.storage?.urlEnv ?? (process.env.UPSTASH_REDIS_REST_URL ? "UPSTASH_REDIS_REST_URL" : "KV_REST_API_URL");
      const tokenEnv = config.storage?.tokenEnv ?? (process.env.UPSTASH_REDIS_REST_TOKEN ? "UPSTASH_REDIS_REST_TOKEN" : "KV_REST_API_TOKEN");
      const baseUrl = (process.env[urlEnv] ?? "").replace(/\/+$/, "");
      const token = process.env[tokenEnv] ?? "";
      if (!baseUrl || !token) return undefined;
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      return {
        async save(json: string) {
          await fetch(`${baseUrl}/set/${encodeURIComponent(stateKey)}/${encodeURIComponent(json)}`, { method: "POST", headers });
        },
        async load() {
          const res = await fetch(`${baseUrl}/get/${encodeURIComponent(stateKey)}`, { headers });
          if (!res.ok) return undefined;
          const body = await res.json() as { result?: string | null };
          return body.result ?? undefined;
        },
      };
    }

    if (provider === "redis") {
      const urlEnv = config.storage?.urlEnv ?? "REDIS_URL";
      const url = process.env[urlEnv] ?? "";
      if (!url) return undefined;
      let clientPromise: Promise<{ get(k: string): Promise<string | null>; set(k: string, v: string): Promise<unknown> } | undefined> | undefined;
      const getClient = () => {
        if (!clientPromise) {
          clientPromise = (async () => {
            try {
              const mod = (await import("redis")) as unknown as {
                createClient: (opts: { url: string }) => {
                  connect(): Promise<unknown>;
                  get(k: string): Promise<string | null>;
                  set(k: string, v: string): Promise<unknown>;
                };
              };
              const c = mod.createClient({ url });
              await c.connect();
              return c;
            } catch { return undefined; }
          })();
        }
        return clientPromise;
      };
      return {
        async save(json: string) {
          const c = await getClient();
          if (c) await c.set(stateKey, json);
        },
        async load() {
          const c = await getClient();
          if (!c) return undefined;
          const val = await c.get(stateKey);
          return val ?? undefined;
        },
      };
    }

    return undefined;
  }

  private async initBrowserTools(config: PonchoConfig): Promise<void> {
    const spec = ["@poncho-ai", "browser"].join("/");
    let browserMod: {
      createBrowserTools: (getSession: () => unknown, getConversationId: () => string) => ToolDefinition[];
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
      () => this._currentRunConversationId ?? "__default__",
    );
    for (const tool of tools) {
      if (this.isToolEnabled(tool.name)) {
        this.registerIfMissing(tool);
      }
    }
  }

  /** Conversation ID of the currently executing run (set during run, cleared after). */
  private _currentRunConversationId?: string;
  /** Owner ID of the currently executing run (used by subagent tools). */
  private _currentRunOwnerId?: string;

  get browserSession(): unknown {
    return this._browserSession;
  }

  async shutdown(): Promise<void> {
    if (this._browserSession) {
      try { await (this._browserSession as { close(): Promise<void> }).close(); } catch { /* best-effort */ }
      this._browserSession = undefined;
    }

    await this.mcpBridge?.stopLocalServers();
    if (this.latitudeTelemetry) {
      await this.latitudeTelemetry.shutdown().catch((err) => {
        console.warn(
          `[poncho][telemetry] Latitude telemetry shutdown error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
      this.latitudeTelemetry = undefined;
    }
  }

  listTools(): ToolDefinition[] {
    return this.dispatcher.list();
  }

  /**
   * Wraps the run() generator with Latitude telemetry capture for complete trace coverage
   * Streams events in real-time using an event queue pattern
   */
  async *runWithTelemetry(input: RunInput): AsyncGenerator<AgentEvent> {
    const config = this.loadedConfig;
    const telemetry = this.latitudeTelemetry;

    if (telemetry) {
      const latProjectIdEnv2 = config?.telemetry?.latitude?.projectIdEnv ?? "LATITUDE_PROJECT_ID";
      const projectId = parseInt(process.env[latProjectIdEnv2] ?? "", 10) as number;
      const rawPath = config?.telemetry?.latitude?.path ?? this.parsedAgent?.frontmatter.name ?? 'agent';
      // Sanitize path for Latitude's DOCUMENT_PATH_REGEXP: /^([\w-]+\/)*([\w-.])+$/
      const path = rawPath.replace(/[^\w\-./]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'agent';

      const rawConversationId = input.conversationId ?? (
        typeof input.parameters?.__activeConversationId === "string"
          ? input.parameters.__activeConversationId
          : undefined
      );
      // Latitude expects a UUID v4 for documentLogUuid; only pass it if valid
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const conversationUuid = rawConversationId && UUID_RE.test(rawConversationId)
        ? rawConversationId
        : undefined;

      console.info(
        `[poncho][telemetry] Latitude telemetry active – projectId=${projectId}, path="${path}"${conversationUuid ? `, conversation="${conversationUuid}"` : ""}`,
      );

      // Event queue for streaming events in real-time
      const eventQueue: AgentEvent[] = [];
      let queueResolve: ((value: void) => void) | null = null;
      let generatorDone = false;
      let generatorError: Error | null = null;

      // Start the generator inside telemetry.capture() (runs in background)
      const capturePromise = telemetry.capture({ projectId, path, conversationUuid }, async () => {
        this.insideTelemetryCapture = true;
        try {
          for await (const event of this.run(input)) {
            eventQueue.push(event);
            if (queueResolve) {
              const resolve = queueResolve;
              queueResolve = null;
              resolve();
            }
          }
        } catch (error) {
          generatorError = error as Error;
        } finally {
          this.insideTelemetryCapture = false;
          generatorDone = true;
          if (queueResolve) {
            queueResolve();
            queueResolve = null;
          }
        }
      });

      // Yield events from the queue as they arrive
      try {
        while (!generatorDone || eventQueue.length > 0) {
          if (eventQueue.length > 0) {
            yield eventQueue.shift()!;
          } else if (!generatorDone) {
            // Wait for next event
            await new Promise<void>((resolve) => {
              queueResolve = resolve;
            });
          }
        }

        if (generatorError) {
          throw generatorError;
        }
      } finally {
        try {
          await capturePromise;
        } finally {
          try {
            await telemetry.flush();
            console.info("[poncho][telemetry] flush completed");
          } catch (flushErr) {
            console.error("[poncho][telemetry] flush failed:", flushErr);
          }
        }
      }
    } else {
      // No telemetry configured, just pass through
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
    // Start memory fetch early so it overlaps with skill refresh I/O
    const memoryPromise = this.memoryStore
      ? this.memoryStore.getMainMemory()
      : undefined;
    await this.refreshSkillsIfChanged();

    // Track which conversation/owner this run belongs to so browser & subagent tools resolve correctly
    this._currentRunConversationId = input.conversationId;
    const ownerParam = input.parameters?.__ownerId;
    if (typeof ownerParam === "string") {
      this._currentRunOwnerId = ownerParam;
    }

    const agent = this.parsedAgent as ParsedAgent;
    const runId = `run_${randomUUID()}`;
    const start = now();
    const maxSteps = agent.frontmatter.limits?.maxSteps ?? 50;
    const configuredTimeout = agent.frontmatter.limits?.timeout;
    const timeoutMs = this.environment === "development" && configuredTimeout == null
      ? 0 // no hard timeout in development unless explicitly configured
      : (configuredTimeout ?? 300) * 1000;
    const platformMaxDurationSec = Number(process.env.PONCHO_MAX_DURATION) || 0;
    const softDeadlineMs = platformMaxDurationSec > 0
      ? platformMaxDurationSec * 800
      : 0;
    const messages: Message[] = [...(input.messages ?? [])];
    const inputMessageCount = messages.length;
    const events: AgentEvent[] = [];

    const systemPrompt = renderAgentPrompt(agent, {
      parameters: input.parameters,
      runtime: {
        runId,
        agentId: agent.frontmatter.id ?? agent.frontmatter.name,
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
    const promptWithSkills = this.skillContextWindow
      ? `${systemPrompt}${developmentContext}\n\n${this.skillContextWindow}${browserContext}`
      : `${systemPrompt}${developmentContext}${browserContext}`;
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
    const integrityPrompt = `${promptWithSkills}${memoryContext}

## Execution Integrity

- Do not claim that you executed a tool unless you actually emitted a tool call in this run.
- Do not fabricate "Tool Used" or "Tool Result" logs as plain text.
- Never output faux execution transcripts, markdown tool logs, or "Tool Used/Result" sections.
- If no suitable tool is available, explicitly say that and ask for guidance.`;

    const pushEvent = (event: AgentEvent): AgentEvent => {
      events.push(event);
      return event;
    };
    const isCancelled = (): boolean => input.abortSignal?.aborted === true;
    let cancellationEmitted = false;
    const emitCancellation = (): AgentEvent => {
      cancellationEmitted = true;
      return pushEvent({ type: "run:cancelled", runId });
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
    const conversationId = input.conversationId ?? "__default__";
    if (browserSession) {
      browserCleanups.push(
        browserSession.onFrame(conversationId, (frame) => {
          browserEventQueue.push({ type: "browser:frame", data: frame.data, width: frame.width, height: frame.height });
        }),
        browserSession.onStatus(conversationId, (status) => {
          browserEventQueue.push({ type: "browser:status", ...status });
        }),
      );
    }
    const drainBrowserEvents = function* (): Generator<AgentEvent> {
      while (browserEventQueue.length > 0) {
        yield browserEventQueue.shift()!;
      }
    };

    if (input.task != null) {
      if (input.files && input.files.length > 0) {
        const parts: ContentPart[] = [
          { type: "text", text: input.task } satisfies TextContentPart,
        ];
        for (const file of input.files) {
          if (this.uploadStore) {
            const buf = Buffer.from(file.data, "base64");
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
    }

    let responseText = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let transientStepRetryCount = 0;
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
            tokens: { input: totalInputTokens, output: totalOutputTokens, cached: totalCachedTokens },
            duration: now() - start,
            continuation: true,
            maxSteps,
          };
          yield pushEvent({ type: "run:completed", runId, result });
          return;
        }

        const stepStart = now();
        yield pushEvent({ type: "step:started", step });
        yield pushEvent({ type: "model:request", tokens: 0 });

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
              // The rich array already conforms to the AI SDK ToolContent shape
              // (tool-result parts with multi-part content outputs).  Cast
              // through `any` because the exact generic types are internal.
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
                    if (part.data.startsWith(PONCHO_UPLOAD_SCHEME) && this.uploadStore) {
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
                if (part.data.startsWith(PONCHO_UPLOAD_SCHEME) && this.uploadStore) {
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
          console.info(`[poncho] model="${modelName}" provider="${agent.frontmatter.model?.provider ?? "anthropic"}"`);
        }
        const modelInstance = this.modelProvider(modelName);

        // --- Auto-compaction (step 1 only) ---
        // On step 2+ the messages array contains harness-internal formats
        // (JSON-stringified tool_calls / tool results) that must not leak
        // into the conversation store via compactedMessages.
        const compactionConfig = resolveCompactionConfig(agent.frontmatter.compaction);
        if (compactionConfig.enabled && step === 1) {
          const toolDefsJson = JSON.stringify(
            dispatcherTools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          );
          const estimated = estimateTotalTokens(integrityPrompt, messages, toolDefsJson);
          const lastReportedInput = totalInputTokens > 0 ? totalInputTokens : 0;
          const effectiveTokens = Math.max(estimated, lastReportedInput);

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
              // Strip the trailing user task message so runners can use
              // compactedMessages directly as historyMessages without
              // duplicating the user turn they append themselves.
              const emittedMessages = [...compactResult.messages];
              if (emittedMessages.length > 0 && emittedMessages[emittedMessages.length - 1].role === "user") {
                emittedMessages.pop();
              }
              yield pushEvent({
                type: "compaction:completed",
                tokensBefore: effectiveTokens,
                tokensAfter: estimateTotalTokens(integrityPrompt, messages, toolDefsJson),
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
        const cachedMessages = addPromptCacheBreakpoints(coreMessages, modelInstance);

        const telemetryEnabled = this.loadedConfig?.telemetry?.enabled !== false;


        const result = await streamText({
          model: modelInstance,
          system: integrityPrompt,
          messages: cachedMessages,
          tools,
          temperature,
          abortSignal: input.abortSignal,
          ...(typeof maxTokens === "number" ? { maxTokens } : {}),
          experimental_telemetry: {
            isEnabled: telemetryEnabled && !!this.latitudeTelemetry,
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
        const fullStreamIterator = result.fullStream[Symbol.asyncIterator]();
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
                console.error(
                  `[poncho][harness] Stream timeout: model="${modelName}", step=${step}, elapsed=${now() - start}ms`,
                );
                return;
              }
            }
            const remaining = hasRunTimeout ? streamDeadline - now() : Infinity;
            const timeout = chunkCount === 0
              ? Math.min(remaining, FIRST_CHUNK_TIMEOUT_MS)
              : hasRunTimeout ? remaining : 0;
            let nextPart: IteratorResult<(typeof result.fullStream) extends AsyncIterable<infer T> ? T : never> | null;
            if (timeout <= 0 && chunkCount > 0) {
              nextPart = await fullStreamIterator.next();
            } else {
              let timer: ReturnType<typeof setTimeout> | undefined;
              nextPart = await Promise.race([
                fullStreamIterator.next(),
                new Promise<null>((resolve) => {
                  timer = setTimeout(() => resolve(null), timeout);
                }),
              ]);
              clearTimeout(timer);
            }

            if (nextPart === null) {
              const isFirstChunk = chunkCount === 0;
              console.error(
                `[poncho][harness] Stream timeout waiting for ${isFirstChunk ? "first" : "next"} chunk: model="${modelName}", step=${step}, chunks=${chunkCount}, elapsed=${now() - start}ms`,
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

        if (isCancelled()) {
          yield emitCancellation();
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
        console.error(
          `[poncho][harness] Model error: finishReason="error", model="${modelName}", step=${step}`,
        );
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
      const stepCachedTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
      totalInputTokens += usage.inputTokens ?? 0;
      totalOutputTokens += usage.outputTokens ?? 0;
      totalCachedTokens += stepCachedTokens;

      yield pushEvent({
        type: "model:response",
        usage: {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cached: stepCachedTokens,
        },
      });

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
            console.error(
              `[poncho][harness] Empty response: finishReason="${finishReason}", model="${modelName}", step=${step}`,
            );
            return;
          }
          console.warn(
            `[poncho][harness] Model "${modelName}" returned an empty response with finishReason="stop" on step ${step}.`,
          );
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
          },
          duration: now() - start,
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

      // Phase 1: classify all tool calls
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
          metadata: { timestamp: now(), id: randomUUID(), step },
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

      // Phase 2b: no approvals needed — execute all auto-approved calls
      const batchStart = now();
      if (isCancelled()) {
        yield emitCancellation();
        return;
      }

      // Create telemetry tool spans so tool calls appear in Latitude traces
      type ToolSpanHandle = { end: (opts: { result: { value: unknown; isError: boolean } }) => void };
      const toolSpans = new Map<string, ToolSpanHandle>();
      if (this.insideTelemetryCapture && this.latitudeTelemetry) {
        for (const call of approvedCalls) {
          toolSpans.set(
            call.id,
            this.latitudeTelemetry.span.tool({
              name: call.name,
              call: { id: call.id, arguments: call.input },
            }),
          );
        }
      }

      const batchResults =
        approvedCalls.length > 0
          ? await this.dispatcher.executeBatch(approvedCalls, toolContext)
          : [];

      if (isCancelled()) {
        yield emitCancellation();
        return;
      }

      for (const result of batchResults) {
        const span = toolSpans.get(result.callId);
        if (result.error) {
          span?.end({ result: { value: result.error, isError: true } });
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
          richToolResults.push({
            type: "tool-result",
            toolCallId: result.callId,
            toolName: result.tool,
            output: { type: "json", value: { error: result.error } },
          });
        } else {
          span?.end({ result: { value: result.output ?? null, isError: false } });
          const serialized = JSON.stringify(result.output ?? null);
          const outputTokenEstimate = Math.ceil(serialized.length / 4);
          yield pushEvent({
            type: "tool:completed",
            tool: result.tool,
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
        metadata: { timestamp: now(), id: randomUUID(), step },
      });
      const toolMsgMeta: Record<string, unknown> = { timestamp: now(), id: randomUUID(), step, _richToolResults: richToolResults };
      messages.push({
        role: "tool",
        content: JSON.stringify(toolResultsForModel),
        metadata: toolMsgMeta as Message["metadata"],
      });

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
          console.warn(
            `[poncho][harness] Retrying step ${step} after transient model error (attempt ${transientStepRetryCount}/${MAX_TRANSIENT_STEP_RETRIES})${
              typeof statusCode === "number" ? ` status=${statusCode}` : ""
            }: ${error instanceof Error ? error.message : String(error)}`,
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
        console.error(`[poncho][harness] Step ${step} error:`, error);
        return;
      }
    }

    if (softDeadlineMs > 0) {
      const result: RunResult = {
        status: "completed",
        response: responseText,
        steps: maxSteps,
        tokens: { input: totalInputTokens, output: totalOutputTokens, cached: totalCachedTokens },
        duration: now() - start,
        continuation: true,
        maxSteps,
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

    // Drain any remaining browser events and clean up subscriptions
    yield* drainBrowserEvents();
    for (const cleanup of browserCleanups) cleanup();
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
