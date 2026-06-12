import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryConversationStore } from "../src/state.js";
import type { ConversationStore } from "../src/state.js";
import type { NewConversationEntry } from "../src/storage/entries.js";
import { SqliteEngine } from "../src/storage/sqlite-engine.js";
import { createConversationStoreFromEngine } from "../src/storage/store-adapters.js";

// Entry factories (without seq/createdAt — those are assigned by the store).
// The queue carries exactly two entry types; the engine-level append/read
// semantics tested here (seq assignment, ordering, filters, isolation) are
// type-agnostic.
const resultEntry = (id: string, subagentId: string): NewConversationEntry => ({
  type: "subagent_result",
  id,
  result: { subagentId, task: "t", status: "completed", timestamp: 1 },
});

const consumedEntry = (id: string, seqs: number[]): NewConversationEntry => ({
  type: "callback_started",
  id,
  consumedSeqs: seqs,
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
        resultEntry("r1", "s1"),
        resultEntry("r2", "s2"),
        consumedEntry("cb1", [1]),
      ]);
      expect(stored.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(stored.every((e) => typeof e.createdAt === "number")).toBe(true);
    });

    it("continues seq across multiple appendEntries calls", async () => {
      await store.appendEntries("c1", "agent", null, [resultEntry("r1", "s1")]);
      const second = await store.appendEntries("c1", "agent", null, [
        resultEntry("r2", "s2"),
        consumedEntry("cb1", [1]),
      ]);
      expect(second.map((e) => e.seq)).toEqual([2, 3]);
    });

    it("keeps seq spaces independent per conversation", async () => {
      await store.appendEntries("c1", "agent", null, [resultEntry("r1", "s1")]);
      const other = await store.appendEntries("c2", "agent", null, [resultEntry("r2", "s2")]);
      expect(other[0].seq).toBe(1);
    });

    it("reads entries ordered by seq ascending", async () => {
      await store.appendEntries("c1", "agent", null, [
        resultEntry("r1", "s1"),
        resultEntry("r2", "s2"),
        consumedEntry("cb1", [1]),
      ]);
      const all = await store.readEntries("c1");
      expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(all.map((e) => e.id)).toEqual(["r1", "r2", "cb1"]);
    });

    it("filters by type", async () => {
      await store.appendEntries("c1", "agent", null, [
        resultEntry("r1", "s1"),
        consumedEntry("cb1", [1]),
        resultEntry("r2", "s2"),
      ]);
      const resultsOnly = await store.readEntries("c1", { types: ["subagent_result"] });
      expect(resultsOnly.map((e) => e.id)).toEqual(["r1", "r2"]);
    });

    it("filters by afterSeq", async () => {
      await store.appendEntries("c1", "agent", null, [
        resultEntry("r1", "s1"),
        resultEntry("r2", "s2"),
        resultEntry("r3", "s3"),
      ]);
      const after1 = await store.readEntries("c1", { afterSeq: 1 });
      expect(after1.map((e) => e.seq)).toEqual([2, 3]);
    });

    it("respects limit", async () => {
      await store.appendEntries("c1", "agent", null, [
        resultEntry("r1", "s1"),
        resultEntry("r2", "s2"),
        resultEntry("r3", "s3"),
      ]);
      const limited = await store.readEntries("c1", { limit: 2 });
      expect(limited.map((e) => e.seq)).toEqual([1, 2]);
    });

    it("round-trips both entry types with their payloads intact", async () => {
      await store.appendEntries("c1", "agent", null, [
        resultEntry("r1", "sub-42"),
        consumedEntry("cb1", [1, 7]),
      ]);
      const all = await store.readEntries("c1");

      const result = all.find((e) => e.id === "r1");
      expect(result?.type).toBe("subagent_result");
      expect(result?.type === "subagent_result" && result.result.subagentId).toBe("sub-42");
      expect(result?.type === "subagent_result" && result.result.status).toBe("completed");

      const consumed = all.find((e) => e.id === "cb1");
      expect(consumed?.type).toBe("callback_started");
      expect(consumed?.type === "callback_started" && consumed.consumedSeqs).toEqual([1, 7]);
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
