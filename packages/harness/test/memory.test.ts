import { describe, expect, it } from "vitest";
import { createMemoryStore, createMemoryTools } from "../src/memory.js";

describe("memory store factory", () => {
  it("uses memory provider by default", async () => {
    const store = createMemoryStore("agent-test");
    const updated = await store.updateMainMemory({
      mode: "replace",
      content: "Cesar prefers short bullet points.",
    });
    expect(updated.content).toContain("short bullet points");
    const fetched = await store.getMainMemory();
    expect(fetched.content).toContain("short bullet points");
  });

  it("supports append updates", async () => {
    const store = createMemoryStore("agent-append");
    await store.updateMainMemory({
      mode: "replace",
      content: "Initial memory.",
    });
    const result = await store.updateMainMemory({
      mode: "append",
      content: "Appended line.",
    });
    expect(result.content).toContain("Initial memory.");
    expect(result.content).toContain("Appended line.");
  });

  it("falls back gracefully when upstash is not configured", async () => {
    const store = createMemoryStore("agent-fallback", { provider: "upstash" });
    const updated = await store.updateMainMemory({
      mode: "replace",
      content: "Fallback path still stores memory",
    });
    expect(updated.content).toContain("Fallback path");
  });
});

describe("memory tools", () => {
  it("creates tool definitions", async () => {
    const store = createMemoryStore("agent-tools");
    const tools = createMemoryTools(store);
    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_main_get",
      "memory_main_update",
      "conversation_recall",
    ]);
  });
});
