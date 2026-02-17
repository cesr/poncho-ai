import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createConversationStore, createStateStore } from "../src/state.js";
import { ensureAgentIdentity, getAgentStoreDirectory } from "../src/agent-identity.js";

describe("state store factory", () => {
  it("uses memory provider when explicitly requested", async () => {
    const store = createStateStore({ provider: "memory", ttl: 60 });
    await store.set({
      runId: "run_memory",
      messages: [{ role: "user", content: "hello" }],
      updatedAt: Date.now(),
    });
    const value = await store.get("run_memory");
    expect(value?.runId).toBe("run_memory");
  });

  it("falls back gracefully when external provider is not configured", async () => {
    const store = createStateStore({ provider: "upstash", ttl: 60 });
    await store.set({
      runId: "run_fallback",
      messages: [{ role: "user", content: "hello" }],
      updatedAt: Date.now(),
    });
    const value = await store.get("run_fallback");
    expect(value?.runId).toBe("run_fallback");
  });
});

describe("conversation store factory", () => {
  it("uses memory provider by default", async () => {
    const store = createConversationStore();
    const created = await store.create("owner-a", "hello");
    expect(created.title).toBe("hello");
    const listed = await store.list("owner-a");
    expect(listed[0]?.conversationId).toBe(created.conversationId);
  });

  it("falls back gracefully when upstash is not configured", async () => {
    const store = createConversationStore({ provider: "upstash" });
    const created = await store.create("owner-b", "fallback");
    const found = await store.get(created.conversationId);
    expect(found?.title).toBe("fallback");
  });

  it("stores local conversations per file with index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poncho-state-local-layout-"));
    await writeFile(
      join(dir, "AGENT.md"),
      `---
name: local-layout-agent
model:
  provider: anthropic
  name: claude-opus-4-5
---

# Local layout
`,
      "utf8",
    );
    const store = createConversationStore({ provider: "local" }, { workingDir: dir });
    const created = await store.create("owner-c", "layout");
    const identity = await ensureAgentIdentity(dir);
    const agentDir = getAgentStoreDirectory(identity);
    const indexPath = resolve(agentDir, "conversations", "index.json");
    const indexContent = await readFile(indexPath, "utf8");
    expect(indexContent).toContain(created.conversationId);
    expect(indexContent).toContain('"schemaVersion": "v1"');
    await rm(agentDir, { recursive: true, force: true });
  });
});
