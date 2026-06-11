import { describe, it, expect, afterEach } from "vitest";
import { InMemoryConversationStore } from "../src/state.js";
import type { NewConversationEntry } from "../src/storage/entries.js";
import type { Message } from "@poncho-ai/sdk";

const msg = (role: Message["role"], content: string): Message => ({ role, content });

// Targeted cutover: ONLY pendingSubagentResults is read from entries. Two
// subagent results; one later consumed by a callback_started entry.
function subagentEntries(): NewConversationEntry[] {
  return [
    { type: "subagent_result", id: "sr1", result: { subagentId: "s1", task: "a", status: "completed", timestamp: 1 } },
    { type: "subagent_result", id: "sr2", result: { subagentId: "s2", task: "b", status: "completed", timestamp: 2 } },
  ];
}

describe("Phase 3 targeted read cutover (pendingSubagentResults only)", () => {
  const prevFlag = process.env.PONCHO_READ_ENTRIES;
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.PONCHO_READ_ENTRIES;
    else process.env.PONCHO_READ_ENTRIES = prevFlag;
  });

  it("rebuilds pendingSubagentResults from entries, leaving message history on the blob", async () => {
    delete process.env.PONCHO_READ_ENTRIES; // ON by default
    const store = new InMemoryConversationStore();
    const conv = await store.create("owner", "title", null);
    // Blob message history must be preserved (never raced, stays authoritative).
    conv.messages = [msg("user", "hi"), msg("assistant", "hello")];
    conv._harnessMessages = [msg("user", "hi"), msg("assistant", "hello")];
    conv.pendingSubagentResults = []; // stale blob value
    await store.update(conv);

    await store.appendEntries(conv.conversationId, "agent", null, subagentEntries());

    const loaded = await store.get(conv.conversationId);
    expect(loaded).toBeDefined();
    // pendingSubagentResults comes from entries
    expect(loaded!.pendingSubagentResults?.map((r) => r.subagentId)).toEqual(["s1", "s2"]);
    // message history is UNTOUCHED (still the blob)
    expect(loaded!.messages.map((m) => m.content)).toEqual(["hi", "hello"]);
    expect(loaded!._harnessMessages?.map((m) => m.content)).toEqual(["hi", "hello"]);
  });

  it("excludes results consumed by a callback_started entry", async () => {
    delete process.env.PONCHO_READ_ENTRIES;
    const store = new InMemoryConversationStore();
    const conv = await store.create("owner", "title", null);
    const stored = await store.appendEntries(conv.conversationId, "agent", null, subagentEntries());
    await store.appendEntries(conv.conversationId, "agent", null, [
      { type: "callback_started", id: "cb1", consumedSeqs: [stored[0]!.seq] },
    ]);

    const loaded = await store.get(conv.conversationId);
    expect(loaded!.pendingSubagentResults?.map((r) => r.subagentId)).toEqual(["s2"]);
  });

  it("falls back to the blob pendingSubagentResults when there are no entries", async () => {
    delete process.env.PONCHO_READ_ENTRIES;
    const store = new InMemoryConversationStore();
    const conv = await store.create("owner", "title", null);
    conv.pendingSubagentResults = [{ subagentId: "blob", task: "x", status: "completed", timestamp: 0 }];
    await store.update(conv);

    const loaded = await store.get(conv.conversationId);
    expect(loaded!.pendingSubagentResults?.map((r) => r.subagentId)).toEqual(["blob"]);
  });

  it("kill-switch PONCHO_READ_ENTRIES=0 reverts to blob even with entries", async () => {
    process.env.PONCHO_READ_ENTRIES = "0";
    const store = new InMemoryConversationStore();
    const conv = await store.create("owner", "title", null);
    conv.pendingSubagentResults = [{ subagentId: "blobwins", task: "x", status: "completed", timestamp: 0 }];
    await store.update(conv);
    await store.appendEntries(conv.conversationId, "agent", null, subagentEntries());

    const loaded = await store.get(conv.conversationId);
    expect(loaded!.pendingSubagentResults?.map((r) => r.subagentId)).toEqual(["blobwins"]);
  });
});
