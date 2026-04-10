import type { StateConfig } from "./state.js";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type ReminderStatus = "pending" | "fired" | "cancelled";

export interface Reminder {
  id: string;
  task: string;
  scheduledAt: number;
  timezone?: string;
  status: ReminderStatus;
  createdAt: number;
  conversationId: string;
  ownerId?: string;
  tenantId?: string | null;
}

export interface ReminderStore {
  list(): Promise<Reminder[]>;
  create(input: {
    task: string;
    scheduledAt: number;
    timezone?: string;
    conversationId: string;
    ownerId?: string;
    tenantId?: string | null;
  }): Promise<Reminder>;
  cancel(id: string): Promise<Reminder>;
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STALE_CANCELLED_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Remove all fired reminders and cancelled reminders older than 7 days. */
const pruneStale = (reminders: Reminder[]): Reminder[] => {
  const cutoff = Date.now() - STALE_CANCELLED_MS;
  return reminders.filter(
    (r) =>
      r.status === "pending" ||
      (r.status === "cancelled" && r.createdAt > cutoff),
  );
};

const generateId = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 8);

// ---------------------------------------------------------------------------
// InMemoryReminderStore
// ---------------------------------------------------------------------------

class InMemoryReminderStore implements ReminderStore {
  private reminders: Reminder[] = [];

  async list(): Promise<Reminder[]> {
    this.reminders = pruneStale(this.reminders);
    return [...this.reminders];
  }

  async create(input: {
    task: string;
    scheduledAt: number;
    timezone?: string;
    conversationId: string;
    ownerId?: string;
    tenantId?: string | null;
  }): Promise<Reminder> {
    const reminder: Reminder = {
      id: generateId(),
      task: input.task,
      scheduledAt: input.scheduledAt,
      timezone: input.timezone,
      status: "pending",
      createdAt: Date.now(),
      conversationId: input.conversationId,
      ownerId: input.ownerId,
      tenantId: input.tenantId,
    };
    this.reminders = pruneStale(this.reminders);
    this.reminders.push(reminder);
    return reminder;
  }

  async cancel(id: string): Promise<Reminder> {
    const reminder = this.reminders.find((r) => r.id === id);
    if (!reminder) throw new Error(`Reminder "${id}" not found`);
    if (reminder.status !== "pending") {
      throw new Error(`Reminder "${id}" is already ${reminder.status}`);
    }
    reminder.status = "cancelled";
    return reminder;
  }

  async delete(id: string): Promise<void> {
    this.reminders = this.reminders.filter((r) => r.id !== id);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createReminderStore = (
  _agentId: string,
  _config?: StateConfig,
  _options?: { workingDir?: string },
): ReminderStore => {
  return new InMemoryReminderStore();
};
