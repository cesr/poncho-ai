import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import {
  getOpenAICodexAccessToken,
  type OpenAICodexAuthConfig,
} from "./openai-codex-auth.js";

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
const OPENAI_CODEX_DEFAULT_INSTRUCTIONS =
  "You are Codex, based on GPT-5. You are running as a coding agent in Poncho.";

const extractSystemInstructionFromInput = (input: unknown): string | undefined => {
  if (!Array.isArray(input)) return undefined;
  for (const message of input) {
    if (!message || typeof message !== "object") continue;
    const candidate = message as { role?: unknown; content?: unknown };
    if (candidate.role !== "system") continue;
    if (typeof candidate.content === "string" && candidate.content.trim().length > 0) {
      return candidate.content;
    }
    if (Array.isArray(candidate.content)) {
      const textParts = candidate.content
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const p = part as { text?: unknown };
          return typeof p.text === "string" ? p.text : "";
        })
        .filter((text) => text.trim().length > 0);
      if (textParts.length > 0) {
        return textParts.join("\n");
      }
    }
  }
  return undefined;
};

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
  openaiCodex?: OpenAICodexAuthConfig;
  anthropic?: { apiKeyEnv?: string };
}

/**
 * Creates a model provider factory for the specified AI provider.
 * API keys are read from environment variables; override the env var
 * name via the `providers` config in `poncho.config.js`.
 */
export const createModelProvider = (provider?: string, config?: ProviderConfig): ModelProviderFactory => {
  const normalized = (provider ?? "anthropic").toLowerCase();

  if (normalized === "openai-codex") {
    const openai = createOpenAI({
      apiKey: "oauth-placeholder",
      fetch: async (input, init) => {
        const { accessToken, accountId } = await getOpenAICodexAccessToken(config?.openaiCodex);
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${accessToken}`);
        headers.set("originator", "poncho");
        headers.set("User-Agent", "poncho/1.0");
        if (accountId) {
          headers.set("ChatGPT-Account-Id", accountId);
        }
        const originalUrl =
          input instanceof URL
            ? input.toString()
            : typeof input === "string"
              ? input
              : input.url;
        const parsed = new URL(originalUrl);
        const shouldRewrite =
          parsed.pathname.includes("/v1/responses") ||
          parsed.pathname.includes("/chat/completions");
        const targetUrl = shouldRewrite
          ? "https://chatgpt.com/backend-api/codex/responses"
          : originalUrl;
        let body = init?.body;
        if (
          shouldRewrite &&
          typeof body === "string" &&
          headers.get("Content-Type")?.includes("application/json")
        ) {
          try {
            const payload = JSON.parse(body) as {
              instructions?: unknown;
              input?: unknown;
              store?: unknown;
            };
            if (typeof payload.instructions !== "string" || payload.instructions.trim() === "") {
              payload.instructions =
                extractSystemInstructionFromInput(payload.input) ??
                OPENAI_CODEX_DEFAULT_INSTRUCTIONS;
            }
            // Codex endpoint requires store=false explicitly.
            payload.store = false;
            body = JSON.stringify(payload);
          } catch {
            // Keep original body if parsing fails.
          }
        }
        return fetch(targetUrl, { ...init, headers, body });
      },
    });
    return (modelName: string) => openai(modelName);
  }

  if (normalized === "openai") {
    const apiKeyEnv = config?.openai?.apiKeyEnv ?? "OPENAI_API_KEY";
    const openai = createOpenAI({
      apiKey: process.env[apiKeyEnv],
    });
    return (modelName: string) => openai(modelName);
  }

  const apiKeyEnv = config?.anthropic?.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const anthropic = createAnthropic({
    name: "anthropic",
    apiKey: process.env[apiKeyEnv],
  });
  return (modelName: string) => anthropic(modelName);
};
