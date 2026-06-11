import { describe, it, expect, afterEach } from "vitest";
import { InMemoryConversationStore } from "../src/state.js";
import {
  buildLlmContext,
  buildDisplaySnapshot,
  type NewConversationEntry,
} from "../src/storage/entries.js";
import type { Message } from "@poncho-ai/sdk";

const msg = (role: Message["role"], content: string): Message => ({ role, content });

// A turn's worth of entries: a user display message, the harness (LLM
// transcript) messages for that turn, and the final assistant bubble.
function turnEntries(): NewConversationEntry[] {
  return [
    { type: "user_message", id: "u1", message: msg("user", "hello"), turnId: "t1" },
    { type: "harness_message", id: "h1", message: msg("user", "hello"), turnId: "t1" },
    { type: "harness_message", id: "h2", message: msg("assistant", "hi there"), turnId: "t1" },
    {
      type: "assistant_message",
      id: "a1",
      message: msg("assistant", "hi there"),
      turnId: "t1",
      runId: "r1",
    },
  ];
}

describe("Phase 3c read cutover", () => {
  const prevFlag = process.env.PONCHO_READ_ENTRIES;

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.PONCHO_READ_ENTRIES;
    else process.env.PONCHO_READ_ENTRIES = prevFlag;
  });

  it("get() rebuilds _harnessMessages/messages from entries when present", async () => {
    delete process.env.PONCHO_READ_ENTRIES; // ON by default
    const store = new InMemoryConversationStore();
    const conv = await store.create("owner", "title", null);

    // Seed the blob with stale messages so we can prove the override happened.
    conv.messages = [msg("assistant", "STALE BLOB")];
    conv._harnessMessages = [msg("assistant", "STALE BLOB HARNESS")];
    await store.update(conv);

    const entries = await store.appendEntries(conv.conversationId, "agent", null, turnEntries());

    const loaded = await store.get(conv.conversationId);
    expect(loaded).toBeDefined();
    expect(loaded!._harnessMessages).toEqual(buildLlmContext(entries));
    expect(loaded!.messages).toEqual(buildDisplaySnapshot(entries, 100000).messages);
    // Display transcript drops the harness-only messages; keeps user + assistant bubble.
    expect(loaded!.messages.map((m) => m.content)).toEqual(["hello", "hi there"]);
  });

  it("get() falls back to the blob when there are no entries", async () => {
    delete process.env.PONCHO_READ_ENTRIES;
    const store = new InMemoryConversationStore();
    const conv = await store.create("owner", "title", null);
    conv.messages = [msg("user", "blob only")];
    conv._harnessMessages = [msg("user", "blob only harness")];
    await store.update(conv);

    const loaded = await store.get(conv.conversationId);
    expect(loaded!.messages).toEqual([msg("user", "blob only")]);
    expect(loaded!._harnessMessages).toEqual([msg("user", "blob only harness")]);
  });

  it("kill-switch PONCHO_READ_ENTRIES=0 reverts to blob reads even with entries", async () => {
    process.env.PONCHO_READ_ENTRIES = "0";
    const store = new InMemoryConversationStore();
    const conv = await store.create("owner", "title", null);
    conv.messages = [msg("user", "blob wins")];
    await store.update(conv);
    await store.appendEntries(conv.conversationId, "agent", null, turnEntries());

    const loaded = await store.get(conv.conversationId);
    expect(loaded!.messages).toEqual([msg("user", "blob wins")]);
  });

  it("get() does not mutate the stored blob conversation (clone)", async () => {
    delete process.env.PONCHO_READ_ENTRIES;
    const store = new InMemoryConversationStore();
    const conv = await store.create("owner", "title", null);
    conv.messages = [msg("assistant", "STALE BLOB")];
    await store.update(conv);
    await store.appendEntries(conv.conversationId, "agent", null, turnEntries());

    await store.get(conv.conversationId);
    // Re-read with the kill-switch on: should still see the untouched blob.
    process.env.PONCHO_READ_ENTRIES = "0";
    const blob = await store.get(conv.conversationId);
    expect(blob!.messages).toEqual([msg("assistant", "STALE BLOB")]);
  });
});
