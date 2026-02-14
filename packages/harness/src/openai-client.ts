import OpenAI from "openai";
import type { Message } from "@poncho-ai/sdk";
import type {
  ModelCallInput,
  ModelClient,
  ModelClientOptions,
  ModelResponse,
  ModelStreamEvent,
} from "./model-client.js";

type OpenAIMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const toOpenAiMessages = (systemPrompt: string, messages: Message[]): OpenAIMessage[] => {
  const mapped: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "tool") {
      mapped.push({
        role: "user",
        content: `Tool result context: ${message.content}`,
      });
      continue;
    }
    mapped.push({ role: message.role, content: message.content });
  }
  return mapped;
};

export class OpenAiModelClient implements ModelClient {
  private readonly client: OpenAI;
  private readonly latitudeCapture;

  constructor(apiKey?: string, options?: ModelClientOptions) {
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env.OPENAI_API_KEY ?? "missing-openai-key",
    });
    this.latitudeCapture = options?.latitudeCapture;
  }

  async *generateStream(input: ModelCallInput): AsyncGenerator<ModelStreamEvent> {
    const stream = await (this.latitudeCapture?.capture(async () =>
      this.client.chat.completions.create({
        model: input.modelName,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens ?? 1024,
        messages: toOpenAiMessages(input.systemPrompt, input.messages),
        tools: input.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as Record<string, unknown>,
          },
        })),
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
      }),
    ) ??
      this.client.chat.completions.create({
        model: input.modelName,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens ?? 1024,
        messages: toOpenAiMessages(input.systemPrompt, input.messages),
        tools: input.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as Record<string, unknown>,
          },
        })),
        tool_choice: "auto",
        stream: true,
        stream_options: { include_usage: true },
      }));

    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    const toolCallsByIndex = new Map<
      number,
      { id: string; name: string; argumentsJson: string }
    >();

    for await (const chunk of stream) {
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }

      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        yield { type: "chunk", content: delta.content };
      }

      for (const toolCall of delta?.tool_calls ?? []) {
        const index = toolCall.index ?? 0;
        const current = toolCallsByIndex.get(index) ?? {
          id: toolCall.id ?? `tool_call_${index}`,
          name: "",
          argumentsJson: "",
        };

        if (toolCall.id) {
          current.id = toolCall.id;
        }
        if (toolCall.function?.name) {
          current.name = toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          current.argumentsJson += toolCall.function.arguments;
        }

        toolCallsByIndex.set(index, current);
      }
    }

    const toolCalls: ModelResponse["toolCalls"] = Array.from(toolCallsByIndex.values())
      .filter((call) => call.name.length > 0)
      .map((call) => {
        let parsedInput: Record<string, unknown> = {};
        if (call.argumentsJson.trim().length > 0) {
          try {
            parsedInput = JSON.parse(call.argumentsJson) as Record<string, unknown>;
          } catch {
            parsedInput = { raw: call.argumentsJson };
          }
        }
        return {
          id: call.id,
          name: call.name,
          input: parsedInput,
        };
      });

    yield {
      type: "final",
      response: {
        text,
        toolCalls,
        usage: {
          input: inputTokens,
          output: outputTokens,
        },
        rawContent: [],
      },
    };
  }

  async generate(input: ModelCallInput): Promise<ModelResponse> {
    let finalResponse: ModelResponse | undefined;
    for await (const event of this.generateStream(input)) {
      if (event.type === "final") {
        finalResponse = event.response;
      }
    }
    if (!finalResponse) {
      throw new Error("OpenAI response ended without final payload");
    }
    return finalResponse;
  }
}
