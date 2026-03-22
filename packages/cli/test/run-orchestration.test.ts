import { describe, expect, it } from "vitest";
import type { AgentEvent, Message } from "@poncho-ai/sdk";
import { __internalRunOrchestration } from "../src/index.js";

const baseMessages: Message[] = [{ role: "user", content: "hello" }];

describe("run orchestration helpers", () => {
  it("falls back to user messages when harness history is unavailable", () => {
    const conversation = {
      messages: baseMessages,
      _harnessMessages: "invalid",
    };
    const resolved = __internalRunOrchestration.loadRunHistory(
      conversation as unknown as { messages: Message[]; _harnessMessages?: unknown; _continuationMessages?: unknown },
    );
    expect(resolved.source).toBe("messages");
    expect(resolved.shouldRebuildCanonical).toBe(true);
    expect(resolved.messages).toEqual(baseMessages);
  });

  it("prefers continuation history when requested", () => {
    const continuation: Message[] = [{ role: "assistant", content: "next" }];
    const conversation = {
      messages: baseMessages,
      _harnessMessages: baseMessages,
      _continuationMessages: continuation,
    };
    const resolved = __internalRunOrchestration.loadRunHistory(
      conversation as unknown as { messages: Message[]; _harnessMessages?: unknown; _continuationMessages?: unknown },
      { preferContinuation: true },
    );
    expect(resolved.source).toBe("continuation");
    expect(resolved.messages).toEqual(continuation);
  });

  it("normalizes legacy approval checkpoint payloads", () => {
    const normalized = __internalRunOrchestration.normalizeApprovalCheckpoint(
      {
        approvalId: "approval_1",
        runId: "run_1",
        tool: "read_file",
        toolCallId: "tool_1",
        input: {},
        checkpointMessages: undefined,
        baseMessageCount: -1,
        pendingToolCalls: [{ id: "t2", name: "list_directory", input: {} }, { foo: "bar" }],
      } as unknown as {
        approvalId: string;
        runId: string;
        tool: string;
        toolCallId?: string;
        input: Record<string, unknown>;
        checkpointMessages?: Message[];
        baseMessageCount?: number;
        pendingToolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
        decision?: "approved" | "denied";
      },
      baseMessages,
    );
    expect(normalized.checkpointMessages).toEqual(baseMessages);
    expect(normalized.baseMessageCount).toBe(0);
    expect(normalized.pendingToolCalls).toEqual([{ id: "t2", name: "list_directory", input: {} }]);
  });

  it("builds checkpoint approvals with a canonical shape", () => {
    const checkpoints = __internalRunOrchestration.buildApprovalCheckpoints({
      approvals: [
        {
          approvalId: "approval_1",
          tool: "read_file",
          toolCallId: "tool_1",
          input: { path: "README.md" },
        },
      ],
      runId: "run_1",
      checkpointMessages: baseMessages,
      baseMessageCount: 2,
      pendingToolCalls: [{ id: "tool_2", name: "list_directory", input: {} }],
    });
    expect(checkpoints).toEqual([
      {
        approvalId: "approval_1",
        runId: "run_1",
        tool: "read_file",
        toolCallId: "tool_1",
        input: { path: "README.md" },
        checkpointMessages: baseMessages,
        baseMessageCount: 2,
        pendingToolCalls: [{ id: "tool_2", name: "list_directory", input: {} }],
      },
    ]);
  });

  it("resolves run request by preferring continuation and preserves rebuild signal", () => {
    const continuation: Message[] = [{ role: "assistant", content: "continuation" }];
    const resolved = __internalRunOrchestration.resolveRunRequest(
      {
        messages: baseMessages,
        _harnessMessages: "invalid",
        _continuationMessages: continuation,
      } as unknown as { messages: Message[]; _harnessMessages?: unknown; _continuationMessages?: unknown },
      {
        conversationId: "conv_1",
        messages: baseMessages,
        preferContinuation: true,
      },
    );
    expect(resolved.source).toBe("continuation");
    expect(resolved.messages).toEqual(continuation);
    expect(resolved.shouldRebuildCanonical).toBe(true);
  });

  it("records standard draft events for tool timeline and text", () => {
    const draft = __internalRunOrchestration.createTurnDraftState();
    __internalRunOrchestration.recordStandardTurnEvent(
      draft,
      { type: "tool:started", runId: "run_1", step: 1, tool: "read_file", input: {} } as AgentEvent,
    );
    __internalRunOrchestration.recordStandardTurnEvent(
      draft,
      { type: "tool:completed", runId: "run_1", step: 1, tool: "read_file", duration: 42, output: {} } as AgentEvent,
    );
    __internalRunOrchestration.recordStandardTurnEvent(
      draft,
      { type: "model:chunk", runId: "run_1", step: 1, content: "done" } as AgentEvent,
    );
    expect(draft.toolTimeline).toEqual(["- start `read_file`", "- done `read_file` (42ms)"]);
    expect(draft.assistantResponse).toBe("done");
  });

  it("executes a conversation turn through the shared executor", async () => {
    const events: AgentEvent[] = [
      { type: "run:started", runId: "run_1", startedAt: Date.now() } as AgentEvent,
      { type: "tool:started", runId: "run_1", step: 1, tool: "list_directory", input: {} } as AgentEvent,
      { type: "model:chunk", runId: "run_1", step: 1, content: "hello" } as AgentEvent,
      {
        type: "run:completed",
        runId: "run_1",
        result: {
          status: "completed",
          response: "hello",
          steps: 2,
          duration: 10,
          continuation: false,
          continuationMessages: baseMessages,
          usage: { inputTokens: 1, outputTokens: 1 },
          contextTokens: 321,
          contextWindow: 1000,
        },
      } as AgentEvent,
    ];
    const fakeHarness = {
      async *runWithTelemetry() {
        for (const event of events) yield event;
      },
    };
    const seenTypes: string[] = [];
    const result = await __internalRunOrchestration.executeConversationTurn({
      harness: fakeHarness as never,
      runInput: { task: "test", messages: baseMessages, conversationId: "conv_1" } as never,
      onEvent: (event) => {
        seenTypes.push(event.type);
      },
    });
    expect(result.latestRunId).toBe("run_1");
    expect(result.runSteps).toBe(2);
    expect(result.runContextTokens).toBe(321);
    expect(result.draft.assistantResponse).toBe("hello");
    expect(seenTypes).toEqual(["run:started", "tool:started", "model:chunk", "run:completed"]);
  });
});
