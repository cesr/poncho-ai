import { describe, expect, it } from "vitest";
import type { AgentEvent, Message } from "@poncho-ai/sdk";
import {
  loadRunHistory,
  normalizeApprovalCheckpoint,
  buildApprovalCheckpoints,
  resolveRunRequest,
  createTurnDraftState,
  recordStandardTurnEvent,
  executeConversationTurn,
} from "../src/orchestrator/index.js";
import type { Conversation } from "../src/state.js";

const baseMessages: Message[] = [{ role: "user", content: "hello" }];

const makeConversation = (overrides: Partial<Conversation> & Pick<Conversation, "messages">): Conversation => ({
  conversationId: "conv_test",
  title: "test",
  ownerId: "local-owner",
  tenantId: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

describe("orchestrator helpers", () => {
  it("falls back to user messages when harness history is unavailable", () => {
    const conversation = makeConversation({
      messages: baseMessages,
      _harnessMessages: "invalid" as unknown as Message[],
    });
    const resolved = loadRunHistory(conversation);
    expect(resolved.source).toBe("messages");
    expect(resolved.shouldRebuildCanonical).toBe(true);
    expect(resolved.messages).toEqual(baseMessages);
  });

  it("prefers continuation history when requested", () => {
    const continuation: Message[] = [{ role: "assistant", content: "next" }];
    const conversation = makeConversation({
      messages: baseMessages,
      _harnessMessages: baseMessages,
      _continuationMessages: continuation,
    });
    const resolved = loadRunHistory(conversation, { preferContinuation: true });
    expect(resolved.source).toBe("continuation");
    expect(resolved.messages).toEqual(continuation);
  });

  it("normalizes legacy approval checkpoint payloads", () => {
    const normalized = normalizeApprovalCheckpoint(
      {
        approvalId: "approval_1",
        runId: "run_1",
        tool: "read_file",
        toolCallId: "tool_1",
        input: {},
        checkpointMessages: undefined as unknown as Message[],
        baseMessageCount: -1,
        pendingToolCalls: [
          { id: "t2", name: "list_directory", input: {} },
          { foo: "bar" } as unknown as { id: string; name: string; input: Record<string, unknown> },
        ],
      },
      baseMessages,
    );
    expect(normalized.checkpointMessages).toEqual(baseMessages);
    expect(normalized.baseMessageCount).toBe(0);
    expect(normalized.pendingToolCalls).toEqual([{ id: "t2", name: "list_directory", input: {} }]);
  });

  it("builds checkpoint approvals with a canonical shape", () => {
    const checkpoints = buildApprovalCheckpoints({
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
    const conversation = makeConversation({
      messages: baseMessages,
      _harnessMessages: "invalid" as unknown as Message[],
      _continuationMessages: continuation,
    });
    const resolved = resolveRunRequest(conversation, {
      conversationId: "conv_1",
      messages: baseMessages,
      preferContinuation: true,
    });
    expect(resolved.source).toBe("continuation");
    expect(resolved.messages).toEqual(continuation);
    expect(resolved.shouldRebuildCanonical).toBe(true);
  });

  it("records standard draft events for tool timeline and text", () => {
    const draft = createTurnDraftState();
    recordStandardTurnEvent(
      draft,
      { type: "tool:started", tool: "read_file", input: {} } as AgentEvent,
    );
    recordStandardTurnEvent(
      draft,
      { type: "tool:completed", tool: "read_file", duration: 42, output: {} } as AgentEvent,
    );
    recordStandardTurnEvent(
      draft,
      { type: "model:chunk", content: "done" } as AgentEvent,
    );
    expect(draft.toolTimeline).toEqual(["- start `read_file`", "- done `read_file` (42ms)"]);
    expect(draft.assistantResponse).toBe("done");
  });

  it("executes a conversation turn through the shared executor", async () => {
    const events: AgentEvent[] = [
      { type: "run:started", runId: "run_1", agentId: "test" } as AgentEvent,
      { type: "tool:started", tool: "list_directory", input: {} } as AgentEvent,
      { type: "model:chunk", content: "hello" } as AgentEvent,
      {
        type: "run:completed",
        runId: "run_1",
        result: {
          status: "completed" as const,
          response: "hello",
          steps: 2,
          duration: 10,
          tokens: { input: 1, output: 1, cached: 0 },
          continuation: false,
          continuationMessages: baseMessages,
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
    const result = await executeConversationTurn({
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
