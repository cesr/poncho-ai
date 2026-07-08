import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Message } from "@poncho-ai/sdk";
import {
  compactMessages,
  findSafeSplitPoint,
  findSafeSplitPointByTurns,
  resolveCompactionConfig,
} from "../src/compaction.js";
import { deriveTaskOutcome, stripOutcomeVerdict } from "../src/orchestrator/orchestrator.js";

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

  it("still truncates non-prior-summary long messages to the per-message cap", async () => {
    const { model, prompts } = fakeModel("S");
    const longUser = "X".repeat(6000); // > SUMMARIZATION_MESSAGE_TRUNCATION_CHARS (4000)
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

describe("findSafeSplitPointByTurns", () => {
  const turns = (n: number, assistantText = "a"): Message[] => {
    const msgs: Message[] = [];
    for (let i = 0; i < n; i++) {
      msgs.push(userMsg(`u${i}`));
      msgs.push({ role: "assistant", content: `${assistantText}${i}` });
    }
    return msgs;
  };

  it("preserves the last N whole turns verbatim", () => {
    const messages = turns(6); // userIdx = [0,2,4,6,8,10]
    // keepRecentTurns=4, generous token budget → split before the 4th-from-last
    // user message (index 4), preserving turns u2..u5.
    const idx = findSafeSplitPointByTurns(messages, 4, 6, 1_000_000);
    expect(idx).toBe(4);
    const preserved = messages.slice(idx);
    const userCount = preserved.filter((m) => m.role === "user").length;
    expect(userCount).toBe(4);
  });

  it("reduces N when N turns exceed the preserved-token budget", () => {
    // Each assistant turn is large (~460 tokens); 4 turns preserved would blow a
    // small budget, so it must fall back to fewer turns.
    const big = "Z".repeat(1600);
    const messages = turns(6, big); // userIdx=[0,2,4,6,8,10]
    const idx = findSafeSplitPointByTurns(messages, 4, 6, 1200);
    // n=4 (~1840 tok) and n=3 (~1380 tok) exceed 1200; n=2 (~920 tok) fits →
    // split at userIdx[len-2] = index 8, preserving 2 turns.
    expect(idx).toBe(8);
    expect(messages.slice(idx).filter((m) => m.role === "user").length).toBe(2);
  });

  it("returns -1 for a single giant turn with no earlier user boundary", () => {
    // One user message followed by many tool rounds — no safe boundary to
    // compact against. (The message-based fallback also finds none.)
    const messages: Message[] = [userMsg("do a big thing")];
    for (let i = 0; i < 8; i++) {
      messages.push(assistantToolCall(`step ${i}`, "run_code"));
      messages.push(toolResult(`out ${i}`));
    }
    expect(findSafeSplitPointByTurns(messages, 4, 6, 1_000_000)).toBe(-1);
  });
});

describe("deriveTaskOutcome / stripOutcomeVerdict", () => {
  it("parses the self-declared verdict", () => {
    expect(deriveTaskOutcome("did it [[OUTCOME: succeeded]] all good", false)).toBe("succeeded");
    expect(deriveTaskOutcome("partial [[OUTCOME: partial]] some left", false)).toBe("partial");
    expect(deriveTaskOutcome("couldn't [[OUTCOME: failed]] no tools", false)).toBe("failed");
  });

  it("defaults to unknown when no verdict is present (never assumes success)", () => {
    expect(deriveTaskOutcome("I finished everything.", false)).toBe("unknown");
  });

  it("treats abnormal ends and empty output as failed", () => {
    expect(deriveTaskOutcome("whatever", true)).toBe("failed");
    expect(deriveTaskOutcome("   ", false)).toBe("failed");
  });

  it("strips the verdict marker from delivered text", () => {
    expect(stripOutcomeVerdict("Here is the report.\n[[OUTCOME: failed]] missing API key")).toBe(
      "Here is the report.",
    );
    expect(stripOutcomeVerdict("No verdict here")).toBe("No verdict here");
  });
});

describe("compactMessages — failure fidelity", () => {
  const config = resolveCompactionConfig({ keepRecentTurns: 1 });

  it("renders a failed subagent as failed (never 'completed') and keeps its reason", async () => {
    const { model } = fakeModel("SUMMARY");
    const messages: Message[] = [
      userMsg("please read my chats"),
      assistantText("delegating to a subagent"),
      userMsg(
        '[Subagent Result] Subagent "read chats" (sub_fail) failed:\n\nI could not access the LinkedIn tools, so I read nothing.',
        {
          _subagentCallback: true,
          subagentId: "sub_fail",
          task: "read chats",
          taskOutcome: "failed",
        } as Message["metadata"],
      ),
      assistantText("continuing"),
      userMsg("how did it go?"),
      assistantText("let me check"),
    ];
    const res = await compactMessages(model, messages, config);
    const content = res.messages[0]!.content as string;
    expect(content).toContain("## Subagents");
    expect(content).toContain("sub_fail");
    // Rendered with the failed outcome, not "completed".
    expect(content).toContain("— failed");
    expect(content).not.toContain("(sub_fail) — completed");
    // The failure reason survives verbatim.
    expect(content).toContain("could not access the LinkedIn tools");
  });

  it("keeps failure-bearing messages when the input budget forces drops", async () => {
    const { model, prompts } = fakeModel("S");
    // Many bulky non-failure messages plus one early failure. The failure must
    // survive into the summarizer input even if older bulk is dropped.
    const messages: Message[] = [userMsg("start")];
    messages.push(toolResult("ERROR: the deploy failed because the token expired"));
    for (let i = 0; i < 400; i++) {
      messages.push(assistantText("filler ".repeat(200) + i));
      messages.push(userMsg(`ok ${i}`));
    }
    messages.push(userMsg("final question"));
    messages.push(assistantText("final answer"));
    await compactMessages(model, messages, config);
    const sentPrompt = prompts.join("\n");
    // The failure line is marked important and never dropped.
    expect(sentPrompt).toContain("the deploy failed because the token expired");
  });
});
