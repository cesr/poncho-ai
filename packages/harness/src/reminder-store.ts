import type { StateConfig } from "./state.js";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type ReminderStatus = "pending" | "fired" | "cancelled";

export type RecurrenceType = "daily" | "weekly" | "monthly" | "cron";

export interface Recurrence {
  type: RecurrenceType;
  /** Repeat every N units (e.g. every 2 days). Defaults to 1. */
  interval?: number;
  /** For weekly: which days (0=Sun … 6=Sat). */
  daysOfWeek?: number[];
  /** For type "cron": a 5-field cron expression. */
  expression?: string;
  /** Stop recurring after this epoch-ms timestamp. */
  endsAt?: number;
  /** Stop recurring after this many total firings. */
  maxOccurrences?: number;
}

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
  recurrence?: Recurrence | null;
  occurrenceCount?: number;
}

export interface ReminderCreateInput {
  task: string;
  scheduledAt: number;
  timezone?: string;
  conversationId: string;
  ownerId?: string;
  tenantId?: string | null;
  recurrence?: Recurrence | null;
}

export interface ReminderStore {
  list(): Promise<Reminder[]>;
  create(input: ReminderCreateInput): Promise<Reminder>;
  update(id: string, fields: { scheduledAt?: number; occurrenceCount?: number; status?: ReminderStatus }): Promise<Reminder>;
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

  async create(input: ReminderCreateInput): Promise<Reminder> {
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
      recurrence: input.recurrence ?? null,
      occurrenceCount: 0,
    };
    this.reminders = pruneStale(this.reminders);
    this.reminders.push(reminder);
    return reminder;
  }

  async update(id: string, fields: { scheduledAt?: number; occurrenceCount?: number; status?: ReminderStatus }): Promise<Reminder> {
    const reminder = this.reminders.find((r) => r.id === id);
    if (!reminder) throw new Error(`Reminder "${id}" not found`);
    if (fields.scheduledAt !== undefined) reminder.scheduledAt = fields.scheduledAt;
    if (fields.occurrenceCount !== undefined) reminder.occurrenceCount = fields.occurrenceCount;
    if (fields.status !== undefined) reminder.status = fields.status;
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
// Recurrence helpers
// ---------------------------------------------------------------------------

/**
 * Given a reminder's current scheduledAt and its recurrence config, compute the
 * next fire time. Returns null if the recurrence is exhausted (maxOccurrences
 * reached or endsAt passed).
 */
export const computeNextOccurrence = (reminder: Reminder): number | null => {
  const rec = reminder.recurrence;
  if (!rec) return null;

  const fired = (reminder.occurrenceCount ?? 0) + 1;
  if (rec.maxOccurrences && fired >= rec.maxOccurrences) return null;

  const interval = rec.interval ?? 1;
  const prev = reminder.scheduledAt;
  let next: number;

  switch (rec.type) {
    case "daily": {
      next = prev + interval * 24 * 60 * 60 * 1000;
      break;
    }
    case "weekly": {
      if (rec.daysOfWeek && rec.daysOfWeek.length > 0) {
        // Advance to next matching day-of-week
        const d = new Date(prev);
        const days = [...rec.daysOfWeek].sort((a, b) => a - b);
        const currentDay = d.getUTCDay();
        // Find the next day in the list that is strictly after currentDay
        let nextDay = days.find((day) => day > currentDay);
        if (nextDay !== undefined) {
          // Same week
          const delta = nextDay - currentDay;
          next = prev + delta * 24 * 60 * 60 * 1000;
        } else {
          // Wrap to next week (+ interval weeks if interval > 1)
          const delta = (7 * interval) - currentDay + days[0];
          next = prev + delta * 24 * 60 * 60 * 1000;
        }
      } else {
        // No specific days — just advance by N weeks
        next = prev + interval * 7 * 24 * 60 * 60 * 1000;
      }
      break;
    }
    case "monthly": {
      const d = new Date(prev);
      d.setUTCMonth(d.getUTCMonth() + interval);
      next = d.getTime();
      break;
    }
    case "cron": {
      // Minimal cron: parse 5-field expression and find the next matching
      // minute after `prev`. We support basic values, ranges, steps and *.
      if (!rec.expression) return null;
      const parsed = parseCronExpression(rec.expression);
      if (!parsed) return null;
      next = nextCronOccurrence(prev, parsed);
      if (next <= prev) return null; // safety
      break;
    }
    default:
      return null;
  }

  if (rec.endsAt && next > rec.endsAt) return null;
  return next;
};

// ---------------------------------------------------------------------------
// Minimal cron parser (5-field: min hour dom month dow)
// ---------------------------------------------------------------------------

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

const expandField = (field: string, min: number, max: number): Set<number> | null => {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      if (isNaN(lo) || isNaN(hi)) return null;
      for (let i = lo; i <= hi; i += step) values.add(i);
    } else {
      const n = parseInt(range, 10);
      if (isNaN(n)) return null;
      values.add(n);
    }
  }
  return values;
};

const parseCronExpression = (expr: string): CronFields | null => {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = expandField(parts[0], 0, 59);
  const hours = expandField(parts[1], 0, 23);
  const daysOfMonth = expandField(parts[2], 1, 31);
  const months = expandField(parts[3], 1, 12);
  const daysOfWeek = expandField(parts[4], 0, 6);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
  return { minutes, hours, daysOfMonth, months, daysOfWeek };
};

const nextCronOccurrence = (afterMs: number, fields: CronFields): number => {
  // Start from the minute after `afterMs`
  const d = new Date(afterMs);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);

  // Cap search to ~1 year to avoid infinite loops
  const limit = afterMs + 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() < limit) {
    if (
      fields.months.has(d.getUTCMonth() + 1) &&
      fields.daysOfMonth.has(d.getUTCDate()) &&
      fields.daysOfWeek.has(d.getUTCDay()) &&
      fields.hours.has(d.getUTCHours()) &&
      fields.minutes.has(d.getUTCMinutes())
    ) {
      return d.getTime();
    }
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return afterMs; // no match within a year — treat as exhausted
};

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
