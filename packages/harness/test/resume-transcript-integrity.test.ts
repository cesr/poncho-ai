import { describe, expect, it, vi } from "vitest";
import type { Message } from "@poncho-ai/sdk";
import {
  assembleCheckpointMessages,
  buildToolResultMessage,
  buildResumeCheckpoints,
  applyTurnMetadata,
  type StoredApproval,
} from "../src/orchestrator/index.js";
import type { Conversation } from "../src/state.js";

const conv = (overrides: Partial<Conversation> & Pick<Conversation, "messages">): Conversation => ({
  conversationId: "conv_test",
  title: "test",
  ownerId: "owner",
  tenantId: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

// An assistant tool-call message is JSON `{ text, tool_calls: [...] }` in the
// canonical transcript.
const assistantToolCall = (text: string, calls: Array<{ id: string; name: string }>): Message => ({
  role: "assistant",
  content: JSON.stringify({ text, tool_calls: calls.map((c) => ({ ...c, input: {} })) }),
});

const meta = (harnessMessages?: Message[]) => ({
  latestRunId: "",
  contextTokens: 0,
  contextWindow: 0,
  harnessMessages,
});

describe("assembleCheckpointMessages", () => {
  it("initial checkpoint: prior history (sliced by base) + delta", () => {
    const prior: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    // Task-bearing turn: the delta carries the turn's user message + the
    // assistant preamble/tool-call. base = prior length.
    const delta: Message[] = [
      { role: "user", content: "yeah those are a lot better" },
      assistantToolCall("I found the two PE events…", [{ id: "call_1", name: "update_event" }]),
    ];
    const checkpoint = { baseMessageCount: prior.length, checkpointMessages: delta } as StoredApproval;
    const out = assembleCheckpointMessages(conv({ messages: prior }), checkpoint);

    expect(out).toHaveLength(4);
    expect(out.some((m) => m.role === "user" && m.content === "yeah those are a lot better")).toBe(true);
    expect(out.some((m) => typeof m.content === "string" && m.content.includes("I found the two PE events"))).toBe(true);
  });

  it("resume convention: base 0 + full canonical returns the full canonical verbatim", () => {
    const full: Message[] = [
      { role: "user", content: "hi" },
      { role: "user", content: "approve this" },
      assistantToolCall("preamble", [{ id: "call_1", name: "t" }]),
    ];
    const checkpoint = { baseMessageCount: 0, checkpointMessages: full } as StoredApproval;
    // Display messages are irrelevant when base is 0 — the reconstruction must
    // NOT depend on them (this is what the old PonchOS hand-merge got wrong).
    const out = assembleCheckpointMessages(conv({ messages: [{ role: "user", content: "unrelated display" }] }), checkpoint);
    expect(out).toEqual(full);
  });
});

describe("buildToolResultMessage", () => {
  const asst = assistantToolCall("", [{ id: "call_1", name: "update_event" }]);

  it("pairs a provided result by callId", () => {
    const msg = buildToolResultMessage(asst, [{ callId: "call_1", toolName: "update_event", result: { ok: true } }]);
    expect(msg?.role).toBe("tool");
    expect(msg?.content).toContain("call_1");
    expect(msg?.content).toContain("ok");
  });

  it("emits the deferred-error marker when a result is missing", () => {
    const msg = buildToolResultMessage(asst, []);
    expect(msg?.content).toContain("Tool execution deferred");
  });

  it("returns undefined for a non-assistant / non-tool-call message", () => {
    expect(buildToolResultMessage({ role: "user", content: "hi" }, [])).toBeUndefined();
    expect(buildToolResultMessage({ role: "assistant", content: "plain text" }, [])).toBeUndefined();
  });
});

describe("buildResumeCheckpoints + round-trip (the regression)", () => {
  it("stores full canonical (base 0) so the NEXT resume reconstructs without dropping the user turn", () => {
    // The continuation ran with this full canonical (incl. the turn's user
    // message + preamble) and appended a tool result.
    const fullWithResults: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "approve this" },
      assistantToolCall("preamble text", [{ id: "call_1", name: "t1" }]),
      { role: "tool", content: JSON.stringify([{ type: "tool_result", tool_use_id: "call_1", content: "done" }]) },
    ];
    // It then gated again on a new tool (the re-checkpoint event delta).
    const delta2: Message[] = [assistantToolCall("", [{ id: "call_2", name: "t2" }])];
    const stored = buildResumeCheckpoints({
      priorMessages: fullWithResults,
      checkpointEvent: {
        approvals: [{ approvalId: "a2", tool: "t2", toolCallId: "call_2", input: {} }],
        checkpointMessages: delta2,
        pendingToolCalls: [{ id: "call_2", name: "t2", input: {} }],
      },
      runId: "run_2",
    });

    expect(stored[0]!.baseMessageCount).toBe(0);
    expect(stored[0]!.checkpointMessages).toEqual([...fullWithResults, ...delta2]);

    // Next resume reconstructs from the stored checkpoint — display is
    // deliberately unrelated to prove no dependence on it.
    const reconstructed = assembleCheckpointMessages(
      conv({ messages: [{ role: "user", content: "unrelated" }], pendingApprovals: stored }),
      stored[0]!,
    );
    // The user turn + preamble that PonchOS used to drop MUST survive.
    expect(reconstructed.some((m) => m.role === "user" && m.content === "approve this")).toBe(true);
    expect(reconstructed.some((m) => typeof m.content === "string" && m.content.includes("preamble text"))).toBe(true);
  });
});

describe("applyTurnMetadata transcript-integrity guard", () => {
  const latestUser: Message = { role: "user", content: "the latest question", metadata: { id: "u_latest" } };

  it("logs when the latest user message is missing from the canonical transcript", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = conv({ messages: [{ role: "assistant", content: "earlier" }, latestUser] });
    // Canonical is missing "the latest question" — the exact divergence.
    applyTurnMetadata(c, meta([{ role: "user", content: "hi" }, { role: "assistant", content: "x" }]));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("[transcript-guard]"));
    spy.mockRestore();
  });

  it("stays silent when the latest user message is present in canonical", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = conv({ messages: [latestUser] });
    applyTurnMetadata(c, meta([{ role: "user", content: "the latest question" }, { role: "assistant", content: "reply" }]));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("skips the check when canonical was legitimately compacted", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = conv({ messages: [latestUser] });
    applyTurnMetadata(c, meta([{ role: "assistant", content: "summary", metadata: { isCompactionSummary: true } }]));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
