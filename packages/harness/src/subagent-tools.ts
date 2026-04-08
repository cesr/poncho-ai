import { defineTool, type ToolContext, type ToolDefinition } from "@poncho-ai/sdk";
import type { SubagentManager } from "./subagent-manager.js";

export const createSubagentTools = (
  manager: SubagentManager,
): ToolDefinition[] => [
  defineTool({
    name: "spawn_subagent",
    description:
      "Spawn a subagent to work on a task in the background. Returns immediately with a subagent ID. " +
      "The subagent runs independently and its result will be delivered to you as a message in the " +
      "conversation when it completes.\n\n" +
      "Guidelines:\n" +
      "- Spawn all needed subagents in a SINGLE response (they run concurrently), then end your turn with a brief message to the user.\n" +
      "- Do NOT spawn more subagents in follow-up steps. Wait for results to be delivered before deciding if more work is needed.\n" +
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
    handler: async (input: Record<string, unknown>, context: ToolContext) => {
      const task = typeof input.task === "string" ? input.task : "";
      if (!task.trim()) {
        return { error: "task is required" };
      }
      const conversationId = context.conversationId;
      if (!conversationId) {
        return { error: "no active conversation to spawn subagent from" };
      }
      const ownerId = typeof context.parameters.__ownerId === "string"
        ? context.parameters.__ownerId
        : "anonymous";
      const { subagentId } = await manager.spawn({
        task: task.trim(),
        parentConversationId: conversationId,
        ownerId,
        tenantId: context.tenantId,
      });
      return { subagentId, status: "running" };
    },
  }),

  defineTool({
    name: "message_subagent",
    description:
      "Send a follow-up message to a completed or stopped subagent. The subagent restarts in the " +
      "background and its result will be delivered to you as a message when it completes. " +
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
      const { subagentId: id } = await manager.sendMessage(subagentId, message.trim());
      return { subagentId: id, status: "running" };
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
    handler: async (_input: Record<string, unknown>, context: ToolContext) => {
      const conversationId = context.conversationId;
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
