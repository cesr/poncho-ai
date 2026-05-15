export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface FileContentPart {
  type: "file";
  /** base64 data, data: URI, https:// URL, or poncho-upload:// reference */
  data: string;
  mediaType: string;
  filename?: string;
}

export type ContentPart = TextContentPart | FileContentPart;

export interface Message {
  role: Role;
  content: string | ContentPart[];
  metadata?: {
    id?: string;
    timestamp?: number;
    tokenCount?: number;
    step?: number;
    runId?: string;
    toolActivity?: string[];
    sections?: Array<{ type: "text" | "tools"; content: string | string[] }>;
    isCompactionSummary?: boolean;
  };
}

/** Extract the text content from a message, regardless of content format. */
export const getTextContent = (message: Message): string => {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((p): p is TextContentPart => p.type === "text")
    .map((p) => p.text)
    .join("");
};

/** Virtual filesystem scoped to the current tenant. Available when VFS is enabled. */
export interface VfsAccess {
  readFile(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  writeFile(path: string, content: Uint8Array, mimeType?: string): Promise<void>;
  writeText(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{
    size: number;
    isDirectory: boolean;
    mimeType?: string;
    updatedAt: number;
  }>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface ToolContext {
  runId: string;
  agentId: string;
  step: number;
  workingDir: string;
  parameters: Record<string, unknown>;
  abortSignal?: AbortSignal;
  conversationId?: string;
  /** The tenant ID when running in multi-tenant mode. */
  tenantId?: string;
  /** Virtual filesystem scoped to the current tenant. Available when VFS is enabled. */
  vfs?: VfsAccess;
}

export type ToolHandler<TInput extends Record<string, unknown>, TOutput> = (
  input: TInput,
  context: ToolContext,
) => Promise<TOutput> | TOutput;

export interface ToolDefinition<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown,
> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  timeout?: number;
  retries?: number;
  isolated?: boolean;
  handler: ToolHandler<TInput, TOutput>;
}

export const defineTool = <
  TInput extends Record<string, unknown>,
  TOutput = unknown,
>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> => definition;

export * from "./config-registry.js";
export * from "./api-types.js";

export interface FileInput {
  /** base64 data, data: URI, or https:// URL */
  data: string;
  mediaType: string;
  filename?: string;
}

export interface RunInput {
  task?: string;
  parameters?: Record<string, unknown>;
  messages?: Message[];
  files?: FileInput[];
  abortSignal?: AbortSignal;
  /** When set, Latitude telemetry groups all turns in this conversation under a single trace. */
  conversationId?: string;
  /** When true, ignores PONCHO_MAX_DURATION soft deadline (used for background subagent runs). */
  disableSoftDeadline?: boolean;
  /** Scope this run to a specific tenant. */
  tenantId?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  cacheWrite?: number;
}

export interface RunResult {
  status: "completed" | "error" | "cancelled";
  response?: string;
  steps: number;
  tokens: TokenUsage;
  duration: number;
  continuation?: boolean;
  /** Full structured message chain from the harness run, including tool-call
   *  and tool-result messages. Always populated on completion so callers can
   *  persist the chain for accurate multi-turn context. */
  continuationMessages?: Message[];
  maxSteps?: number;
  /** Estimated current context usage in tokens at end of run (last model input + tool output estimates, reset on compaction). */
  contextTokens?: number;
  /** Model context window size in tokens. */
  contextWindow?: number;
}

export interface AgentFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: "run:started"; runId: string; agentId: string; contextWindow?: number }
  | { type: "run:completed"; runId: string; result: RunResult; pendingSubagents?: boolean }
  | { type: "run:cancelled"; runId: string; messages?: Message[] }
  | { type: "run:error"; runId: string; error: AgentFailure }
  | { type: "step:started"; step: number }
  | { type: "step:completed"; step: number; duration: number }
  | { type: "model:request"; tokens: number }
  | { type: "model:chunk"; content: string }
  | { type: "model:response"; usage: TokenUsage }
  | { type: "tool:generating"; tool: string; toolCallId: string }
  | { type: "tool:started"; tool: string; input: unknown }
  | { type: "tool:completed"; tool: string; input?: unknown; output: unknown; duration: number; outputTokenEstimate?: number }
  | { type: "tool:error"; tool: string; error: string; recoverable: boolean }
  | {
      type: "tool:approval:required";
      tool: string;
      input: unknown;
      approvalId: string;
    }
  | { type: "tool:approval:granted"; approvalId: string }
  | { type: "tool:approval:denied"; approvalId: string; reason?: string }
  | {
      type: "tool:approval:checkpoint";
      approvals: Array<{
        approvalId: string;
        tool: string;
        toolCallId: string;
        input: Record<string, unknown>;
      }>;
      checkpointMessages: Message[];
      pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    }
  | {
      /**
       * Tool wants to execute on a connected client device (e.g. iOS).
       * The consumer of the harness is responsible for routing this event
       * to the appropriate WebSocket and POSTing the tool's result back via
       * `resumeRunFromCheckpoint`. Carries the same envelope as the
       * approval-required event; `requestId` plays the role of `approvalId`.
       */
      type: "tool:device:required";
      tool: string;
      input: unknown;
      requestId: string;
    }
  | {
      type: "tool:device:checkpoint";
      approvals: Array<{
        approvalId: string;
        tool: string;
        toolCallId: string;
        input: Record<string, unknown>;
      }>;
      checkpointMessages: Message[];
      pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    }
  | { type: "browser:frame"; data: string; width: number; height: number }
  | {
      type: "browser:status";
      active: boolean;
      url?: string;
      interactionAllowed: boolean;
    }
  | { type: "subagent:spawned"; subagentId: string; conversationId: string; task: string }
  | { type: "subagent:completed"; subagentId: string; conversationId: string }
  | { type: "subagent:error"; subagentId: string; conversationId: string; error: string }
  | { type: "subagent:stopped"; subagentId: string; conversationId: string }
  | {
      type: "subagent:approval_needed";
      subagentId: string;
      conversationId: string;
      tool: string;
      approvalId: string;
      input?: Record<string, unknown>;
    }
  | { type: "compaction:started"; estimatedTokens: number }
  | {
      type: "compaction:completed";
      tokensBefore: number;
      tokensAfter: number;
      messagesBefore: number;
      messagesAfter: number;
      compactedMessages?: Message[];
    }
  | { type: "subagents:pending" }
  | { type: "compaction:warning"; reason: string };

export {
  createLogger,
  setLogLevel,
  formatError,
  url,
  muted,
  num,
  type Logger,
} from "./logger.js";
