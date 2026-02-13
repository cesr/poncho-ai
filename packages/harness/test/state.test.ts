import { describe, expect, it } from "vitest";
import { createConversationStore, createStateStore } from "../src/state.js";

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
});
