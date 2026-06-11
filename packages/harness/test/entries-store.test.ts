import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryConversationStore } from "../src/state.js";
import type { ConversationStore } from "../src/state.js";
import type { ConversationEntry, NewConversationEntry } from "../src/storage/entries.js";
import { SqliteEngine } from "../src/storage/sqlite-engine.js";
import { createConversationStoreFromEngine } from "../src/storage/store-adapters.js";
import type { Message } from "@poncho-ai/sdk";

const msg = (role: Message["role"], content: string): Message => ({ role, content });

// Entry factories (without seq/createdAt — those are assigned by the store).
const userEntry = (id: string, content: string): NewConversationEntry => ({
  type: "user_message",
  id,
  message: msg("user", content),
  turnId: "t1",
});

const harnessEntry = (id: string, content: string): NewConversationEntry => ({
  type: "harness_message",
  id,
  message: msg("assistant", content),
  turnId: "t1",
});

const compactionEntry = (id: string): NewConversationEntry => ({
  type: "compaction",
  id,
  summaryMessage: msg("user", "summary so far"),
  firstKeptSeq: 2,
});

// Shared suite run against both InMemory and SQLite-backed stores.
function runSuite(name: string, factory: () => Promise<{ store: ConversationStore; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    let store: ConversationStore;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const ctx = await factory();
      store = ctx.store;
      cleanup = ctx.cleanup;
    });

    afterEach(async () => {
      await cleanup();
    });

    it("assigns consecutive per-conversation seqs starting at 1", async () => {
      const stored = await store.appendEntries("c1", "agent", null, [
        userEntry("u1", "hi"),
        harnessEntry("h1", "hello"),
        harnessEntry("h2", "how can I help?"),
      ]);
      expect(stored.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(stored.every((e) => typeof e.createdAt === "number")).toBe(true);
    });

    it("continues seq across multiple appendEntries calls", async () => {
      await store.appendEntries("c1", "agent", null, [userEntry("u1", "a")]);
      const second = await store.appendEntries("c1", "agent", null, [
        harnessEntry("h1", "b"),
        harnessEntry("h2", "c"),
      ]);
      expect(second.map((e) => e.seq)).toEqual([2, 3]);
    });

    it("keeps seq spaces independent per conversation", async () => {
      await store.appendEntries("c1", "agent", null, [userEntry("u1", "a")]);
      const other = await store.appendEntries("c2", "agent", null, [userEntry("u2", "b")]);
      expect(other[0].seq).toBe(1);
    });

    it("reads entries ordered by seq ascending", async () => {
      await store.appendEntries("c1", "agent", null, [
        userEntry("u1", "one"),
        harnessEntry("h1", "two"),
        harnessEntry("h2", "three"),
      ]);
      const all = await store.readEntries("c1");
      expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(all.map((e) => e.id)).toEqual(["u1", "h1", "h2"]);
    });

    it("filters by type", async () => {
      await store.appendEntries("c1", "agent", null, [
        userEntry("u1", "one"),
        harnessEntry("h1", "two"),
        harnessEntry("h2", "three"),
      ]);
      const harnessOnly = await store.readEntries("c1", { types: ["harness_message"] });
      expect(harnessOnly.map((e) => e.id)).toEqual(["h1", "h2"]);
    });

    it("filters by afterSeq", async () => {
      await store.appendEntries("c1", "agent", null, [
        userEntry("u1", "one"),
        harnessEntry("h1", "two"),
        harnessEntry("h2", "three"),
      ]);
      const after1 = await store.readEntries("c1", { afterSeq: 1 });
      expect(after1.map((e) => e.seq)).toEqual([2, 3]);
    });

    it("respects limit", async () => {
      await store.appendEntries("c1", "agent", null, [
        userEntry("u1", "one"),
        harnessEntry("h1", "two"),
        harnessEntry("h2", "three"),
      ]);
      const limited = await store.readEntries("c1", { limit: 2 });
      expect(limited.map((e) => e.seq)).toEqual([1, 2]);
    });

    it("round-trips distinct entry types with their payloads intact", async () => {
      await store.appendEntries("c1", "agent", null, [
        userEntry("u1", "question"),
        compactionEntry("cmp1"),
      ]);
      const all = await store.readEntries("c1");

      const user = all.find((e) => e.id === "u1");
      expect(user?.type).toBe("user_message");
      expect(user?.type === "user_message" && user.message.content).toBe("question");
      expect(user?.type === "user_message" && user.turnId).toBe("t1");

      const cmp = all.find((e) => e.id === "cmp1");
      expect(cmp?.type).toBe("compaction");
      expect(cmp?.type === "compaction" && cmp.firstKeptSeq).toBe(2);
      expect(cmp?.type === "compaction" && cmp.summaryMessage.content).toBe("summary so far");
    });

    it("returns an empty array for an unknown conversation", async () => {
      expect(await store.readEntries("nope")).toEqual([]);
    });

    it("treats an empty append as a no-op", async () => {
      const stored = await store.appendEntries("c1", "agent", null, []);
      expect(stored).toEqual([]);
      expect(await store.readEntries("c1")).toEqual([]);
    });
  });
}

runSuite("InMemoryConversationStore entries", async () => {
  const store = new InMemoryConversationStore();
  return { store, cleanup: async () => {} };
});

runSuite("SqliteEngine entries (via adapter)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "entries-store-"));
  const engine = new SqliteEngine({ workingDir: dir, agentId: "agent", dbPath: join(dir, "test.db") });
  await engine.initialize();
  const store = createConversationStoreFromEngine(engine);
  return {
    store,
    cleanup: async () => {
      await engine.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});
