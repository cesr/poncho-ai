import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@poncho-ai/sdk";
import { buildToolCompletedText, stripPillMetaTokens } from "../src/orchestrator/turn.js";

const completed = (over: Partial<AgentEvent & { type: "tool:completed" }>) =>
  buildToolCompletedText({
    type: "tool:completed",
    tool: "bash",
    toolCallId: "toolu_abc123",
    input: { command: "ls -la" },
    output: {},
    duration: 45,
    outputTokenEstimate: 0,
    ...over,
  } as AgentEvent & { type: "tool:completed" });

describe("buildToolCompletedText tcid token", () => {
  it("appends the tool-call id after the human detail", () => {
    const line = completed({});
    expect(line).toContain("- done `bash`");
    expect(line).toContain("(45ms, ls -la)");
    expect(line.endsWith("{tcid:toolu_abc123}")).toBe(true);
    // Token sits AFTER the first (...) detail group so old clients ignore it.
    expect(line.indexOf("{tcid:")).toBeGreaterThan(line.indexOf(")"));
  });

  it("omits the token when there is no tool-call id", () => {
    const line = completed({ toolCallId: undefined as unknown as string });
    expect(line).not.toContain("{tcid:");
  });

  it("keeps the id intact alongside the subagent token", () => {
    const line = completed({
      tool: "spawn_subagent",
      toolCallId: "toolu_xyz",
      input: { task: "research" },
      output: { subagentId: "conv_child" },
    });
    expect(line).toContain("[subagent:conv_child]");
    expect(line).toContain("{tcid:toolu_xyz}");
  });
});

describe("stripPillMetaTokens", () => {
  it("removes the tcid token (and its leading space) for model-visible text", () => {
    expect(stripPillMetaTokens("- done `bash` (45ms, ls) {tcid:toolu_abc}")).toBe(
      "- done `bash` (45ms, ls)",
    );
  });

  it("is a no-op for lines without a token", () => {
    expect(stripPillMetaTokens("- start `web_search` (\"q\")")).toBe(
      "- start `web_search` (\"q\")",
    );
  });
});
