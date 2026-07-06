import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { addPromptCacheBreakpoints } from "../src/prompt-cache.js";

const ANTHROPIC_MODEL = "anthropic/claude-opus-4-8";
const OPENAI_MODEL = "openai/gpt-4o";

function messages(n: number): ModelMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message ${i}`,
  }));
}

function markedIndices(result: ModelMessage[]): number[] {
  return result
    .map((m, i) => ((m.providerOptions as Record<string, unknown> | undefined)?.anthropic ? i : -1))
    .filter((i) => i >= 0);
}

describe("addPromptCacheBreakpoints", () => {
  it("marks the last message by default", () => {
    const result = addPromptCacheBreakpoints(messages(4), ANTHROPIC_MODEL);
    expect(markedIndices(result)).toEqual([3]);
  });

  it("marks a single explicit index", () => {
    const result = addPromptCacheBreakpoints(messages(4), ANTHROPIC_MODEL, 1);
    expect(markedIndices(result)).toEqual([1]);
  });

  it("marks stable + tail when given an array", () => {
    const result = addPromptCacheBreakpoints(messages(6), ANTHROPIC_MODEL, [2, 5]);
    expect(markedIndices(result)).toEqual([2, 5]);
  });

  it("collapses duplicate indices to one mark (stable == tail)", () => {
    const result = addPromptCacheBreakpoints(messages(4), ANTHROPIC_MODEL, [3, 3]);
    expect(markedIndices(result)).toEqual([3]);
    const marked = result[3].providerOptions as Record<string, unknown>;
    // One cacheControl object, not a doubled/merged mess.
    expect(marked.anthropic).toEqual({ cacheControl: { type: "ephemeral" } });
  });

  it("drops out-of-range indices (findLastStableCacheIndex can return -1)", () => {
    const result = addPromptCacheBreakpoints(messages(4), ANTHROPIC_MODEL, [-1, 3]);
    expect(markedIndices(result)).toEqual([3]);
  });

  it("returns messages unchanged when every index is out of range", () => {
    const input = messages(2);
    const result = addPromptCacheBreakpoints(input, ANTHROPIC_MODEL, [-1, 9]);
    expect(result).toBe(input);
  });

  it("leaves non-Anthropic models untouched", () => {
    const input = messages(3);
    const result = addPromptCacheBreakpoints(input, OPENAI_MODEL, [0, 2]);
    expect(result).toBe(input);
  });

  it("preserves existing providerOptions on the marked message", () => {
    const input = messages(2);
    input[1] = { ...input[1], providerOptions: { other: { keep: true } } as never };
    const result = addPromptCacheBreakpoints(input, ANTHROPIC_MODEL, [1]);
    const opts = result[1].providerOptions as Record<string, unknown>;
    expect(opts.other).toEqual({ keep: true });
    expect(opts.anthropic).toEqual({ cacheControl: { type: "ephemeral" } });
  });
});
