import type { ModelMessage, LanguageModel } from "ai";

function isAnthropicModel(model: LanguageModel): boolean {
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
 * For Anthropic, marks the last message with ephemeral cache control so the
 * conversation prefix is incrementally cached across steps.
 */
export function addPromptCacheBreakpoints(
  messages: ModelMessage[],
  model: LanguageModel,
): ModelMessage[] {
  if (messages.length === 0 || !isAnthropicModel(model)) {
    return messages;
  }

  const cacheDirective = {
    anthropic: { cacheControl: { type: "ephemeral" as const } },
  };

  return messages.map((message, index) => {
    if (index === messages.length - 1) {
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
