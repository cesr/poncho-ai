import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { ReminderStore, ReminderStatus, Recurrence, RecurrenceType } from "./reminder-store.js";

const VALID_STATUSES: ReminderStatus[] = ["pending", "cancelled"];
const VALID_RECURRENCE_TYPES: RecurrenceType[] = ["daily", "weekly", "monthly", "cron"];

export const createReminderTools = (store: ReminderStore): ToolDefinition[] => [
  defineTool({
    name: "set_reminder",
    description:
      "Set a reminder that will fire at the specified date and time. " +
      "Use this when the user asks to be reminded about something. " +
      "The datetime must be an ISO 8601 string in the future. " +
      "When the reminder fires, the task message will be delivered to the user. " +
      "Supports optional recurrence for recurring reminders (daily, weekly, monthly, or cron).",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "What to remind about",
        },
        datetime: {
          type: "string",
          description:
            "ISO 8601 datetime for when the reminder should first fire (e.g. '2026-03-23T09:00:00Z')",
        },
        timezone: {
          type: "string",
          description:
            "IANA timezone for interpreting the datetime if it lacks an offset (e.g. 'America/New_York'). Defaults to UTC.",
        },
        recurrence: {
          type: "object",
          description:
            "Optional. Set this to make the reminder repeat. Omit for a one-time reminder.",
          properties: {
            type: {
              type: "string",
              enum: VALID_RECURRENCE_TYPES,
              description:
                "How often to repeat: 'daily', 'weekly', 'monthly', or 'cron'.",
            },
            interval: {
              type: "number",
              description:
                "Repeat every N units (e.g. 2 = every 2 days/weeks/months). Defaults to 1.",
            },
            daysOfWeek: {
              type: "array",
              items: { type: "number" },
              description:
                "For weekly: which days to fire (0=Sunday, 1=Monday, ..., 6=Saturday).",
            },
            expression: {
              type: "string",
              description:
                "For type 'cron': a 5-field cron expression (e.g. '0 9 * * 1-5' for weekdays at 9am).",
            },
            endsAt: {
              type: "string",
              description:
                "ISO 8601 datetime after which the recurrence should stop.",
            },
            maxOccurrences: {
              type: "number",
              description:
                "Maximum number of times the reminder should fire before stopping.",
            },
          },
          required: ["type"],
          additionalProperties: false,
        },
      },
      required: ["task", "datetime"],
      additionalProperties: false,
    },
    handler: async (input, context) => {
      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (!task) throw new Error("task is required");

      const datetimeStr = typeof input.datetime === "string" ? input.datetime.trim() : "";
      if (!datetimeStr) throw new Error("datetime is required");

      const timezone = typeof input.timezone === "string" ? input.timezone.trim() : undefined;

      let scheduledAt: number;
      if (timezone && !datetimeStr.includes("Z") && !/[+-]\d{2}:\d{2}$/.test(datetimeStr)) {
        try {
          const formatted = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }).format(new Date());
          void formatted;
        } catch {
          throw new Error(`Invalid timezone: "${timezone}"`);
        }
        const baseDate = new Date(datetimeStr);
        if (isNaN(baseDate.getTime())) {
          throw new Error(`Invalid datetime: "${datetimeStr}"`);
        }
        const utcStr = baseDate.toLocaleString("en-US", { timeZone: "UTC" });
        const tzStr = baseDate.toLocaleString("en-US", { timeZone: timezone });
        const offsetMs = new Date(utcStr).getTime() - new Date(tzStr).getTime();
        scheduledAt = baseDate.getTime() + offsetMs;
      } else {
        const parsed = new Date(datetimeStr);
        if (isNaN(parsed.getTime())) {
          throw new Error(`Invalid datetime: "${datetimeStr}"`);
        }
        scheduledAt = parsed.getTime();
      }

      if (scheduledAt <= Date.now()) {
        throw new Error("Reminder datetime must be in the future");
      }

      // Parse recurrence if provided
      let recurrence: Recurrence | null = null;
      if (input.recurrence && typeof input.recurrence === "object") {
        const rec = input.recurrence as Record<string, unknown>;
        const recType = rec.type as string;
        if (!VALID_RECURRENCE_TYPES.includes(recType as RecurrenceType)) {
          throw new Error(`Invalid recurrence type: "${recType}". Must be one of: ${VALID_RECURRENCE_TYPES.join(", ")}`);
        }
        recurrence = { type: recType as RecurrenceType };
        if (rec.interval !== undefined) {
          const interval = Number(rec.interval);
          if (!Number.isInteger(interval) || interval < 1) {
            throw new Error("recurrence.interval must be a positive integer");
          }
          recurrence.interval = interval;
        }
        if (rec.daysOfWeek !== undefined) {
          if (!Array.isArray(rec.daysOfWeek)) throw new Error("recurrence.daysOfWeek must be an array");
          const days = (rec.daysOfWeek as unknown[]).map(Number);
          if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
            throw new Error("recurrence.daysOfWeek values must be integers 0-6");
          }
          recurrence.daysOfWeek = days;
        }
        if (rec.expression !== undefined) {
          if (typeof rec.expression !== "string") throw new Error("recurrence.expression must be a string");
          recurrence.expression = rec.expression;
        }
        if (rec.endsAt !== undefined) {
          const endsAtDate = new Date(rec.endsAt as string);
          if (isNaN(endsAtDate.getTime())) {
            throw new Error(`Invalid recurrence.endsAt: "${rec.endsAt}"`);
          }
          recurrence.endsAt = endsAtDate.getTime();
        }
        if (rec.maxOccurrences !== undefined) {
          const max = Number(rec.maxOccurrences);
          if (!Number.isInteger(max) || max < 1) {
            throw new Error("recurrence.maxOccurrences must be a positive integer");
          }
          recurrence.maxOccurrences = max;
        }
      }

      const conversationId = context.conversationId || context.runId;
      const reminder = await store.create({
        task,
        scheduledAt,
        timezone,
        conversationId,
        tenantId: context.tenantId,
        recurrence,
      });

      return {
        ok: true,
        reminder: {
          id: reminder.id,
          task: reminder.task,
          scheduledAt: new Date(reminder.scheduledAt).toISOString(),
          timezone: reminder.timezone ?? "UTC",
          status: reminder.status,
          recurrence: reminder.recurrence ?? undefined,
          occurrenceCount: reminder.occurrenceCount ?? 0,
        },
      };
    },
  }),

  defineTool({
    name: "list_reminders",
    description:
      "List reminders for this agent. Returns all reminders by default; " +
      "use the status filter to show only pending or cancelled ones. " +
      "Fired one-time reminders are automatically deleted after delivery. " +
      "Recurring reminders stay active and show their recurrence config and fire count.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: VALID_STATUSES,
          description: "Filter by status (omit to list all)",
        },
      },
      additionalProperties: false,
    },
    handler: async (input, context) => {
      let reminders = await store.list();
      // Tenant-scoped: only show reminders belonging to the current tenant
      if (context.tenantId) {
        reminders = reminders.filter((r) => r.tenantId === context.tenantId);
      }
      const status = typeof input.status === "string" ? input.status : undefined;
      if (status && VALID_STATUSES.includes(status as ReminderStatus)) {
        reminders = reminders.filter((r) => r.status === status);
      }
      return {
        reminders: reminders.map((r) => ({
          id: r.id,
          task: r.task,
          scheduledAt: new Date(r.scheduledAt).toISOString(),
          timezone: r.timezone ?? "UTC",
          status: r.status,
          createdAt: new Date(r.createdAt).toISOString(),
          recurrence: r.recurrence ?? undefined,
          occurrenceCount: r.occurrenceCount ?? 0,
        })),
        count: reminders.length,
      };
    },
  }),

  defineTool({
    name: "cancel_reminder",
    description:
      "Cancel a pending reminder by its ID. " +
      "This works for both one-time and recurring reminders — " +
      "cancelling a recurring reminder stops all future occurrences.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "ID of the reminder to cancel",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (input, context) => {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) throw new Error("id is required");
      // Validate tenant ownership before cancelling
      if (context.tenantId) {
        const all = await store.list();
        const target = all.find((r) => r.id === id);
        if (target && target.tenantId !== context.tenantId) {
          throw new Error("Reminder not found");
        }
      }
      const cancelled = await store.cancel(id);
      return {
        ok: true,
        reminder: {
          id: cancelled.id,
          task: cancelled.task,
          scheduledAt: new Date(cancelled.scheduledAt).toISOString(),
          status: cancelled.status,
        },
      };
    },
  }),
];
