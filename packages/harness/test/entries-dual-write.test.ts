import { describe, it, expect } from "vitest";
import type { Message } from "@poncho-ai/sdk";
import { createLogger } from "@poncho-ai/sdk";
import { InMemoryConversationStore } from "../src/state.js";
import {
  buildDisplaySnapshot,
  buildLlmContext,
  getPendingSubagentResults,
} from "../src/storage/entries.js";
import {
  appendEntriesSafe,
  assistantMessageEntry,
  callbackStartedEntry,
  compactionEntry,
  harnessMessageEntries,
  newHarnessMessagesThisTurn,
  subagentResultEntry,
  userMessageEntry,
} from "../src/orchestrator/entries-dual-write.js";

const log = createLogger("test");
const msg = (role: Message["role"], content: string): Message => ({
  role,
  content,
  metadata: { id: `${role}-${content}` },
});

const conv = (id: string) => ({
  conversationId: id,
  ownerId: "owner-1",
  tenantId: null as string | null,
});

describe("entries dual-write", () => {
  it("rebuilds llm context + display from a simulated chat turn's appends", async () => {
    const store = new InMemoryConversationStore();
    const c = conv("c1");
    const turnId = "turn-1";

    // Turn start: user message.
    await appendEntriesSafe(store, c, [userMessageEntry(msg("user", "hi"), turnId)], log);

    // During the turn the harness produced two model-visible messages and a
    // final assistant bubble.
    const harness1 = msg("user", "hi");
    const harness2 = msg("assistant", "hello there");
    const finalAssistant = msg("assistant", "hello there");
    await appendEntriesSafe(
      store,
      c,
      [
        ...harnessMessageEntries([harness1, harness2], turnId),
        assistantMessageEntry(finalAssistant, turnId, "run-1"),
      ],
      log,
    );

    const entries = await store.readEntries("c1");

    // LLM context == the harness messages in order.
    const llm = buildLlmContext(entries);
    expect(llm.map((m) => m.content)).toEqual(["hi", "hello there"]);

    // Display == [user, assistant] (final assistant bubble; harness msgs hidden).
    const snap = buildDisplaySnapshot(entries, 100);
    expect(snap.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "hello there"],
    ]);
    expect(snap.totalMessages).toBe(2);
  });

  it("compaction overlay keeps summary + tail at rebuild", async () => {
    const store = new InMemoryConversationStore();
    const c = conv("c2");

    await appendEntriesSafe(
      store,
      c,
      harnessMessageEntries(
        [msg("user", "m1"), msg("assistant", "m2"), msg("user", "m3")],
        "t",
      ),
      log,
    );
    const before = await store.readEntries("c2");
    // Keep only the last harness message (seq 3) after compaction.
    const firstKeptSeq = before[before.length - 1]!.seq;
    await appendEntriesSafe(
      store,
      c,
      [compactionEntry(msg("assistant", "SUMMARY"), firstKeptSeq)],
      log,
    );

    const llm = buildLlmContext(await store.readEntries("c2"));
    expect(llm.map((m) => m.content)).toEqual(["SUMMARY", "m3"]);
  });

  it("subagent_result + callback_started track pending consumption", async () => {
    const store = new InMemoryConversationStore();
    const c = conv("c3");

    const stored = await appendEntriesSafe(
      store,
      c,
      [
        subagentResultEntry({
          subagentId: "sa-1",
          task: "do thing",
          status: "completed",
          timestamp: 1,
        }),
      ],
      log,
    );
    const resultSeq = stored[0]!.seq;

    // Before consumption: pending.
    expect(getPendingSubagentResults(await store.readEntries("c3"))).toHaveLength(1);

    // The callback consumes it + injects a hidden user message.
    await appendEntriesSafe(
      store,
      c,
      [
        callbackStartedEntry([resultSeq]),
        userMessageEntry(msg("user", "[Subagent Result] ..."), "cb-1", { hidden: true }),
      ],
      log,
    );

    const after = await store.readEntries("c3");
    expect(getPendingSubagentResults(after)).toHaveLength(0);
    // Hidden injected message does not appear in the display transcript.
    expect(buildDisplaySnapshot(after, 100).messages).toHaveLength(0);
  });

  it("newHarnessMessagesThisTurn diffs the suffix and flags shrinks", () => {
    const a = msg("user", "a");
    const b = msg("assistant", "b");
    const cc = msg("user", "c");

    expect(newHarnessMessagesThisTurn(undefined, [a, b])).toEqual({
      messages: [a, b],
      approximate: false,
    });
    expect(newHarnessMessagesThisTurn([a], [a, b, cc])).toEqual({
      messages: [b, cc],
      approximate: false,
    });
    // Shrink (compaction reshaped the array) → approximate, returns full next.
    const shrink = newHarnessMessagesThisTurn([a, b, cc], [a]);
    expect(shrink.approximate).toBe(true);
    expect(shrink.messages).toEqual([a]);
  });

  it("appendEntriesSafe swallows store errors and returns []", async () => {
    const brokenStore = {
      appendEntries: async () => {
        throw new Error("boom");
      },
    } as unknown as InMemoryConversationStore;
    const result = await appendEntriesSafe(
      brokenStore,
      conv("c4"),
      [userMessageEntry(msg("user", "x"), "t")],
      log,
    );
    expect(result).toEqual([]);
  });
});
