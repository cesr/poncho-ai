import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Message } from "@poncho-ai/sdk";
import {
  compactMessages,
  findSafeSplitPoint,
  resolveCompactionConfig,
} from "../src/compaction.js";

// ── Fake model ──────────────────────────────────────────────────────────
// A MockLanguageModelV3 whose doGenerate returns a fixed text and records the
// prompt it was handed, so tests can assert what was sent to the summarizer.
function fakeModel(summaryText: string): {
  model: LanguageModel;
  prompts: string[];
} {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      // Flatten the prompt text we were given (the user message content).
      for (const m of options.prompt) {
        if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part.type === "text") prompts.push(part.text);
          }
        }
      }
      return {
        content: [{ type: "text", text: summaryText }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        warnings: [],
      };
    },
  });
  return { model: model as unknown as LanguageModel, prompts };
}

const userMsg = (text: string, metadata?: Message["metadata"]): Message => ({
  role: "user",
  content: text,
  ...(metadata ? { metadata } : {}),
});
const assistantText = (text: string): Message => ({
  role: "assistant",
  content: text,
});
const assistantToolCall = (text: string, toolName: string): Message => ({
  role: "assistant",
  content: JSON.stringify({
    text,
    tool_calls: [{ id: "call_1", name: toolName, arguments: {} }],
  }),
});
const toolResult = (text: string): Message => ({ role: "tool", content: text });

describe("findSafeSplitPoint", () => {
  it("splits at a normal user-message boundary", () => {
    const messages: Message[] = [
      userMsg("u0"),
      assistantText("a0"),
      userMsg("u1"),
      assistantText("a1"),
      userMsg("u2"), // index 4 — a clean user boundary
      assistantText("a2"),
      userMsg("u3"),
      assistantText("a3"),
    ];
    const idx = findSafeSplitPoint(messages, 4);
    // candidate = 8 - 4 = 4, which is already a user message → split there.
    expect(idx).toBe(4);
    expect(messages[idx]!.role).toBe("user");
  });

  it("returns -1 when there are too few messages", () => {
    const messages: Message[] = [userMsg("u0"), assistantText("a0")];
    expect(findSafeSplitPoint(messages, 4)).toBe(-1);
  });

  it("walks earlier when the split would orphan tool_calls being moved", () => {
    // The candidate user boundary sits right after an assistant tool-call
    // message whose tool result is on the preserved side — splitting there
    // would strand the tool_calls in the summary. Guard must walk earlier to
    // the next clean user boundary (which is still >= MIN_COMPACTABLE_MESSAGES).
    const messages: Message[] = [
      userMsg("u0"), // 0
      assistantText("a0"), // 1
      userMsg("u1"), // 2
      assistantText("a1"), // 3
      userMsg("u2"), // 4  <- safe earlier boundary (>= MIN_COMPACTABLE_MESSAGES)
      assistantText("a2"), // 5
      assistantToolCall("calling tool", "search"), // 6  <- would be last-compacted if split at 7
      userMsg("u3 (tool result delivered as user)"), // 7  <- candidate boundary
      toolResult("result"), // 8
      assistantText("a3"), // 9
    ];
    // candidate = 10 - 3 = 7 (a user message), but messages[6] is an assistant
    // with tool_calls → orphan. Must walk back to index 4.
    const idx = findSafeSplitPoint(messages, 3);
    expect(idx).toBe(4);
    // Confirm the chosen split does NOT end the compacted side on a dangling
    // assistant-with-tool_calls.
    const lastCompacted = messages[idx - 1]!;
    expect(
      typeof lastCompacted.content === "string" &&
        lastCompacted.content.includes('"tool_calls"'),
    ).toBe(false);
  });
});

describe("compactMessages", () => {
  const config = resolveCompactionConfig({ keepRecentMessages: 2 });

  it("compacts older messages into a summary continuation message", async () => {
    const { model } = fakeModel("SUMMARY TEXT");
    const messages: Message[] = [
      userMsg("u0"),
      assistantText("a0"),
      userMsg("u1"),
      assistantText("a1"),
      userMsg("u2"),
      assistantText("a2"),
    ];
    const res = await compactMessages(model, messages, config);
    expect(res.compacted).toBe(true);
    expect(res.messages[0]!.metadata?.isCompactionSummary).toBe(true);
    expect(res.messages[0]!.content).toContain("SUMMARY TEXT");
    // No subagents → no ledger block.
    expect(res.messages[0]!.content).not.toContain("## Subagents");
  });

  it("appends a verbatim subagent ledger after the LLM summary", async () => {
    const { model } = fakeModel("SUMMARY TEXT");
    const messages: Message[] = [
      userMsg("u0"),
      assistantText("a0"),
      userMsg(
        '[Subagent Result] Subagent "research the API" (sub_abc) completed:\n\nFound that the endpoint returns JSON with a data array. Use /v2/items.',
        {
          _subagentCallback: true,
          subagentId: "sub_abc",
          task: "research the API",
        } as Message["metadata"],
      ),
      assistantText("a1"),
      userMsg("u2"),
      assistantText("a2"),
    ];
    const res = await compactMessages(model, messages, config);
    expect(res.compacted).toBe(true);
    const content = res.messages[0]!.content as string;
    expect(content).toContain("## Subagents");
    expect(content).toContain("sub_abc");
    expect(content).toContain("research the API");
    // Digest carries the verbatim result body.
    expect(content).toContain("endpoint returns JSON");
    // Ledger comes AFTER the summary text.
    expect(content.indexOf("SUMMARY TEXT")).toBeLessThan(
      content.indexOf("## Subagents"),
    );
  });

  it("detects subagent callbacks by text marker even without metadata", async () => {
    const { model } = fakeModel("S");
    const messages: Message[] = [
      userMsg("u0"),
      assistantText("a0"),
      userMsg(
        '[Subagent Result] Subagent "compile report" (sub_xyz) completed:\n\nThe report is ready.',
      ),
      assistantText("a1"),
      userMsg("u2"),
      assistantText("a2"),
    ];
    const res = await compactMessages(model, messages, config);
    const content = res.messages[0]!.content as string;
    expect(content).toContain("sub_xyz");
    expect(content).toContain("compile report");
  });

  it("carries forward a prior ledger and dedupes by subagentId", async () => {
    const { model } = fakeModel("NEW SUMMARY");
    // First compacted message is itself a prior compaction summary that
    // already embeds a ## Subagents block for sub_abc and sub_old.
    const priorSummary: Message = {
      role: "user",
      content: [
        "[CONTEXT COMPACTION] prior.",
        "<summary>",
        "Earlier work done.",
        "",
        "## Subagents",
        "- **research the API** (sub_abc) — completed",
        "  Old digest about the API.",
        "- **legacy task** (sub_old) — completed",
        "  Legacy digest text.",
        "</summary>",
      ].join("\n"),
      metadata: { isCompactionSummary: true },
    };
    const messages: Message[] = [
      priorSummary,
      assistantText("a0"),
      // A fresh callback for sub_abc should OVERRIDE the prior entry.
      userMsg(
        '[Subagent Result] Subagent "research the API" (sub_abc) completed:\n\nUpdated finding: the endpoint moved to /v3/items.',
        {
          _subagentCallback: true,
          subagentId: "sub_abc",
          task: "research the API",
        } as Message["metadata"],
      ),
      assistantText("a1"),
      userMsg("u2"),
      assistantText("a2"),
    ];
    const res = await compactMessages(model, messages, config);
    const content = res.messages[0]!.content as string;
    // Both subagents present.
    expect(content).toContain("sub_abc");
    expect(content).toContain("sub_old");
    // sub_abc appears exactly once (deduped).
    const occurrences = content.split("sub_abc").length - 1;
    expect(occurrences).toBe(1);
    // The newer digest won.
    expect(content).toContain("/v3/items");
    expect(content).not.toContain("Old digest about the API");
  });

  it("passes a prior summary in full (no 1200-char truncation) and adds the merge instruction", async () => {
    const { model, prompts } = fakeModel("MERGED");
    const longPrior = "PRIOR-STATE ".repeat(200); // ~2400 chars, > 1200
    const priorSummary: Message = {
      role: "user",
      content: longPrior,
      metadata: { isCompactionSummary: true },
    };
    const messages: Message[] = [
      priorSummary,
      assistantText("a0"),
      userMsg("u1"),
      assistantText("a1"),
      userMsg("u2"),
      assistantText("a2"),
    ];
    await compactMessages(model, messages, config);
    const sentPrompt = prompts.join("\n");
    // The whole prior summary text was sent, untruncated.
    expect(sentPrompt).toContain(longPrior.trim());
    expect(sentPrompt).not.toContain("[truncated]");
    // Tagged as prior-summary, with the merge-and-update instruction.
    expect(sentPrompt).toContain("[prior-summary]");
    expect(sentPrompt).toContain("MERGE AND UPDATE");
  });

  it("still truncates non-prior-summary long messages to 1200 chars", async () => {
    const { model, prompts } = fakeModel("S");
    const longUser = "X".repeat(3000);
    const messages: Message[] = [
      userMsg(longUser),
      assistantText("a0"),
      userMsg("u1"),
      assistantText("a1"),
      userMsg("u2"),
      assistantText("a2"),
    ];
    await compactMessages(model, messages, config);
    const sentPrompt = prompts.join("\n");
    expect(sentPrompt).toContain("[truncated]");
    // The first message was NOT a prior summary, so no merge instruction.
    expect(sentPrompt).not.toContain("MERGE AND UPDATE");
  });
});
