import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export type ModelProviderFactory = (modelName: string) => LanguageModel;

/**
 * Creates a model provider factory for the specified AI provider
 * @param provider - The provider name ('openai' or 'anthropic')
 * @returns A function that takes a model name and returns a LanguageModel instance
 */
export const createModelProvider = (provider?: string): ModelProviderFactory => {
  const normalized = (provider ?? "anthropic").toLowerCase();

  if (normalized === "openai") {
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    return (modelName: string) => openai(modelName);
  }

  const anthropic = createAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  return (modelName: string) => anthropic(modelName);
};
