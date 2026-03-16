import { describe, expect, it } from "vitest";
import { createMemoryStore, createMemoryTools } from "../src/memory.js";

describe("memory store factory", () => {
  it("uses memory provider by default", async () => {
    const store = createMemoryStore("agent-test");
    const updated = await store.updateMainMemory({
      content: "Cesar prefers short bullet points.",
    });
    expect(updated.content).toContain("short bullet points");
    const fetched = await store.getMainMemory();
    expect(fetched.content).toContain("short bullet points");
  });

  it("overwrites previous content on update", async () => {
    const store = createMemoryStore("agent-overwrite");
    await store.updateMainMemory({ content: "First version." });
    const result = await store.updateMainMemory({ content: "Second version." });
    expect(result.content).toBe("Second version.");
    expect(result.content).not.toContain("First version.");
  });

  it("falls back gracefully when upstash is not configured", async () => {
    const store = createMemoryStore("agent-fallback", { provider: "upstash" });
    const updated = await store.updateMainMemory({
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
      "memory_main_write",
      "memory_main_edit",
      "conversation_recall",
    ]);
  });

  describe("memory_main_write", () => {
    it("writes content to memory", async () => {
      const store = createMemoryStore("agent-write");
      const tools = createMemoryTools(store);
      const writeTool = tools.find((t) => t.name === "memory_main_write")!;
      const result = await writeTool.handler(
        { content: "User prefers dark mode." },
        { runId: "r1", agentId: "a1", step: 0, workingDir: ".", parameters: {} },
      );
      expect(result).toEqual({
        ok: true,
        memory: expect.objectContaining({ content: "User prefers dark mode." }),
      });
    });

    it("errors when content is empty", async () => {
      const store = createMemoryStore("agent-write-empty");
      const tools = createMemoryTools(store);
      const writeTool = tools.find((t) => t.name === "memory_main_write")!;
      await expect(
        writeTool.handler(
          { content: "  " },
          { runId: "r1", agentId: "a1", step: 0, workingDir: ".", parameters: {} },
        ),
      ).rejects.toThrow("content is required");
    });
  });

  describe("memory_main_edit", () => {
    const setupMemory = async () => {
      const store = createMemoryStore("agent-edit-" + Math.random());
      await store.updateMainMemory({
        content: "- prefers dark mode\n- likes TypeScript\n- uses vim",
      });
      const tools = createMemoryTools(store);
      const editTool = tools.find((t) => t.name === "memory_main_edit")!;
      const ctx = { runId: "r1", agentId: "a1", step: 0, workingDir: ".", parameters: {} };
      return { store, editTool, ctx };
    };

    it("replaces a unique string match in memory", async () => {
      const { store, editTool, ctx } = await setupMemory();
      const result = await editTool.handler(
        { old_str: "likes TypeScript", new_str: "loves TypeScript" },
        ctx,
      );
      expect(result).toEqual({
        ok: true,
        memory: expect.objectContaining({
          content: "- prefers dark mode\n- loves TypeScript\n- uses vim",
        }),
      });
      const fetched = await store.getMainMemory();
      expect(fetched.content).toContain("loves TypeScript");
    });

    it("deletes matched content when new_str is empty", async () => {
      const { store, editTool, ctx } = await setupMemory();
      await editTool.handler(
        { old_str: "\n- likes TypeScript", new_str: "" },
        ctx,
      );
      const fetched = await store.getMainMemory();
      expect(fetched.content).toBe("- prefers dark mode\n- uses vim");
    });

    it("errors when old_str is empty", async () => {
      const { editTool, ctx } = await setupMemory();
      await expect(
        editTool.handler({ old_str: "", new_str: "anything" }, ctx),
      ).rejects.toThrow("old_str must not be empty");
    });

    it("errors when old_str is not found in memory", async () => {
      const { editTool, ctx } = await setupMemory();
      await expect(
        editTool.handler({ old_str: "nonexistent text", new_str: "x" }, ctx),
      ).rejects.toThrow("old_str not found in memory");
    });

    it("errors when old_str matches multiple locations", async () => {
      const store = createMemoryStore("agent-edit-dup");
      await store.updateMainMemory({ content: "foo bar foo" });
      const tools = createMemoryTools(store);
      const editTool = tools.find((t) => t.name === "memory_main_edit")!;
      const ctx = { runId: "r1", agentId: "a1", step: 0, workingDir: ".", parameters: {} };
      await expect(
        editTool.handler({ old_str: "foo", new_str: "baz" }, ctx),
      ).rejects.toThrow("old_str appears multiple times");
    });
  });
});
