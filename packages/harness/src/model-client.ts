import type { Message, ToolDefinition } from "@poncho-ai/sdk";
import type { LatitudeCapture } from "./latitude-capture.js";

export interface ModelResponse {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  usage: {
    input: number;
    output: number;
  };
  rawContent: unknown[];
}

export interface ModelCallInput {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
  modelName: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelClientOptions {
  latitudeCapture?: LatitudeCapture;
}

export type ModelStreamEvent =
  | {
      type: "chunk";
      content: string;
    }
  | {
      type: "final";
      response: ModelResponse;
    };

export interface ModelClient {
  generate(input: ModelCallInput): Promise<ModelResponse>;
  generateStream?(input: ModelCallInput): AsyncGenerator<ModelStreamEvent>;
}
