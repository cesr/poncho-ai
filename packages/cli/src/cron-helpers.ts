import { randomUUID } from "node:crypto";
import {
  executeConversationTurn,
  flushTurnDraft,
  buildAssistantMetadata,
  TOOL_RESULT_ARCHIVE_PARAM,
  type AgentHarness,
  type Conversation,
  type ConversationStore,
} from "@poncho-ai/harness";
import type { AgentEvent, Message } from "@poncho-ai/sdk";

export const normalizeMessageForClient = (message: Message): Message | null => {
  // Hide tool-role and system-role messages from the web UI — they are
  // internal harness bookkeeping that leaks into conv.messages when
  // _harnessMessages are used as canonical history.
  if (message.role === "tool" || message.role === "system") {
    return null;
  }
  if (message.role !== "assistant" || typeof message.content !== "string") {
    return message;
  }
  try {
    const parsed = JSON.parse(message.content) as Record<string, unknown>;
    const toolCalls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : undefined;
    if (toolCalls) {
      const text = typeof parsed.text === "string" ? parsed.text : "";
      const meta = { ...(message.metadata ?? {}) } as Record<string, unknown>;
      if (!meta.sections && toolCalls.length > 0) {
        const toolLabels = toolCalls.map((tc: Record<string, unknown>) => {
          const name = typeof tc.name === "string" ? tc.name : "tool";
          return `✓ ${name}`;
        });
        const sections: { type: string; content: string | string[] }[] = [];
        if (toolLabels.length > 0) sections.push({ type: "tools", content: toolLabels });
        if (text) sections.push({ type: "text", content: text });
        meta.sections = sections;
      }
      return {
        ...message,
        content: text,
        metadata: meta as Message["metadata"],
      };
    }
  } catch {
    // Keep original assistant content when it's plain text or non-JSON.
  }
  return message;
};

// ── Shared cron helpers ──────────────────────────────────────────
// Used by both the HTTP /api/cron endpoint and the local-dev scheduler.

export type CronRunResult = {
  response: string;
  steps: number;
  assistantMetadata?: Message["metadata"];
  hasContent: boolean;
  contextTokens: number;
  contextWindow: number;
  harnessMessages?: Message[];
  toolResultArchive?: Conversation["_toolResultArchive"];
  latestRunId: string;
  continuation: boolean;
  continuationMessages?: Message[];
  /** Stable id for the user-turn message persisted by buildCronMessages/appendCronTurn. */
  userMessageId: string;
  /** Timestamp shared by user and assistant messages of this turn. */
  turnTimestamp: number;
};

export const runCronAgent = async (
  harnessRef: AgentHarness,
  task: string,
  conversationId: string,
  historyMessages: Message[],
  toolResultArchive?: Conversation["_toolResultArchive"],
  onEvent?: (event: AgentEvent) => void | Promise<void>,
): Promise<CronRunResult> => {
  const turnTimestamp = Date.now();
  const userMessageId = randomUUID();
  const assistantId = randomUUID();
  const execution = await executeConversationTurn({
    harness: harnessRef,
    runInput: {
      task,
      conversationId,
      parameters: {
        __activeConversationId: conversationId,
        [TOOL_RESULT_ARCHIVE_PARAM]: toolResultArchive ?? {},
      },
      messages: historyMessages,
    },
    onEvent,
  });
  flushTurnDraft(execution.draft);
  const hasContent = execution.draft.assistantResponse.length > 0 || execution.draft.toolTimeline.length > 0;
  const assistantMetadata = buildAssistantMetadata(execution.draft, undefined, {
    id: assistantId,
    timestamp: turnTimestamp,
  });
  return {
    response: execution.draft.assistantResponse,
    steps: execution.runSteps,
    assistantMetadata,
    hasContent,
    contextTokens: execution.runContextTokens,
    contextWindow: execution.runContextWindow,
    harnessMessages: execution.runHarnessMessages,
    toolResultArchive: harnessRef.getToolResultArchive(conversationId),
    latestRunId: execution.latestRunId,
    continuation: execution.runContinuation,
    continuationMessages: execution.runContinuationMessages,
    userMessageId,
    turnTimestamp,
  };
};

export const buildCronMessages = (
  task: string,
  historyMessages: Message[],
  result: CronRunResult,
): Message[] => [
  ...historyMessages,
  {
    role: "user" as const,
    content: task,
    metadata: { id: result.userMessageId, timestamp: result.turnTimestamp },
  },
  ...(result.hasContent
    ? [{ role: "assistant" as const, content: result.response, metadata: result.assistantMetadata }]
    : []),
];

/** Append a cron turn to a freshly-fetched conversation (avoids overwriting concurrent writes). */
export const appendCronTurn = (conv: Conversation, task: string, result: CronRunResult): void => {
  conv.messages.push(
    {
      role: "user" as const,
      content: task,
      metadata: { id: result.userMessageId, timestamp: result.turnTimestamp },
    },
    ...(result.hasContent
      ? [{ role: "assistant" as const, content: result.response, metadata: result.assistantMetadata }]
      : []),
  );
};

export const MAX_PRUNE_PER_RUN = 25;

/** Delete old cron conversations beyond `maxRuns`, capped to avoid API storms on catch-up. */
export const pruneCronConversations = async (
  store: ConversationStore,
  ownerId: string,
  jobName: string,
  maxRuns: number,
): Promise<number> => {
  const summaries = await store.listSummaries(ownerId);
  const cronPrefix = `[cron] ${jobName} `;
  const cronSummaries = summaries
    .filter((s) => s.title?.startsWith(cronPrefix))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  if (cronSummaries.length <= maxRuns) return 0;

  const toDelete = cronSummaries.slice(maxRuns, maxRuns + MAX_PRUNE_PER_RUN);
  let deleted = 0;
  for (const s of toDelete) {
    try {
      if (await store.delete(s.conversationId)) deleted++;
    } catch { /* best-effort per entry */ }
  }
  return deleted;
};
