import { defineTool, type Message, type ToolDefinition, getTextContent } from "@poncho-ai/sdk";
import type { SubagentManager, SubagentResult } from "./subagent-manager.js";

const LAST_MESSAGES_TO_RETURN = 10;

const summarizeResult = (r: SubagentResult): Record<string, unknown> => {
  const summary: Record<string, unknown> = {
    subagentId: r.subagentId,
    status: r.status,
  };
  if (r.result) {
    summary.result = {
      status: r.result.status,
      response: r.result.response,
      steps: r.result.steps,
      duration: r.result.duration,
    };
  }
  if (r.error) {
    summary.error = r.error;
  }
  if (r.latestMessages && r.latestMessages.length > 0) {
    summary.latestMessages = r.latestMessages
      .slice(-LAST_MESSAGES_TO_RETURN)
      .map((m: Message) => ({
        role: m.role,
        content: getTextContent(m).slice(0, 2000),
      }));
  }
  return summary;
};

export const createSubagentTools = (
  manager: SubagentManager,
  getConversationId: () => string | undefined,
  getOwnerId: () => string,
): ToolDefinition[] => [
  defineTool({
    name: "spawn_subagent",
    description:
      "Spawn a subagent to work on a task and wait for it to finish. The subagent is a full copy of " +
      "yourself running in its own conversation context with access to the same tools (except memory writes). " +
      "This call blocks until the subagent completes and returns its result.\n\n" +
      "Guidelines:\n" +
      "- Use subagents to parallelize work: call spawn_subagent multiple times in one response for independent sub-tasks -- they run concurrently.\n" +
      "- Prefer doing work yourself for simple or quick tasks. Spawn subagents for substantial, self-contained work.\n" +
      "- The subagent has no memory of your conversation -- write thorough, self-contained instructions in the task.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Thorough, self-contained instructions for the subagent. Include all relevant context, " +
            "goals, and constraints -- the subagent starts with zero prior conversation history.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const task = typeof input.task === "string" ? input.task : "";
      if (!task.trim()) {
        return { error: "task is required" };
      }
      const conversationId = getConversationId();
      if (!conversationId) {
        return { error: "no active conversation to spawn subagent from" };
      }
      const result = await manager.spawn({
        task: task.trim(),
        parentConversationId: conversationId,
        ownerId: getOwnerId(),
      });
      return summarizeResult(result);
    },
  }),

  defineTool({
    name: "message_subagent",
    description:
      "Send a follow-up message to a completed or stopped subagent and wait for it to finish. " +
      "This restarts the subagent with the new message and blocks until it completes. " +
      "Only works when the subagent is not currently running.",
    inputSchema: {
      type: "object",
      properties: {
        subagent_id: {
          type: "string",
          description: "The subagent ID (from spawn_subagent result or list_subagents).",
        },
        message: {
          type: "string",
          description: "The follow-up instructions or message to send.",
        },
      },
      required: ["subagent_id", "message"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const subagentId = typeof input.subagent_id === "string" ? input.subagent_id : "";
      const message = typeof input.message === "string" ? input.message : "";
      if (!subagentId || !message.trim()) {
        return { error: "subagent_id and message are required" };
      }
      const result = await manager.sendMessage(subagentId, message.trim());
      return summarizeResult(result);
    },
  }),

  defineTool({
    name: "stop_subagent",
    description:
      "Stop a running subagent. The subagent's conversation is preserved but it will stop processing. " +
      "Use this to cancel work that is no longer needed.",
    inputSchema: {
      type: "object",
      properties: {
        subagent_id: {
          type: "string",
          description: "The subagent ID (from spawn_subagent result or list_subagents).",
        },
      },
      required: ["subagent_id"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const subagentId = typeof input.subagent_id === "string" ? input.subagent_id : "";
      if (!subagentId) {
        return { error: "subagent_id is required" };
      }
      await manager.stop(subagentId);
      return { message: `Subagent "${subagentId}" has been stopped.` };
    },
  }),

  defineTool({
    name: "list_subagents",
    description:
      "List all subagents that have been spawned in this conversation. Returns each subagent's ID, " +
      "original task, current status, and message count. Use this to look up subagent IDs before " +
      "calling message_subagent or stop_subagent.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const conversationId = getConversationId();
      if (!conversationId) {
        return { error: "no active conversation" };
      }
      const subagents = await manager.list(conversationId);
      if (subagents.length === 0) {
        return { message: "No subagents have been spawned in this conversation." };
      }
      return { subagents };
    },
  }),
];
