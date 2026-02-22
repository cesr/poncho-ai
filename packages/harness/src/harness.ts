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
import { loadPonchoConfig, resolveMemoryConfig, type PonchoConfig } from "./config.js";
import { createDefaultTools, createWriteTool } from "./default-tools.js";
import {
  createMemoryStore,
  createMemoryTools,
  type MemoryStore,
} from "./memory.js";
import { LocalMcpBridge } from "./mcp.js";
import { createModelProvider, type ModelProviderFactory } from "./model-factory.js";
import { buildSkillContextWindow, loadSkillMetadata } from "./skill-context.js";
import { streamText, type ModelMessage } from "ai";
import { jsonSchemaToZod } from "./schema-converter.js";
import type { SkillMetadata } from "./skill-context.js";
import { createSkillTools, normalizeScriptPolicyPath } from "./skill-tools.js";
import { LatitudeTelemetry } from "@latitude-data/telemetry";
import {
  isSiblingScriptsPattern,
  matchesRelativeScriptPattern,
  matchesSlashPattern,
  normalizeRelativeScriptPattern,
} from "./tool-policy.js";
import { ToolDispatcher } from "./tool-dispatcher.js";
import { ensureAgentIdentity } from "./agent-identity.js";

export interface HarnessOptions {
  workingDir?: string;
  environment?: "development" | "staging" | "production";
  toolDefinitions?: ToolDefinition[];
  approvalHandler?: (request: {
    tool: string;
    input: Record<string, unknown>;
    runId: string;
    step: number;
    approvalId: string;
  }) => Promise<boolean> | boolean;
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
const MAX_CONTEXT_MESSAGES = 40;
const FIRST_CHUNK_TIMEOUT_MS = 180_000; // 180s to receive the first chunk from the model
const MAX_TRANSIENT_STEP_RETRIES = 2;
const SKILL_TOOL_NAMES = [
  "activate_skill",
  "deactivate_skill",
  "list_active_skills",
  "read_skill_resource",
  "list_skill_scripts",
  "run_skill_script",
] as const;

const trimMessageWindow = (messages: Message[]): Message[] =>
  messages.length <= MAX_CONTEXT_MESSAGES
    ? messages
    : messages.slice(messages.length - MAX_CONTEXT_MESSAGES);

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
\`\`\`

- Each cron job triggers an autonomous agent run with the specified task, creating a fresh conversation.
- In \`poncho dev\`, jobs run via an in-process scheduler and appear in the web UI sidebar (prefixed with \`[cron]\`).
- For Vercel: \`poncho build vercel\` generates \`vercel.json\` cron entries. Set \`CRON_SECRET\` = \`PONCHO_AUTH_TOKEN\`.
- Jobs can also be triggered manually: \`GET /api/cron/<jobName>\`.
- To carry context across cron runs, enable memory.
- **IMPORTANT**: When adding a new cron job, always PRESERVE all existing cron jobs. Never remove or overwrite existing jobs unless the user explicitly asks you to replace or delete them. Read the full current \`cron:\` block before editing, and append the new job alongside the existing ones.

## Messaging Integrations (Slack, etc.)

Users can connect this agent to messaging platforms so it responds to @mentions.

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
- Preferred MCP config shape in \`poncho.config.js\`:
  \`mcp: [{ name: "linear", url: "https://mcp.linear.app/mcp", auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" } }]\`
- If shell/CLI access exists, you can use \`poncho mcp add --url ... --name ... --auth-bearer-env ...\`, then \`poncho mcp tools list <server>\` and \`poncho mcp tools select <server>\`.
- If shell/CLI access is unavailable, ask the user to run needed commands and provide exact copy-paste commands.
- For setup, skills, MCP, auth, storage, telemetry, or "how do I..." questions, proactively read \`README.md\` with \`read_file\` before answering.
- Prefer quoting concrete commands and examples from \`README.md\` over guessing.
- Keep edits minimal, preserve unrelated settings/code, and summarize what changed.`;

export class AgentHarness {
  private readonly workingDir: string;
  private readonly environment: HarnessOptions["environment"];
  private modelProvider: ModelProviderFactory;
  private readonly modelProviderInjected: boolean;
  private readonly dispatcher = new ToolDispatcher();
  private readonly approvalHandler?: HarnessOptions["approvalHandler"];
  readonly uploadStore?: UploadStore;
  private skillContextWindow = "";
  private memoryStore?: MemoryStore;
  private loadedConfig?: PonchoConfig;
  private loadedSkills: SkillMetadata[] = [];
  private skillFingerprint = "";
  private readonly activeSkillNames = new Set<string>();
  private readonly registeredMcpToolNames = new Set<string>();

  private parsedAgent?: ParsedAgent;
  private mcpBridge?: LocalMcpBridge;

  private getConfiguredToolFlag(
    config: PonchoConfig | undefined,
    name: keyof NonNullable<NonNullable<PonchoConfig["tools"]>["defaults"]>,
  ): boolean | undefined {
    const defaults = config?.tools?.defaults;
    const environment = this.environment ?? "development";
    const envOverrides = config?.tools?.byEnvironment?.[environment];
    return envOverrides?.[name] ?? defaults?.[name];
  }

  private isBuiltInToolEnabled(config: PonchoConfig | undefined, name: string): boolean {
    if (name === "write_file") {
      const allowedByEnvironment = this.shouldEnableWriteTool();
      const configured = this.getConfiguredToolFlag(config, "write_file");
      return allowedByEnvironment && configured !== false;
    }
    if (name === "list_directory") {
      const configured = this.getConfiguredToolFlag(config, "list_directory");
      return configured !== false;
    }
    if (name === "read_file") {
      const configured = this.getConfiguredToolFlag(config, "read_file");
      return configured !== false;
    }
    return true;
  }

  private registerIfMissing(tool: ToolDefinition): void {
    if (!this.dispatcher.get(tool.name)) {
      this.dispatcher.register(tool);
    }
  }

  private registerConfiguredBuiltInTools(config: PonchoConfig | undefined): void {
    for (const tool of createDefaultTools(this.workingDir)) {
      if (this.isBuiltInToolEnabled(config, tool.name)) {
        this.registerIfMissing(tool);
      }
    }
    if (this.isBuiltInToolEnabled(config, "write_file")) {
      this.registerIfMissing(createWriteTool(this.workingDir));
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
    this.approvalHandler = options.approvalHandler;
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

  private async refreshSkillsIfChanged(): Promise<void> {
    if (this.environment !== "development") {
      return;
    }
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
    // Only create modelProvider if one wasn't injected (for production use)
    // Tests can inject a mock modelProvider via constructor options
    if (!this.modelProviderInjected) {
      this.modelProvider = createModelProvider(provider);
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
    await bridge.startLocalServers();
    await bridge.discoverTools();
    await this.refreshMcpTools("initialize");
  }

  async shutdown(): Promise<void> {
    await this.mcpBridge?.stopLocalServers();
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
    const telemetryEnabled = config?.telemetry?.enabled !== false;
    const latitudeApiKey = config?.telemetry?.latitude?.apiKey;
    const rawProjectId = config?.telemetry?.latitude?.projectId;
    const projectId = typeof rawProjectId === 'string' ? parseInt(rawProjectId, 10) : rawProjectId;
    const path = config?.telemetry?.latitude?.path ?? this.parsedAgent?.frontmatter.name ?? 'agent';

    // If Latitude telemetry is configured, wrap the entire run with capture
    if (telemetryEnabled && latitudeApiKey && projectId) {
      const telemetry = new LatitudeTelemetry(latitudeApiKey);

      // Event queue for streaming events in real-time
      const eventQueue: AgentEvent[] = [];
      let queueResolve: ((value: void) => void) | null = null;
      let generatorDone = false;
      let generatorError: Error | null = null;

      // Start the generator inside telemetry.capture() (runs in background)
      const capturePromise = telemetry.capture({ projectId, path }, async () => {
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
        await capturePromise;
      }
    } else {
      // No telemetry configured, just pass through
      yield* this.run(input);
    }
  }

  async *run(input: RunInput): AsyncGenerator<AgentEvent> {
    if (!this.parsedAgent) {
      await this.initialize();
    }
    await this.refreshSkillsIfChanged();

    const agent = this.parsedAgent as ParsedAgent;
    const runId = `run_${randomUUID()}`;
    const start = now();
    const maxSteps = agent.frontmatter.limits?.maxSteps ?? 50;
    const timeoutMs = (agent.frontmatter.limits?.timeout ?? 300) * 1000;
    const platformMaxDurationSec = Number(process.env.PONCHO_MAX_DURATION) || 0;
    const softDeadlineMs = platformMaxDurationSec > 0
      ? platformMaxDurationSec * 800
      : 0;
    const messages: Message[] = [...(input.messages ?? [])];
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
    const promptWithSkills = this.skillContextWindow
      ? `${systemPrompt}${developmentContext}\n\n${this.skillContextWindow}`
      : `${systemPrompt}${developmentContext}`;
    const mainMemory = this.memoryStore
      ? await this.memoryStore.getMainMemory()
      : undefined;
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

    yield pushEvent({
      type: "run:started",
      runId,
      agentId: agent.frontmatter.id ?? agent.frontmatter.name,
    });

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

    let responseText = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let transientStepRetryCount = 0;

    for (let step = 1; step <= maxSteps; step += 1) {
      try {
        if (isCancelled()) {
          yield emitCancellation();
          return;
        }
        if (now() - start > timeoutMs) {
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
            tokens: { input: totalInputTokens, output: totalOutputTokens, cached: 0 },
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
            // Tool messages are provider-sensitive; skip malformed historical records
            // instead of failing the entire run continuation.
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
                  // Parse JSON content for successful results, keep error messages as strings.
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
        const coreMessages: ModelMessage[] = (
          await Promise.all(trimMessageWindow(messages).map(convertMessage))
        ).flat();

        const modelName = agent.frontmatter.model?.name ?? "claude-opus-4-5";
        const temperature = agent.frontmatter.model?.temperature ?? 0.2;
        const maxTokens = agent.frontmatter.model?.maxTokens;

        // Stream response using Vercel AI SDK with telemetry enabled
        const telemetryEnabled = this.loadedConfig?.telemetry?.enabled !== false;
        const latitudeApiKey = this.loadedConfig?.telemetry?.latitude?.apiKey;

        const result = await streamText({
          model: this.modelProvider(modelName),
          system: integrityPrompt,
          messages: coreMessages,
          tools,
          temperature,
          abortSignal: input.abortSignal,
          ...(typeof maxTokens === "number" ? { maxTokens } : {}),
          experimental_telemetry: {
            isEnabled: telemetryEnabled && !!latitudeApiKey,
          },
        });
        // Stream text chunks — enforce overall run timeout per chunk.
        // The top-of-step timeout check cannot fire while we are
        // blocked inside the textStream async iterator, so we race
        // each next() call against the remaining time budget.
        let fullText = "";
        let chunkCount = 0;
        const streamDeadline = start + timeoutMs;
        const textIterator = result.textStream[Symbol.asyncIterator]();
        try {
          while (true) {
            if (isCancelled()) {
              yield emitCancellation();
              return;
            }
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
            // Use a shorter timeout for the first chunk to detect
            // non-responsive models quickly instead of waiting minutes.
            const timeout = chunkCount === 0
              ? Math.min(remaining, FIRST_CHUNK_TIMEOUT_MS)
              : remaining;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const nextChunk = await Promise.race([
              textIterator.next(),
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), timeout);
              }),
            ]);
            clearTimeout(timer);

            if (nextChunk === null) {
              const isFirstChunk = chunkCount === 0;
              const errorMessage = isFirstChunk
                ? `Model "${modelName}" did not respond within ${Math.floor(FIRST_CHUNK_TIMEOUT_MS / 1000)}s. The model may not be supported by the current provider SDK, or the API is unreachable. Check that the model name is correct and that your provider SDK is up to date.`
                : `Model "${modelName}" stopped responding during streaming (run timeout ${Math.floor(timeoutMs / 1000)}s exceeded).`;
              yield pushEvent({
                type: "run:error",
                runId,
                error: {
                  code: isFirstChunk ? "MODEL_TIMEOUT" : "TIMEOUT",
                  message: errorMessage,
                },
              });
              console.error(
                `[poncho][harness] Stream timeout waiting for ${isFirstChunk ? "first" : "next"} chunk: model="${modelName}", step=${step}, chunks=${chunkCount}, elapsed=${now() - start}ms`,
              );
              return;
            }

            if (nextChunk.done) break;
            chunkCount += 1;
            fullText += nextChunk.value;
            yield pushEvent({ type: "model:chunk", content: nextChunk.value });
          }
        } finally {
          // Best-effort cleanup of the underlying stream/connection.
          textIterator.return?.(undefined)?.catch?.(() => {});
        }

        if (isCancelled()) {
          yield emitCancellation();
          return;
        }

      // Check finish reason for error / abnormal completions.
      // textStream silently swallows model-level errors – they only
      // surface through finishReason (or fullStream, which we don't use).
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
      totalInputTokens += usage.inputTokens ?? 0;
      totalOutputTokens += usage.outputTokens ?? 0;

      yield pushEvent({
        type: "model:response",
        usage: {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cached: 0,
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
            cached: 0,
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
      };

      const toolResultsForModel: Array<{
        type: "tool_result";
        tool_use_id: string;
        tool_name: string;
        content: string;
      }> = [];

      const approvedCalls: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];

      for (const call of toolCalls) {
        if (isCancelled()) {
          yield emitCancellation();
          return;
        }
        const runtimeToolName = exposedToolNames.get(call.name) ?? call.name;
        yield pushEvent({ type: "tool:started", tool: runtimeToolName, input: call.input });
        const requiresApproval = this.requiresApprovalForToolCall(
          runtimeToolName,
          call.input,
        );
        if (requiresApproval) {
          const approvalId = `approval_${randomUUID()}`;
          yield pushEvent({
            type: "tool:approval:required",
            tool: runtimeToolName,
            input: call.input,
            approvalId,
          });
          const approved = this.approvalHandler
            ? await this.approvalHandler({
                tool: runtimeToolName,
                input: call.input,
                runId,
                step,
                approvalId,
              })
            : false;
          if (isCancelled()) {
            yield emitCancellation();
            return;
          }
          if (!approved) {
            yield pushEvent({
              type: "tool:approval:denied",
              approvalId,
              reason: "No approval handler granted execution",
            });
            yield pushEvent({
              type: "tool:error",
              tool: call.name,
              error: "Tool execution denied by approval policy",
              recoverable: true,
            });
            toolResultsForModel.push({
              type: "tool_result",
              tool_use_id: call.id,
              tool_name: runtimeToolName,
              content: "Tool error: Tool execution denied by approval policy",
            });
            continue;
          }
          yield pushEvent({ type: "tool:approval:granted", approvalId });
        }
        approvedCalls.push({
          id: call.id,
          name: runtimeToolName,
          input: call.input,
        });
      }
      const batchStart = now();
      if (isCancelled()) {
        yield emitCancellation();
        return;
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
        if (result.error) {
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
        } else {
          yield pushEvent({
            type: "tool:completed",
            tool: result.tool,
            output: result.output,
            duration: now() - batchStart,
          });
          toolResultsForModel.push({
            type: "tool_result",
            tool_use_id: result.callId,
            tool_name: result.tool,
            content: JSON.stringify(result.output ?? null),
          });
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
      messages.push({
        role: "tool",
        content: JSON.stringify(toolResultsForModel),
        metadata: { timestamp: now(), id: randomUUID(), step },
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
        tokens: { input: totalInputTokens, output: totalOutputTokens, cached: 0 },
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
  }

  async runToCompletion(input: RunInput): Promise<HarnessRunOutput> {
    const events: AgentEvent[] = [];
    let runId = "";
    let finalResult: RunResult | undefined;
    const messages: Message[] = [...(input.messages ?? [])];
    messages.push({ role: "user", content: input.task });

    for await (const event of this.run(input)) {
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
