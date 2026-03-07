import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export type ModelProviderFactory = (modelName: string) => LanguageModel;

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
  "claude-opus-4-1": 200_000,
  "claude-sonnet-4": 200_000,

  "gpt-5.3-codex-spark": 128_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.2": 400_000,
  "gpt-5.1": 400_000,
  "gpt-5-mini": 400_000,
  "gpt-5-pro": 400_000,
  "gpt-5": 400_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4.1-nano": 1_000_000,
  "gpt-4.1": 1_000_000,
  "o4-mini": 200_000,
  "o3-mini": 200_000,
  "o3-pro": 200_000,
  "o3": 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Returns the context window size (in tokens) for a given model name.
 * Uses startsWith matching so dated variants (e.g. claude-opus-4-6-20260217)
 * resolve via the base prefix. Longest match wins.
 */
export const getModelContextWindow = (modelName: string): number => {
  if (MODEL_CONTEXT_WINDOWS[modelName] !== undefined) {
    return MODEL_CONTEXT_WINDOWS[modelName]!;
  }
  let best = "";
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (modelName.startsWith(key) && key.length > best.length) {
      best = key;
    }
  }
  return best ? MODEL_CONTEXT_WINDOWS[best]! : DEFAULT_CONTEXT_WINDOW;
};

export interface ProviderConfig {
  openai?: { apiKeyEnv?: string };
  anthropic?: { apiKeyEnv?: string };
}

/**
 * Creates a model provider factory for the specified AI provider.
 * API keys are read from environment variables; override the env var
 * name via the `providers` config in `poncho.config.js`.
 */
export const createModelProvider = (provider?: string, config?: ProviderConfig): ModelProviderFactory => {
  const normalized = (provider ?? "anthropic").toLowerCase();

  if (normalized === "openai") {
    const apiKeyEnv = config?.openai?.apiKeyEnv ?? "OPENAI_API_KEY";
    const openai = createOpenAI({
      apiKey: process.env[apiKeyEnv],
    });
    return (modelName: string) => openai(modelName);
  }

  const apiKeyEnv = config?.anthropic?.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const anthropic = createAnthropic({
    apiKey: process.env[apiKeyEnv],
  });
  return (modelName: string) => anthropic(modelName);
};
