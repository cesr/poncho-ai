import type { ModelMessage, LanguageModel } from "ai";

export function isAnthropicModel(model: LanguageModel): boolean {
  if (typeof model === "string") {
    return model.includes("anthropic") || model.includes("claude");
  }
  return (
    model.provider === "anthropic" ||
    model.provider.includes("anthropic") ||
    model.modelId.includes("anthropic") ||
    model.modelId.includes("claude")
  );
}

/**
 * Adds prompt cache breakpoints to messages for providers that require
 * explicit opt-in (Anthropic). For providers with automatic caching
 * (OpenAI), messages are returned unchanged.
 *
 * For Anthropic, marks the target message with ephemeral cache control so
 * the conversation prefix is incrementally cached across steps. When
 * `targetIndex` is omitted, the last message is used (default behavior).
 * Callers that want to cache only a stable prefix (e.g. skipping tool
 * results that will be truncated next turn) can pass an earlier index.
 */
export function addPromptCacheBreakpoints(
  messages: ModelMessage[],
  model: LanguageModel,
  targetIndex?: number,
): ModelMessage[] {
  if (messages.length === 0 || !isAnthropicModel(model)) {
    return messages;
  }

  const index = targetIndex ?? messages.length - 1;
  if (index < 0 || index >= messages.length) {
    return messages;
  }

  const cacheDirective = {
    anthropic: { cacheControl: { type: "ephemeral" as const } },
  };

  return messages.map((message, i) => {
    if (i === index) {
      return {
        ...message,
        providerOptions: {
          ...message.providerOptions,
          ...cacheDirective,
        },
      };
    }
    return message;
  });
}
