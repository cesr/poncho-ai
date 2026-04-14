import { describe, expect, it } from "vitest";
import { createReminderStore, computeNextOccurrence } from "../src/reminder-store.js";
import { createReminderTools } from "../src/reminder-tools.js";
import type { ToolContext } from "@poncho-ai/sdk";
import type { Reminder, Recurrence } from "../src/reminder-store.js";

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

  it("creates a recurring reminder with recurrence config", async () => {
    const store = createReminderStore("agent-recur", { provider: "memory" });
    const reminder = await store.create({
      task: "Daily standup",
      scheduledAt: Date.now() + 60_000,
      conversationId: "conv-5",
      recurrence: { type: "daily", interval: 1 },
    });
    expect(reminder.recurrence).toEqual({ type: "daily", interval: 1 });
    expect(reminder.occurrenceCount).toBe(0);
  });

  it("updates scheduledAt and occurrenceCount", async () => {
    const store = createReminderStore("agent-update", { provider: "memory" });
    const reminder = await store.create({
      task: "Weekly report",
      scheduledAt: Date.now() + 60_000,
      conversationId: "conv-6",
      recurrence: { type: "weekly" },
    });
    const newTime = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const updated = await store.update(reminder.id, {
      scheduledAt: newTime,
      occurrenceCount: 1,
    });
    expect(updated.scheduledAt).toBe(newTime);
    expect(updated.occurrenceCount).toBe(1);
    expect(updated.status).toBe("pending");
  });

  it("throws when updating a nonexistent reminder", async () => {
    const store = createReminderStore("agent-update-err", { provider: "memory" });
    await expect(store.update("nope", { scheduledAt: 123 })).rejects.toThrow("not found");
  });
});

describe("computeNextOccurrence", () => {
  const baseReminder = (recurrence: Recurrence, overrides?: Partial<Reminder>): Reminder => ({
    id: "r1",
    task: "test",
    scheduledAt: new Date("2026-04-14T09:00:00Z").getTime(),
    status: "pending",
    createdAt: Date.now(),
    conversationId: "c1",
    recurrence,
    occurrenceCount: 0,
    ...overrides,
  });

  it("returns null for non-recurring reminder", () => {
    const r = baseReminder(null as unknown as Recurrence, { recurrence: null });
    expect(computeNextOccurrence(r)).toBeNull();
  });

  it("computes daily recurrence", () => {
    const r = baseReminder({ type: "daily" });
    const next = computeNextOccurrence(r)!;
    expect(next).toBe(r.scheduledAt + 24 * 60 * 60 * 1000);
  });

  it("computes daily recurrence with interval", () => {
    const r = baseReminder({ type: "daily", interval: 3 });
    const next = computeNextOccurrence(r)!;
    expect(next).toBe(r.scheduledAt + 3 * 24 * 60 * 60 * 1000);
  });

  it("computes weekly recurrence", () => {
    const r = baseReminder({ type: "weekly" });
    const next = computeNextOccurrence(r)!;
    expect(next).toBe(r.scheduledAt + 7 * 24 * 60 * 60 * 1000);
  });

  it("computes weekly recurrence with daysOfWeek", () => {
    // 2026-04-14 is a Tuesday (day 2)
    const r = baseReminder({ type: "weekly", daysOfWeek: [2, 4] }); // Tue, Thu
    const next = computeNextOccurrence(r)!;
    // Next match after Tuesday should be Thursday (2 days later)
    expect(next).toBe(r.scheduledAt + 2 * 24 * 60 * 60 * 1000);
  });

  it("wraps weekly daysOfWeek to next week", () => {
    // 2026-04-14 is a Tuesday (day 2). Only Monday (1) in list → next week.
    const r = baseReminder({ type: "weekly", daysOfWeek: [1] });
    const next = computeNextOccurrence(r)!;
    // Next Monday is 6 days later
    expect(next).toBe(r.scheduledAt + 6 * 24 * 60 * 60 * 1000);
  });

  it("computes monthly recurrence", () => {
    const r = baseReminder({ type: "monthly" });
    const next = computeNextOccurrence(r)!;
    const nextDate = new Date(next);
    expect(nextDate.getUTCMonth()).toBe(4); // May (0-indexed)
    expect(nextDate.getUTCDate()).toBe(14);
  });

  it("computes cron recurrence", () => {
    // Every day at 10:00 UTC
    const r = baseReminder({ type: "cron", expression: "0 10 * * *" });
    const next = computeNextOccurrence(r)!;
    const nextDate = new Date(next);
    expect(nextDate.getUTCHours()).toBe(10);
    expect(nextDate.getUTCMinutes()).toBe(0);
  });

  it("respects maxOccurrences", () => {
    const r = baseReminder({ type: "daily", maxOccurrences: 3 }, { occurrenceCount: 2 });
    expect(computeNextOccurrence(r)).toBeNull();
  });

  it("respects endsAt", () => {
    const endsAt = new Date("2026-04-14T10:00:00Z").getTime();
    // Daily would go to April 15, which is after endsAt
    const r = baseReminder({ type: "daily", endsAt });
    expect(computeNextOccurrence(r)).toBeNull();
  });

  it("returns null for cron with no expression", () => {
    const r = baseReminder({ type: "cron" });
    expect(computeNextOccurrence(r)).toBeNull();
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

  it("set_reminder creates a recurring reminder", async () => {
    const store = createReminderStore("agent-tool-recur", { provider: "memory" });
    const tools = createReminderTools(store);
    const setTool = tools.find((t) => t.name === "set_reminder")!;
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = (await setTool.handler(
      {
        task: "Daily standup",
        datetime: future,
        recurrence: { type: "daily", interval: 1 },
      },
      makeContext(),
    )) as {
      ok: boolean;
      reminder: { id: string; status: string; recurrence: { type: string }; occurrenceCount: number };
    };
    expect(result.ok).toBe(true);
    expect(result.reminder.recurrence.type).toBe("daily");
    expect(result.reminder.occurrenceCount).toBe(0);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].recurrence).toEqual({ type: "daily", interval: 1 });
  });

  it("set_reminder rejects invalid recurrence type", async () => {
    const store = createReminderStore("agent-tool-bad-recur", { provider: "memory" });
    const tools = createReminderTools(store);
    const setTool = tools.find((t) => t.name === "set_reminder")!;
    const future = new Date(Date.now() + 3600_000).toISOString();
    await expect(
      setTool.handler(
        { task: "Bad", datetime: future, recurrence: { type: "hourly" } },
        makeContext(),
      ),
    ).rejects.toThrow("Invalid recurrence type");
  });

  it("set_reminder rejects past datetimes", async () => {
    const store = createReminderStore("agent-tool-past", { provider: "memory" });
    const tools = createReminderTools(store);
    const setTool = tools.find((t) => t.name === "set_reminder")!;
    const past = new Date(Date.now() - 60_000).toISOString();
    await expect(setTool.handler({ task: "Too late", datetime: past }, makeContext())).rejects.toThrow("future");
  });

  it("list_reminders returns all reminders with recurrence info", async () => {
    const store = createReminderStore("agent-tool-list", { provider: "memory" });
    await store.create({ task: "A", scheduledAt: Date.now() + 60_000, conversationId: "c1" });
    await store.create({
      task: "B",
      scheduledAt: Date.now() + 120_000,
      conversationId: "c2",
      recurrence: { type: "weekly", daysOfWeek: [1, 3, 5] },
    });

    const tools = createReminderTools(store);
    const listTool = tools.find((t) => t.name === "list_reminders")!;
    const result = (await listTool.handler({}, makeContext())) as {
      reminders: Array<{ task: string; recurrence?: { type: string } }>;
      count: number;
    };
    expect(result.count).toBe(2);
    expect(result.reminders[1].recurrence?.type).toBe("weekly");
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

  it("cancel_reminder stops recurring reminders", async () => {
    const store = createReminderStore("agent-tool-cancel-recur", { provider: "memory" });
    const r = await store.create({
      task: "Stop repeating",
      scheduledAt: Date.now() + 60_000,
      conversationId: "c1",
      recurrence: { type: "daily" },
    });

    const tools = createReminderTools(store);
    const cancelTool = tools.find((t) => t.name === "cancel_reminder")!;
    const result = (await cancelTool.handler({ id: r.id }, makeContext())) as {
      ok: boolean;
      reminder: { status: string };
    };
    expect(result.ok).toBe(true);
    expect(result.reminder.status).toBe("cancelled");

    const all = await store.list();
    expect(all[0].status).toBe("cancelled");
  });
});
