import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  Message,
  RunInput,
  RunResult,
  ToolContext,
  ToolDefinition,
} from "@poncho-ai/sdk";
import { parseAgentFile, renderAgentPrompt, type ParsedAgent } from "./agent-parser.js";
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
import { streamText, type CoreMessage } from "ai";
import { jsonSchemaToZod } from "./schema-converter.js";
import type { SkillMetadata } from "./skill-context.js";
import { createSkillTools } from "./skill-tools.js";
import {
  applyToolPolicy,
  matchesSlashPattern,
  mergePolicyForEnvironment,
  type RuntimeEnvironment,
  validateScriptPattern,
} from "./tool-policy.js";
import { ToolDispatcher } from "./tool-dispatcher.js";

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
}

export interface HarnessRunOutput {
  runId: string;
  result: RunResult;
  events: AgentEvent[];
  messages: Message[];
}

const now = (): number => Date.now();
const MAX_CONTEXT_MESSAGES = 40;

const trimMessageWindow = (messages: Message[]): Message[] =>
  messages.length <= MAX_CONTEXT_MESSAGES
    ? messages
    : messages.slice(messages.length - MAX_CONTEXT_MESSAGES);

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

## When users ask about customization:

- Explain and edit \`poncho.config.js\` for model/provider, storage+memory, auth, telemetry, and MCP settings.
- Help create or update local skills under \`skills/<skill-name>/SKILL.md\`.
- For executable skills, add JavaScript/TypeScript scripts under \`skills/<skill-name>/scripts/\` and run them via \`run_skill_script\`.
- For MCP setup, default to direct \`poncho.config.js\` edits (\`mcp\` entries with URL, bearer token env, and tool policy).
- Keep MCP server connection details in \`poncho.config.js\` only (name/url/auth/tools policy). Do not move server definitions into \`SKILL.md\`.
- In \`AGENT.md\`/\`SKILL.md\`, declare MCP intent only as \`tools.mcp\` string patterns (for example \`linear/*\` or \`linear/list_issues\`).
- Never use nested MCP objects in skill frontmatter (for example \`mcp: [{ name, url, auth }]\`) and never use underscore/colon tool patterns.
- To scope tools to a skill: keep server config in \`poncho.config.js\`, add desired \`tools.mcp\` patterns in that skill's \`SKILL.md\`, and remove global \`AGENT.md tools.mcp\` fallback if you do not want global availability.
- Do not invent unsupported top-level config keys (for example \`model\` in \`poncho.config.js\`). Keep existing config structure unless README/spec explicitly says otherwise.
- In \`poncho.config.js\`, MCP tool allowlist patterns must be slash-based (for example \`linear/list_initiatives\` or \`linear/*\`), not underscored names like \`linear_list_initiatives\`.
- Keep \`poncho.config.js\` valid JavaScript and preserve existing imports/types/comments. If there is a JSDoc type import, do not rewrite it to a different package name.
- Preferred MCP config shape in \`poncho.config.js\`:
  \`mcp: [{ name: "linear", url: "https://mcp.linear.app/mcp", auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" }, tools: { mode: "allowlist", include: ["linear/*"] } }]\`
- If shell/CLI access exists, you can use \`poncho mcp add --url ... --name ... --auth-bearer-env ...\`, then \`poncho mcp tools list <server>\` and \`poncho mcp tools select <server>\`.
- If shell/CLI access is unavailable, ask the user to run needed commands and provide exact copy-paste commands.
- Use strict slash patterns for MCP tool selections (\`server/tool\`, \`server/*\`) and verify by inspecting config/tool state.
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
  private skillContextWindow = "";
  private memoryStore?: MemoryStore;
  private loadedConfig?: PonchoConfig;
  private loadedSkills: SkillMetadata[] = [];
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

    if (options.toolDefinitions?.length) {
      this.dispatcher.registerMany(options.toolDefinitions);
    }
  }

  private runtimeEnvironment(): RuntimeEnvironment {
    return this.environment ?? "development";
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
    const skillPatterns = new Set<string>();
    for (const skillName of this.activeSkillNames) {
      const skill = this.loadedSkills.find((entry) => entry.name === skillName);
      if (!skill) {
        continue;
      }
      for (const pattern of skill.allowedTools.scripts) {
        skillPatterns.add(pattern);
      }
    }
    if (skillPatterns.size > 0) {
      return [...skillPatterns];
    }
    return this.getAgentScriptIntent();
  }

  private isScriptAllowedByPolicy(skill: string, scriptPath: string): boolean {
    const identifier = `${skill}/${scriptPath}`;
    const intentPatterns = this.getRequestedScriptPatterns();
    const matchedIntent =
      intentPatterns.length === 0
        ? true
        : intentPatterns.some((pattern) => matchesSlashPattern(identifier, pattern));
    if (!matchedIntent) {
      return false;
    }
    const policy = mergePolicyForEnvironment(
      this.loadedConfig?.scripts,
      this.runtimeEnvironment(),
    );
    const decision = applyToolPolicy([identifier], policy);
    return decision.allowed.length > 0;
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
    const tools = await this.mcpBridge.loadTools(
      requestedPatterns,
      this.runtimeEnvironment(),
    );
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

  private validateScriptPolicyConfig(config: PonchoConfig | undefined): void {
    const check = (values: string[] | undefined, path: string): void => {
      for (const [index, value] of (values ?? []).entries()) {
        validateScriptPattern(value, `${path}[${index}]`);
      }
    };
    check(config?.scripts?.include, "poncho.config.js scripts.include");
    check(config?.scripts?.exclude, "poncho.config.js scripts.exclude");
    check(
      config?.scripts?.byEnvironment?.development?.include,
      "poncho.config.js scripts.byEnvironment.development.include",
    );
    check(
      config?.scripts?.byEnvironment?.development?.exclude,
      "poncho.config.js scripts.byEnvironment.development.exclude",
    );
    check(
      config?.scripts?.byEnvironment?.staging?.include,
      "poncho.config.js scripts.byEnvironment.staging.include",
    );
    check(
      config?.scripts?.byEnvironment?.staging?.exclude,
      "poncho.config.js scripts.byEnvironment.staging.exclude",
    );
    check(
      config?.scripts?.byEnvironment?.production?.include,
      "poncho.config.js scripts.byEnvironment.production.include",
    );
    check(
      config?.scripts?.byEnvironment?.production?.exclude,
      "poncho.config.js scripts.byEnvironment.production.exclude",
    );
  }

  async initialize(): Promise<void> {
    this.parsedAgent = await parseAgentFile(this.workingDir);
    const config = await loadPonchoConfig(this.workingDir);
    this.validateScriptPolicyConfig(config);
    this.loadedConfig = config;
    this.registerConfiguredBuiltInTools(config);
    const provider = this.parsedAgent.frontmatter.model?.provider ?? "anthropic";
    const memoryConfig = resolveMemoryConfig(config);
    // TODO: Integrate Latitude telemetry with Vercel AI SDK
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
      }),
    );
    if (memoryConfig?.enabled) {
      this.memoryStore = createMemoryStore(
        this.parsedAgent.frontmatter.name,
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

  async *run(input: RunInput): AsyncGenerator<AgentEvent> {
    if (!this.parsedAgent) {
      await this.initialize();
    }

    const agent = this.parsedAgent as ParsedAgent;
    const runId = `run_${randomUUID()}`;
    const start = now();
    const maxSteps = agent.frontmatter.limits?.maxSteps ?? 50;
    const timeoutMs = (agent.frontmatter.limits?.timeout ?? 300) * 1000;
    const messages: Message[] = [...(input.messages ?? [])];
    const events: AgentEvent[] = [];

    const systemPrompt = renderAgentPrompt(agent, {
      parameters: input.parameters,
      runtime: {
        runId,
        agentId: agent.frontmatter.name,
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

    yield pushEvent({
      type: "run:started",
      runId,
      agentId: agent.frontmatter.name,
    });

    messages.push({
      role: "user",
      content: input.task,
      metadata: { timestamp: now(), id: randomUUID() },
    });

    let responseText = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let step = 1; step <= maxSteps; step += 1) {
      try {
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
      const tools: Record<string, { description: string; parameters: any }> = {};
      for (const tool of modelTools) {
        tools[tool.name] = {
          description: tool.description,
          parameters: jsonSchemaToZod(tool.inputSchema),
        };
      }

        // Convert messages to CoreMessage format
        const coreMessages: CoreMessage[] = trimMessageWindow(messages).map((msg) => {
          if (msg.role === "tool") {
            // Tool messages need special handling - parse and transform to Vercel AI SDK format
            const toolResults: Array<{
              type: "tool_result";
              tool_use_id: string;
              tool_name: string;
              content: string;
            }> = JSON.parse(msg.content);

            return {
              role: "tool" as const,
              content: toolResults.map((tr) => {
                // Parse JSON content for successful results, keep error messages as strings
                let result: unknown;
                if (tr.content.startsWith("Tool error:")) {
                  result = tr.content;
                } else {
                  try {
                    result = JSON.parse(tr.content);
                  } catch {
                    result = tr.content;
                  }
                }
                return {
                  type: "tool-result" as const,
                  toolCallId: tr.tool_use_id,
                  toolName: tr.tool_name,
                  result,
                };
              }),
            };
          }

          if (msg.role === "assistant") {
            // Check if this assistant message has tool calls
            try {
              const parsed = JSON.parse(msg.content);
              if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
                // Assistant message with tool calls
                return {
                  role: "assistant" as const,
                  content: [
                    ...(parsed.text ? [{ type: "text" as const, text: parsed.text }] : []),
                    ...parsed.tool_calls.map((tc: any) => ({
                      type: "tool-call" as const,
                      toolCallId: tc.id,
                      toolName: tc.name,
                      args: tc.input,
                    })),
                  ],
                };
              }
            } catch {
              // Not JSON, treat as regular text
            }
          }

          return {
            role: msg.role as "user" | "assistant" | "system",
            content: msg.content,
          };
        });

        const modelName = agent.frontmatter.model?.name ?? "claude-opus-4-5";
        const temperature = agent.frontmatter.model?.temperature ?? 0.2;
        const maxTokens = agent.frontmatter.model?.maxTokens ?? 1024;

        // Stream response using Vercel AI SDK
        const result = await streamText({
        model: this.modelProvider(modelName),
        system: integrityPrompt,
        messages: coreMessages,
        tools,
        temperature,
        maxTokens,
        });

        // Stream text chunks
        let streamedAnyChunk = false;
        let fullText = "";
        for await (const chunk of result.textStream) {
        streamedAnyChunk = true;
        fullText += chunk;
        yield pushEvent({ type: "model:chunk", content: chunk });
      }

      // Get full response with usage and tool calls
      const fullResult = await result.response;
      const usage = await result.usage;
      const toolCallsResult = await result.toolCalls;

      // Update token usage
      totalInputTokens += usage.promptTokens;
      totalOutputTokens += usage.completionTokens;

      yield pushEvent({
        type: "model:response",
        usage: {
          input: usage.promptTokens,
          output: usage.completionTokens,
          cached: 0,
        },
      });

      // Extract tool calls
      const toolCalls = toolCallsResult.map((tc) => ({
        id: tc.toolCallId,
        name: tc.toolName,
        input: tc.args as Record<string, unknown>,
      }));

      if (toolCalls.length === 0) {
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
        agentId: agent.frontmatter.name,
        step,
        workingDir: this.workingDir,
        parameters: input.parameters ?? {},
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
        const runtimeToolName = exposedToolNames.get(call.name) ?? call.name;
        yield pushEvent({ type: "tool:started", tool: runtimeToolName, input: call.input });
        const definition = this.dispatcher.get(runtimeToolName);
        if (definition?.requiresApproval) {
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
      const batchResults =
        approvedCalls.length > 0
          ? await this.dispatcher.executeBatch(approvedCalls, toolContext)
          : [];

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
      } catch (error) {
        yield pushEvent({
          type: "run:error",
          runId,
          error: {
            code: "STEP_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        console.error(`[poncho][harness] Step ${step} error:`, error);
        return;
      }
    }

    yield {
      type: "run:error",
      runId,
      error: {
        code: "MAX_STEPS_EXCEEDED",
        message: `Run reached maximum of ${maxSteps} steps`,
      },
    };
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
