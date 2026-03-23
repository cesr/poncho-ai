import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { ReminderStore, ReminderStatus } from "./reminder-store.js";

const VALID_STATUSES: ReminderStatus[] = ["pending", "cancelled"];

export const createReminderTools = (store: ReminderStore): ToolDefinition[] => [
  defineTool({
    name: "set_reminder",
    description:
      "Set a one-time reminder that will fire at the specified date and time. " +
      "Use this when the user asks to be reminded about something. " +
      "The datetime must be an ISO 8601 string in the future. " +
      "When the reminder fires, the task message will be delivered to the user.",
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
            "ISO 8601 datetime for when the reminder should fire (e.g. '2026-03-23T09:00:00Z')",
        },
        timezone: {
          type: "string",
          description:
            "IANA timezone for interpreting the datetime if it lacks an offset (e.g. 'America/New_York'). Defaults to UTC.",
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

      const conversationId = context.conversationId || context.runId;
      const reminder = await store.create({
        task,
        scheduledAt,
        timezone,
        conversationId,
      });

      return {
        ok: true,
        reminder: {
          id: reminder.id,
          task: reminder.task,
          scheduledAt: new Date(reminder.scheduledAt).toISOString(),
          timezone: reminder.timezone ?? "UTC",
          status: reminder.status,
        },
      };
    },
  }),

  defineTool({
    name: "list_reminders",
    description:
      "List reminders for this agent. Returns all reminders by default; " +
      "use the status filter to show only pending or cancelled ones. " +
      "Fired reminders are automatically deleted after delivery.",
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
    handler: async (input) => {
      let reminders = await store.list();
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
        })),
        count: reminders.length,
      };
    },
  }),

  defineTool({
    name: "cancel_reminder",
    description: "Cancel a pending reminder by its ID.",
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
    handler: async (input) => {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      if (!id) throw new Error("id is required");
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
