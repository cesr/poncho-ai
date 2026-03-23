import { describe, expect, it } from "vitest";
import { createReminderStore } from "../src/reminder-store.js";
import { createReminderTools } from "../src/reminder-tools.js";
import type { ToolContext } from "@poncho-ai/sdk";

describe("reminder store", () => {
  it("creates with memory provider by default", () => {
    const store = createReminderStore("agent-test", { provider: "memory" });
    expect(store).toBeDefined();
  });

  it("creates and lists reminders", async () => {
    const store = createReminderStore("agent-list", { provider: "memory" });
    const reminder = await store.create({
      task: "Check the report",
      scheduledAt: Date.now() + 60_000,
      conversationId: "conv-1",
    });
    expect(reminder.id).toBeTruthy();
    expect(reminder.status).toBe("pending");
    expect(reminder.task).toBe("Check the report");

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(reminder.id);
  });

  it("cancels a pending reminder", async () => {
    const store = createReminderStore("agent-cancel", { provider: "memory" });
    const reminder = await store.create({
      task: "Send email",
      scheduledAt: Date.now() + 60_000,
      conversationId: "conv-2",
    });
    const cancelled = await store.cancel(reminder.id);
    expect(cancelled.status).toBe("cancelled");

    const all = await store.list();
    expect(all[0].status).toBe("cancelled");
  });

  it("throws when cancelling a non-existent (deleted) reminder", async () => {
    const store = createReminderStore("agent-cancel-err", { provider: "memory" });
    const reminder = await store.create({
      task: "Task",
      scheduledAt: Date.now() + 60_000,
      conversationId: "conv-3",
    });
    await store.delete(reminder.id);
    await expect(store.cancel(reminder.id)).rejects.toThrow("not found");
  });

  it("deletes a reminder from the store", async () => {
    const store = createReminderStore("agent-fire", { provider: "memory" });
    const reminder = await store.create({
      task: "Do the thing",
      scheduledAt: Date.now() + 60_000,
      conversationId: "conv-4",
    });
    await store.delete(reminder.id);
    const all = await store.list();
    expect(all).toHaveLength(0);
  });

  it("throws when cancelling a nonexistent reminder", async () => {
    const store = createReminderStore("agent-noexist", { provider: "memory" });
    await expect(store.cancel("does-not-exist")).rejects.toThrow("not found");
  });
});

describe("reminder tools", () => {
  it("creates three tool definitions", () => {
    const store = createReminderStore("agent-tools", { provider: "memory" });
    const tools = createReminderTools(store);
    expect(tools.map((t) => t.name)).toEqual([
      "set_reminder",
      "list_reminders",
      "cancel_reminder",
    ]);
  });

  const makeContext = (overrides?: Partial<ToolContext>): ToolContext => ({
    runId: "run-1",
    agentId: "agent-1",
    step: 1,
    workingDir: "/tmp",
    parameters: {},
    conversationId: "conv-ctx",
    ...overrides,
  });

  it("set_reminder creates a future reminder", async () => {
    const store = createReminderStore("agent-tool-set", { provider: "memory" });
    const tools = createReminderTools(store);
    const setTool = tools.find((t) => t.name === "set_reminder")!;
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = (await setTool.handler({ task: "Buy milk", datetime: future }, makeContext())) as {
      ok: boolean;
      reminder: { id: string; status: string };
    };
    expect(result.ok).toBe(true);
    expect(result.reminder.status).toBe("pending");

    const all = await store.list();
    expect(all).toHaveLength(1);
  });

  it("set_reminder rejects past datetimes", async () => {
    const store = createReminderStore("agent-tool-past", { provider: "memory" });
    const tools = createReminderTools(store);
    const setTool = tools.find((t) => t.name === "set_reminder")!;
    const past = new Date(Date.now() - 60_000).toISOString();
    await expect(setTool.handler({ task: "Too late", datetime: past }, makeContext())).rejects.toThrow("future");
  });

  it("list_reminders returns all reminders", async () => {
    const store = createReminderStore("agent-tool-list", { provider: "memory" });
    await store.create({ task: "A", scheduledAt: Date.now() + 60_000, conversationId: "c1" });
    await store.create({ task: "B", scheduledAt: Date.now() + 120_000, conversationId: "c2" });

    const tools = createReminderTools(store);
    const listTool = tools.find((t) => t.name === "list_reminders")!;
    const result = (await listTool.handler({}, makeContext())) as {
      reminders: Array<{ task: string }>;
      count: number;
    };
    expect(result.count).toBe(2);
  });

  it("list_reminders filters by status", async () => {
    const store = createReminderStore("agent-tool-filter", { provider: "memory" });
    const r = await store.create({ task: "A", scheduledAt: Date.now() + 60_000, conversationId: "c1" });
    await store.create({ task: "B", scheduledAt: Date.now() + 120_000, conversationId: "c2" });
    await store.cancel(r.id);

    const tools = createReminderTools(store);
    const listTool = tools.find((t) => t.name === "list_reminders")!;
    const result = (await listTool.handler({ status: "pending" }, makeContext())) as {
      reminders: Array<{ task: string }>;
      count: number;
    };
    expect(result.count).toBe(1);
    expect(result.reminders[0].task).toBe("B");
  });

  it("cancel_reminder cancels by ID", async () => {
    const store = createReminderStore("agent-tool-cancel", { provider: "memory" });
    const r = await store.create({ task: "Cancel me", scheduledAt: Date.now() + 60_000, conversationId: "c1" });

    const tools = createReminderTools(store);
    const cancelTool = tools.find((t) => t.name === "cancel_reminder")!;
    const result = (await cancelTool.handler({ id: r.id }, makeContext())) as {
      ok: boolean;
      reminder: { status: string };
    };
    expect(result.ok).toBe(true);
    expect(result.reminder.status).toBe("cancelled");
  });
});
