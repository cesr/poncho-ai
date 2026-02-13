import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  Message,
  RunInput,
  RunResult,
  ToolContext,
  ToolDefinition,
} from "@agentl/sdk";
import { parseAgentFile, renderAgentPrompt, type ParsedAgent } from "./agent-parser.js";
import { loadAgentlConfig, resolveMemoryConfig } from "./config.js";
import { createDefaultTools, createWriteTool } from "./default-tools.js";
import { LatitudeCapture } from "./latitude-capture.js";
import { loadLocalSkillTools } from "./local-tools.js";
import {
  createMemoryStore,
  createMemoryTools,
  type MemoryStore,
} from "./memory.js";
import { LocalMcpBridge } from "./mcp.js";
import type { ModelClient, ModelResponse } from "./model-client.js";
import { createModelClient } from "./model-factory.js";
import { buildSkillContextWindow, loadSkillMetadata } from "./skill-context.js";
import { createSkillTools } from "./skill-tools.js";
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

export class AgentHarness {
  private readonly workingDir: string;
  private readonly environment: HarnessOptions["environment"];
  private modelClient: ModelClient;
  private readonly dispatcher = new ToolDispatcher();
  private readonly approvalHandler?: HarnessOptions["approvalHandler"];
  private skillContextWindow = "";
  private memoryStore?: MemoryStore;

  private parsedAgent?: ParsedAgent;
  private mcpBridge?: LocalMcpBridge;

  private shouldEnableWriteTool(): boolean {
    const override = process.env.AGENTL_FS_WRITE?.toLowerCase();
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
    this.modelClient = createModelClient("anthropic");
    this.approvalHandler = options.approvalHandler;
    this.dispatcher.registerMany(createDefaultTools(this.workingDir));
    if (this.shouldEnableWriteTool()) {
      this.dispatcher.register(createWriteTool(this.workingDir));
    }

    if (options.toolDefinitions?.length) {
      this.dispatcher.registerMany(options.toolDefinitions);
    }
  }

  async initialize(): Promise<void> {
    this.parsedAgent = await parseAgentFile(this.workingDir);
    const config = await loadAgentlConfig(this.workingDir);
    const provider = this.parsedAgent.frontmatter.model?.provider ?? "anthropic";
    const memoryConfig = resolveMemoryConfig(config);
    const latitudeCapture = new LatitudeCapture({
      apiKey:
        config?.telemetry?.latitude?.apiKey ?? process.env.LATITUDE_API_KEY,
      projectId:
        config?.telemetry?.latitude?.projectId ??
        process.env.LATITUDE_PROJECT_ID,
      path:
        config?.telemetry?.latitude?.path ??
        config?.telemetry?.latitude?.documentPath ??
        process.env.LATITUDE_PATH ??
        process.env.LATITUDE_DOCUMENT_PATH,
      defaultPath: `agents/${this.parsedAgent.frontmatter.name}/model-call`,
    });
    this.modelClient = createModelClient(provider, { latitudeCapture });
    const bridge = new LocalMcpBridge(config);
    this.mcpBridge = bridge;
    const extraSkillPaths = config?.skillPaths;
    const skillMetadata = await loadSkillMetadata(this.workingDir, extraSkillPaths);
    this.skillContextWindow = buildSkillContextWindow(skillMetadata);
    this.dispatcher.registerMany(createSkillTools(skillMetadata));
    this.dispatcher.registerMany(await loadLocalSkillTools(this.workingDir, extraSkillPaths));
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
    this.dispatcher.registerMany(await bridge.loadTools());
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
    const promptWithSkills = this.skillContextWindow
      ? `${systemPrompt}\n\n${this.skillContextWindow}`
      : systemPrompt;
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

      const modelCallInput = {
        modelName: agent.frontmatter.model?.name ?? "claude-opus-4-5",
        temperature: agent.frontmatter.model?.temperature,
        maxTokens: agent.frontmatter.model?.maxTokens,
        systemPrompt: integrityPrompt,
        messages: trimMessageWindow(messages),
        tools: this.dispatcher.list(),
      };
      let modelResponse: ModelResponse | undefined;
      let streamedAnyChunk = false;

      if (this.modelClient.generateStream) {
        for await (const streamEvent of this.modelClient.generateStream(modelCallInput)) {
          if (streamEvent.type === "chunk" && streamEvent.content.length > 0) {
            streamedAnyChunk = true;
            yield pushEvent({ type: "model:chunk", content: streamEvent.content });
          }
          if (streamEvent.type === "final") {
            modelResponse = streamEvent.response;
          }
        }
      } else {
        modelResponse = await this.modelClient.generate(modelCallInput);
      }

      if (!modelResponse) {
        throw new Error("Model response ended without final payload");
      }

      totalInputTokens += modelResponse.usage.input;
      totalOutputTokens += modelResponse.usage.output;

      if (!streamedAnyChunk && modelResponse.text) {
        yield pushEvent({ type: "model:chunk", content: modelResponse.text });
      }
      yield pushEvent({
        type: "model:response",
        usage: {
          input: modelResponse.usage.input,
          output: modelResponse.usage.output,
          cached: 0,
        },
      });

      if (modelResponse.toolCalls.length === 0) {
        responseText = modelResponse.text;
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
        content: string;
      }> = [];

      const approvedCalls: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];

      for (const call of modelResponse.toolCalls) {
        yield pushEvent({ type: "tool:started", tool: call.name, input: call.input });
        const definition = this.dispatcher.get(call.name);
        if (definition?.requiresApproval) {
          const approvalId = `approval_${randomUUID()}`;
          yield pushEvent({
            type: "tool:approval:required",
            tool: call.name,
            input: call.input,
            approvalId,
          });
          const approved = this.approvalHandler
            ? await this.approvalHandler({
                tool: call.name,
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
              content: "Tool error: Tool execution denied by approval policy",
            });
            continue;
          }
          yield pushEvent({ type: "tool:approval:granted", approvalId });
        }
        approvedCalls.push({
          id: call.id,
          name: call.name,
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
            content: JSON.stringify(result.output ?? null),
          });
        }
      }

      messages.push({
        role: "assistant",
        content: modelResponse.text || `[tool calls: ${modelResponse.toolCalls.length}]`,
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
