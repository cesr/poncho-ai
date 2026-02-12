import { describe, expect, it } from "vitest";
import { createModelClient } from "../src/model-factory.js";
import { AnthropicModelClient } from "../src/anthropic-client.js";
import { OpenAiModelClient } from "../src/openai-client.js";

describe("model factory", () => {
  it("creates OpenAI model client for openai provider", () => {
    const client = createModelClient("openai");
    expect(client).toBeInstanceOf(OpenAiModelClient);
  });

  it("defaults to Anthropic model client", () => {
    const client = createModelClient(undefined);
    expect(client).toBeInstanceOf(AnthropicModelClient);
  });
});
