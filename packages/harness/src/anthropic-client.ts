import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { Message } from "@agentl/sdk";
import type {
  ModelCallInput,
  ModelClient,
  ModelClientOptions,
  ModelResponse,
  ModelStreamEvent,
} from "./model-client.js";

const toAnthropicMessages = (messages: Message[]): MessageParam[] =>
  messages.flatMap((message) => {
    if (message.role === "system") {
      return [];
    }
    if (message.role === "tool") {
      return [{ role: "user", content: message.content }];
    }
    return [{ role: message.role, content: message.content }];
  });

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly latitudeCapture;

  constructor(apiKey?: string, options?: ModelClientOptions) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    this.latitudeCapture = options?.latitudeCapture;
  }

  async *generateStream(input: ModelCallInput): AsyncGenerator<ModelStreamEvent> {
    let stream;
    try {
      stream = await (this.latitudeCapture?.capture(async () =>
        this.client.messages.stream({
          model: input.modelName,
          max_tokens: input.maxTokens ?? 1024,
          temperature: input.temperature ?? 0.2,
          system: input.systemPrompt,
          messages: toAnthropicMessages(input.messages),
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }),
      ) ??
        this.client.messages.stream({
          model: input.modelName,
          max_tokens: input.maxTokens ?? 1024,
          temperature: input.temperature ?? 0.2,
          system: input.systemPrompt,
          messages: toAnthropicMessages(input.messages),
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }));
    } catch (error) {
      const maybeStatus = (error as { status?: number }).status;
      if (maybeStatus === 404) {
        throw new Error(
          `Anthropic model not found: ${input.modelName}. Update AGENT.md frontmatter model.name to a valid model (for example: claude-sonnet-4-20250514).`,
        );
      }
      throw error;
    }

    let text = "";
    for await (const event of stream as AsyncIterable<{
      type: string;
      delta?: { type?: string; text?: string };
    }>) {
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        typeof event.delta.text === "string" &&
        event.delta.text.length > 0
      ) {
        text += event.delta.text;
        yield { type: "chunk", content: event.delta.text };
      }
    }

    const response = await (
      stream as { finalMessage: () => Promise<Anthropic.Messages.Message> }
    ).finalMessage();
    const toolCalls: ModelResponse["toolCalls"] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        if (text.length === 0 && block.text) {
          text = block.text;
        }
      }
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    yield {
      type: "final",
      response: {
        text,
        toolCalls,
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
        rawContent: response.content as unknown[],
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
      throw new Error("Anthropic response ended without final payload");
    }
    return finalResponse;
  }
}
