import { describe, expect, it, beforeEach } from "vitest";
import { InMemoryEngine } from "../src/storage/memory-engine.js";
import { SqliteEngine } from "../src/storage/sqlite-engine.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageEngine } from "../src/storage/engine.js";

// ---------------------------------------------------------------------------
// Shared test suite that runs against both InMemory and SQLite engines
// ---------------------------------------------------------------------------

function runEngineTests(name: string, factory: () => Promise<{ engine: StorageEngine; cleanup: () => Promise<void> }>) {
  describe(`${name} engine`, () => {
    let engine: StorageEngine;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const ctx = await factory();
      engine = ctx.engine;
      cleanup = ctx.cleanup;
    });

    // -- Conversations --

    describe("conversations", () => {
      it("creates and retrieves a conversation", async () => {
        const conv = await engine.conversations.create("owner1", "Hello", "tenant1");
        expect(conv.title).toBe("Hello");
        expect(conv.ownerId).toBe("owner1");

        const got = await engine.conversations.get(conv.conversationId);
        expect(got?.title).toBe("Hello");
      });

      it("lists conversations filtered by tenant", async () => {
        await engine.conversations.create("o", "A", "t1");
        await engine.conversations.create("o", "B", "t2");

        const t1 = await engine.conversations.list(undefined, "t1");
        expect(t1).toHaveLength(1);
        expect(t1[0].title).toBe("A");
      });

      it("renames a conversation", async () => {
        const conv = await engine.conversations.create("o", "Old");
        const renamed = await engine.conversations.rename(conv.conversationId, "New");
        expect(renamed?.title).toBe("New");
      });

      it("deletes a conversation", async () => {
        const conv = await engine.conversations.create("o", "Del");
        const deleted = await engine.conversations.delete(conv.conversationId);
        expect(deleted).toBe(true);
        const got = await engine.conversations.get(conv.conversationId);
        expect(got).toBeUndefined();
      });

      it("searches conversations by title", async () => {
        await engine.conversations.create("o", "alpha beta");
        await engine.conversations.create("o", "gamma delta");

        const results = await engine.conversations.search("beta");
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("alpha beta");
      });

      it("persists parentConversationId atomically when provided to create", async () => {
        const parent = await engine.conversations.create("o", "Parent");
        const child = await engine.conversations.create("o", "Child", null, {
          parentConversationId: parent.conversationId,
          subagentMeta: { task: "do thing", status: "running" },
          messages: [{ role: "user", content: "do thing" }],
        });

        // Returned object reflects init fields
        expect(child.parentConversationId).toBe(parent.conversationId);
        expect(child.subagentMeta?.task).toBe("do thing");
        expect(child.messages).toHaveLength(1);

        // listSummaries reads the dedicated column — child must be linked to parent.
        const summaries = await engine.conversations.list("o");
        const childSummary = summaries.find((s) => s.conversationId === child.conversationId);
        expect(childSummary?.parentConversationId).toBe(parent.conversationId);

        // get() rehydrates from data blob — parent + meta must round-trip.
        const reloaded = await engine.conversations.get(child.conversationId);
        expect(reloaded?.parentConversationId).toBe(parent.conversationId);
        expect(reloaded?.subagentMeta?.task).toBe("do thing");
        expect(reloaded?.messages).toHaveLength(1);
      });

      it("persists thread anchor (parentMessageId + threadMeta) and lists threads", async () => {
        const parent = await engine.conversations.create("o", "Parent");
        const anchorId = "msg-anchor-1";
        const thread = await engine.conversations.create("o", "Thread A", null, {
          parentConversationId: parent.conversationId,
          parentMessageId: anchorId,
          messages: [
            { role: "user", content: "hi", metadata: { id: "m0" } },
            { role: "assistant", content: "hello", metadata: { id: anchorId } },
          ],
          threadMeta: {
            parentMessageSummary: "hello",
            snapshotLength: 2,
          },
        });
        expect(thread.parentMessageId).toBe(anchorId);
        expect(thread.threadMeta?.snapshotLength).toBe(2);

        // Summary surfaces the column
        const summary = (await engine.conversations.list("o")).find(
          (s) => s.conversationId === thread.conversationId,
        );
        expect(summary?.parentMessageId).toBe(anchorId);

        // get() round-trips threadMeta from the JSON blob
        const reloaded = await engine.conversations.get(thread.conversationId);
        expect(reloaded?.parentMessageId).toBe(anchorId);
        expect(reloaded?.threadMeta?.parentMessageSummary).toBe("hello");

        // listThreads filters to children with parent_message_id set
        const threads = await engine.conversations.listThreads(parent.conversationId);
        expect(threads.length).toBe(1);
        expect(threads[0].conversationId).toBe(thread.conversationId);
        expect(threads[0].parentMessageId).toBe(anchorId);
      });

      it("listThreads excludes subagent-only children (no parentMessageId)", async () => {
        const parent = await engine.conversations.create("o", "Parent");
        // Subagent: parentConversationId set but no parentMessageId
        await engine.conversations.create("o", "Subagent", null, {
          parentConversationId: parent.conversationId,
          subagentMeta: { task: "x", status: "completed" },
        });
        // Thread: both set
        const thread = await engine.conversations.create("o", "Thread", null, {
          parentConversationId: parent.conversationId,
          parentMessageId: "anchor",
          threadMeta: { snapshotLength: 1 },
        });

        const threads = await engine.conversations.listThreads(parent.conversationId);
        expect(threads).toHaveLength(1);
        expect(threads[0].conversationId).toBe(thread.conversationId);
      });
    });

    // -- Memory --

    describe("memory", () => {
      it("reads empty memory by default", async () => {
        const mem = await engine.memory.get("t1");
        expect(mem.content).toBe("");
      });

      it("updates and retrieves memory", async () => {
        await engine.memory.update("remember this", "t1");
        const mem = await engine.memory.get("t1");
        expect(mem.content).toBe("remember this");
      });

      it("isolates memory by tenant", async () => {
        await engine.memory.update("tenant A", "tA");
        await engine.memory.update("tenant B", "tB");
        expect((await engine.memory.get("tA")).content).toBe("tenant A");
        expect((await engine.memory.get("tB")).content).toBe("tenant B");
      });
    });

    // -- Todos --

    describe("todos", () => {
      it("stores and retrieves todos", async () => {
        const items = [
          { id: "1", content: "Buy milk", status: "pending" as const, priority: "medium" as const, createdAt: Date.now(), updatedAt: Date.now() },
        ];
        await engine.todos.set("conv1", items);
        const got = await engine.todos.get("conv1");
        expect(got).toHaveLength(1);
        expect(got[0].content).toBe("Buy milk");
      });

      it("returns empty array for missing conversation", async () => {
        const got = await engine.todos.get("nonexistent");
        expect(got).toHaveLength(0);
      });
    });

    // -- Reminders --

    describe("reminders", () => {
      it("creates and lists reminders", async () => {
        const r = await engine.reminders.create({
          task: "Call dentist",
          scheduledAt: Date.now() + 3600_000,
          conversationId: "conv1",
        });
        expect(r.task).toBe("Call dentist");

        const list = await engine.reminders.list();
        expect(list).toHaveLength(1);
      });

      it("cancels a reminder", async () => {
        const r = await engine.reminders.create({
          task: "Cancel me",
          scheduledAt: Date.now(),
          conversationId: "conv1",
        });
        const cancelled = await engine.reminders.cancel(r.id);
        expect(cancelled.status).toBe("cancelled");
      });
    });

    // -- VFS --

    describe("vfs", () => {
      it("writes and reads a file", async () => {
        const content = new TextEncoder().encode("hello world");
        await engine.vfs.writeFile("t1", "/test.txt", content);
        const read = await engine.vfs.readFile("t1", "/test.txt");
        expect(new TextDecoder().decode(read)).toBe("hello world");
      });

      it("creates directories recursively", async () => {
        await engine.vfs.mkdir("t1", "/a/b/c", true);
        const stat = await engine.vfs.stat("t1", "/a/b/c");
        expect(stat?.type).toBe("directory");
      });

      it("lists directory contents", async () => {
        await engine.vfs.writeFile("t1", "/dir/a.txt", new Uint8Array());
        await engine.vfs.writeFile("t1", "/dir/b.txt", new Uint8Array());
        const entries = await engine.vfs.readdir("t1", "/dir");
        expect(entries.map((e) => e.name).sort()).toEqual(["a.txt", "b.txt"]);
      });

      it("deletes files and directories", async () => {
        await engine.vfs.writeFile("t1", "/rm-me.txt", new TextEncoder().encode("bye"));
        await engine.vfs.deleteFile("t1", "/rm-me.txt");
        const stat = await engine.vfs.stat("t1", "/rm-me.txt");
        expect(stat).toBeUndefined();
      });

      it("renames files", async () => {
        await engine.vfs.writeFile("t1", "/old.txt", new TextEncoder().encode("data"));
        await engine.vfs.rename("t1", "/old.txt", "/new.txt");
        const old = await engine.vfs.stat("t1", "/old.txt");
        const nw = await engine.vfs.stat("t1", "/new.txt");
        expect(old).toBeUndefined();
        expect(nw?.type).toBe("file");
      });

      it("appends to files", async () => {
        await engine.vfs.writeFile("t1", "/append.txt", new TextEncoder().encode("hello"));
        await engine.vfs.appendFile("t1", "/append.txt", new TextEncoder().encode(" world"));
        const read = await engine.vfs.readFile("t1", "/append.txt");
        expect(new TextDecoder().decode(read)).toBe("hello world");
      });

      it("supports symlinks", async () => {
        await engine.vfs.writeFile("t1", "/target.txt", new TextEncoder().encode("linked"));
        await engine.vfs.symlink("t1", "/target.txt", "/link.txt");
        const target = await engine.vfs.readlink("t1", "/link.txt");
        expect(target).toBe("/target.txt");
      });

      it("reports usage stats", async () => {
        await engine.vfs.writeFile("t1", "/f1.txt", new TextEncoder().encode("abc"));
        await engine.vfs.writeFile("t1", "/f2.txt", new TextEncoder().encode("defgh"));
        const usage = await engine.vfs.getUsage("t1");
        expect(usage.fileCount).toBe(2);
        expect(usage.totalBytes).toBe(8);
      });

      it("listAllPaths returns all VFS paths", async () => {
        await engine.vfs.writeFile("t1", "/a.txt", new Uint8Array());
        await engine.vfs.mkdir("t1", "/dir");
        const paths = engine.vfs.listAllPaths("t1");
        expect(paths).toContain("/a.txt");
        expect(paths).toContain("/dir");
      });

      it("isolates files by tenant", async () => {
        await engine.vfs.writeFile("t1", "/secret.txt", new TextEncoder().encode("t1-data"));
        await engine.vfs.writeFile("t2", "/secret.txt", new TextEncoder().encode("t2-data"));
        const t1 = await engine.vfs.readFile("t1", "/secret.txt");
        const t2 = await engine.vfs.readFile("t2", "/secret.txt");
        expect(new TextDecoder().decode(t1)).toBe("t1-data");
        expect(new TextDecoder().decode(t2)).toBe("t2-data");
      });
    });

    // Cleanup at the end of each test
    it("cleanup", async () => {
      await engine.close();
      await cleanup();
    });
  });
}

// ---------------------------------------------------------------------------
// Run against InMemoryEngine
// ---------------------------------------------------------------------------

runEngineTests("InMemory", async () => {
  const engine = new InMemoryEngine("test-agent");
  await engine.initialize();
  return { engine, cleanup: async () => {} };
});

// ---------------------------------------------------------------------------
// Run against SqliteEngine
// ---------------------------------------------------------------------------

runEngineTests("SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "poncho-sqlite-test-"));
  const engine = new SqliteEngine({
    workingDir: dir,
    agentId: "test-agent",
  });
  await engine.initialize();
  return {
    engine,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});
