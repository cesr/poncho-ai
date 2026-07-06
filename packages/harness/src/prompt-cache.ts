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
 * For Anthropic, marks the target message(s) with ephemeral cache control
 * so the conversation prefix is incrementally cached across steps. When
 * `target` is omitted, the last message is used (default behavior).
 * Callers can pass an earlier index to cache only a stable prefix (e.g.
 * skipping tool results that will be truncated next turn), or an array to
 * mark several — typically `[stableIndex, tail]` so the stable prefix
 * keeps its cross-run entry while the moving tail serves within-run reads.
 * Out-of-range indices are dropped and duplicates collapse to one mark
 * (a message must never carry two cache_control blocks).
 */
export function addPromptCacheBreakpoints(
  messages: ModelMessage[],
  model: LanguageModel,
  target?: number | number[],
): ModelMessage[] {
  if (messages.length === 0 || !isAnthropicModel(model)) {
    return messages;
  }

  const requested = target === undefined
    ? [messages.length - 1]
    : Array.isArray(target) ? target : [target];
  const indices = new Set(
    requested.filter((i) => i >= 0 && i < messages.length),
  );
  if (indices.size === 0) {
    return messages;
  }

  const cacheDirective = {
    anthropic: { cacheControl: { type: "ephemeral" as const } },
  };

  return messages.map((message, i) => {
    if (indices.has(i)) {
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
