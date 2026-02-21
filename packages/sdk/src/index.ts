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
    toolActivity?: string[];
    sections?: Array<{ type: "text" | "tools"; content: string | string[] }>;
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

export interface ToolContext {
  runId: string;
  agentId: string;
  step: number;
  workingDir: string;
  parameters: Record<string, unknown>;
  abortSignal?: AbortSignal;
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

export interface FileInput {
  /** base64 data, data: URI, or https:// URL */
  data: string;
  mediaType: string;
  filename?: string;
}

export interface RunInput {
  task: string;
  parameters?: Record<string, unknown>;
  messages?: Message[];
  files?: FileInput[];
  abortSignal?: AbortSignal;
}

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
}

export interface RunResult {
  status: "completed" | "error" | "cancelled";
  response?: string;
  steps: number;
  tokens: TokenUsage;
  duration: number;
  continuation?: boolean;
  maxSteps?: number;
}

export interface AgentFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: "run:started"; runId: string; agentId: string }
  | { type: "run:completed"; runId: string; result: RunResult }
  | { type: "run:cancelled"; runId: string }
  | { type: "run:error"; runId: string; error: AgentFailure }
  | { type: "step:started"; step: number }
  | { type: "step:completed"; step: number; duration: number }
  | { type: "model:request"; tokens: number }
  | { type: "model:chunk"; content: string }
  | { type: "model:response"; usage: TokenUsage }
  | { type: "tool:started"; tool: string; input: unknown }
  | { type: "tool:completed"; tool: string; output: unknown; duration: number }
  | { type: "tool:error"; tool: string; error: string; recoverable: boolean }
  | {
      type: "tool:approval:required";
      tool: string;
      input: unknown;
      approvalId: string;
    }
  | { type: "tool:approval:granted"; approvalId: string }
  | { type: "tool:approval:denied"; approvalId: string; reason?: string };
