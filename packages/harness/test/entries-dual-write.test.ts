import { describe, it, expect } from "vitest";
import { InMemoryConversationStore } from "../src/state.js";
import { createLogger } from "@poncho-ai/sdk";
import {
  appendEntriesSafe,
  callbackStartedEntry,
  subagentResultEntry,
} from "../src/orchestrator/entries-dual-write.js";

const log = createLogger("test");
const convRef = { conversationId: "c1", ownerId: "owner", tenantId: null };

describe("appendEntriesSafe (queue writer)", () => {
  it("stamps a uuid id and returns stored entries with seq/createdAt", async () => {
    const store = new InMemoryConversationStore();
    const stored = await appendEntriesSafe(
      store,
      convRef,
      [
        subagentResultEntry({ subagentId: "s1", task: "t", status: "completed", timestamp: 1 }),
        callbackStartedEntry([1]),
      ],
      log,
    );
    expect(stored).toHaveLength(2);
    expect(stored.every((e) => typeof e.id === "string" && e.id.length > 0)).toBe(true);
    expect(stored.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("returns [] on empty input without touching the store", async () => {
    const store = new InMemoryConversationStore();
    expect(await appendEntriesSafe(store, convRef, [], log)).toEqual([]);
    expect(await store.readEntries("c1")).toEqual([]);
  });

  it("never throws — swallows store failures and returns []", async () => {
    const store = new InMemoryConversationStore();
    store.appendEntries = async () => {
      throw new Error("boom");
    };
    const stored = await appendEntriesSafe(
      store,
      convRef,
      [callbackStartedEntry([1])],
      log,
    );
    expect(stored).toEqual([]);
  });
});
