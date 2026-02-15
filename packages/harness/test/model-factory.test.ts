import { describe, expect, it } from "vitest";
import { createModelProvider } from "../src/model-factory.js";

describe("model factory", () => {
  it("creates a function for OpenAI provider", () => {
    const provider = createModelProvider("openai");
    expect(provider).toBeInstanceOf(Function);

    // Should be able to call it with a model name
    const model = provider("gpt-4");
    expect(model).toBeDefined();
    expect(model.provider).toBe("openai.chat");
  });

  it("creates a function for Anthropic provider", () => {
    const provider = createModelProvider("anthropic");
    expect(provider).toBeInstanceOf(Function);

    // Should be able to call it with a model name
    const model = provider("claude-3-opus-20240229");
    expect(model).toBeDefined();
    expect(model.provider).toBe("anthropic.messages");
  });

  it("defaults to Anthropic when no provider specified", () => {
    const provider = createModelProvider(undefined);
    expect(provider).toBeInstanceOf(Function);

    const model = provider("claude-3-opus-20240229");
    expect(model).toBeDefined();
    expect(model.provider).toBe("anthropic.messages");
  });

  it("normalizes provider names to lowercase", () => {
    const provider = createModelProvider("OpenAI");
    expect(provider).toBeInstanceOf(Function);

    const model = provider("gpt-4");
    expect(model.provider).toBe("openai.chat");
  });
});
