import type { ModelClient, ModelClientOptions } from "./model-client.js";
import { AnthropicModelClient } from "./anthropic-client.js";
import { OpenAiModelClient } from "./openai-client.js";

export const createModelClient = (
  provider?: string,
  options?: ModelClientOptions,
): ModelClient => {
  const normalized = (provider ?? "anthropic").toLowerCase();
  if (normalized === "openai") {
    return new OpenAiModelClient(undefined, options);
  }
  return new AnthropicModelClient(undefined, options);
};
