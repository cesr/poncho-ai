// ---------------------------------------------------------------------------
// runConversationTurn — load-bearing helper that runs a single primary chat
// turn end-to-end against a ConversationStore: loads the conversation,
// persists the user message before the run, drives the model + tool loop
// via executeConversationTurn, periodically persists the in-flight assistant
// draft, handles approval checkpoints + continuations + cancellation, and
// finalises the conversation row on completion.
//
// This was extracted from packages/cli/src/index.ts (POST
// /api/conversations/:id/messages handler) so consumers other than the CLI
// (PonchOS, custom servers) can ship the *same* conversation lifecycle
// without copy-pasting hundreds of lines.
//
// Caller responsibilities (NOT done here):
//   - auth / ownership checks
//   - active-run dedup (one run at a time per conversation)
//   - streaming events to a real client (use opts.onEvent)
//   - triggering continuation runs after this returns continuation: true
//   - conversation title inference (helper preserves existing title)
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { AgentEvent, FileInput, Message } from "@poncho-ai/sdk";
import { createLogger } from "@poncho-ai/sdk";
import type { AgentHarness } from "../harness.js";
import type { ConversationStore } from "../state.js";
import { decodeFileInputData, deriveUploadKey } from "../upload-store.js";
import { withToolResultArchiveParam } from "./continuation.js";
import { resolveRunRequest } from "./history.js";
import {
  applyTurnMetadata,
  buildApprovalCheckpoints,
  buildAssistantMetadata,
  cloneSections,
  createTurnDraftState,
  executeConversationTurn,
  flushTurnDraft,
} from "./turn.js";

const log = createLogger("orchestrator");

export interface RunConversationTurnOpts {
  /** Initialised harness instance. */
  harness: AgentHarness;
  /** Conversation store backing the turn (typically `engine.conversations` from a StorageEngine). */
  conversationStore: ConversationStore;
  conversationId: string;
  /** The user's new message text. Required (use `""` if you only want to attach files). */
  task: string;
  /**
   * Optional file attachments (FileInput.data is base64 / data URI / https URL).
   * Files are uploaded via `harness.uploadStore` first so the persisted user
   * message references stable URLs instead of fat base64 blobs.
   */
  files?: FileInput[];
  /**
   * Extra parameters merged into runInput.parameters. Use this for recall
   * corpus, archive lookup keys, messaging metadata, etc. Do NOT include
   * `__activeConversationId`, `__ownerId`, or the tool-result-archive — the
   * helper sets those itself.
   */
  parameters?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  tenantId?: string | null;
  /** Per-event hook — called for every AgentEvent yielded by the run, in order. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface RunConversationTurnResult {
  /** runId of the most recent run started during this turn. */
  latestRunId: string;
  /** True if the run was cancelled (via abortSignal or run:cancelled event). */
  cancelled: boolean;
  /** True if the run errored. The error has been emitted via onEvent as run:error. */
  errored: boolean;
  /** True if the run requested a continuation. Caller is responsible for triggering the continuation. */
  continuation: boolean;
  /** True if the run paused at a tool-approval checkpoint. */
  checkpointed: boolean;
  contextTokens: number;
  contextWindow: number;
}

export const runConversationTurn = async (
  opts: RunConversationTurnOpts,
): Promise<RunConversationTurnResult> => {
  const conversation = await opts.conversationStore.getWithArchive(opts.conversationId);
  if (!conversation) {
    throw new Error(`Conversation not found: ${opts.conversationId}`);
  }

  const canonicalHistory = resolveRunRequest(conversation, {
    conversationId: opts.conversationId,
    messages: conversation.messages,
  });
  const shouldRebuildCanonical = canonicalHistory.shouldRebuildCanonical;
  const harnessMessages = [...canonicalHistory.messages];
  const historyMessages = [...conversation.messages];
  const preRunMessages = [...conversation.messages];

  // Build user content — upload any files first so the persisted message
  // carries stable refs instead of fat base64 blobs.
  let userContent: Message["content"] = opts.task;
  if (opts.files && opts.files.length > 0 && opts.harness.uploadStore) {
    const uploadedParts = await Promise.all(
      opts.files.map(async (f) => {
        const buf = await decodeFileInputData(f.data);
        const key = deriveUploadKey(buf, f.mediaType);
        const ref = await opts.harness.uploadStore!.put(key, buf, f.mediaType);
        return {
          type: "file" as const,
          data: ref,
          mediaType: f.mediaType,
          filename: f.filename,
        };
      }),
    );
    userContent = [
      { type: "text" as const, text: opts.task },
      ...uploadedParts,
    ];
  }

  const turnTimestamp = Date.now();
  const userMessage: Message = {
    role: "user",
    content: userContent,
    metadata: { id: randomUUID(), timestamp: turnTimestamp },
  };
  const assistantId = randomUUID();
  const draft = createTurnDraftState();

  let latestRunId = conversation.runtimeRunId ?? "";
  let runCancelled = false;
  let runContinuationMessages: Message[] | undefined;
  let cancelHarnessMessages: Message[] | undefined;
  let checkpointedRun = false;

  const buildMessages = (): Message[] => {
    const draftSections = cloneSections(draft.sections);
    if (draft.currentTools.length > 0) {
      draftSections.push({ type: "tools", content: [...draft.currentTools] });
    }
    if (draft.currentText.length > 0) {
      draftSections.push({ type: "text", content: draft.currentText });
    }
    const userTurn: Message[] = [userMessage];
    const hasDraftContent =
      draft.assistantResponse.length > 0 ||
      draft.toolTimeline.length > 0 ||
      draftSections.length > 0;
    if (!hasDraftContent) {
      return [...historyMessages, ...userTurn];
    }
    return [
      ...historyMessages,
      ...userTurn,
      {
        role: "assistant" as const,
        content: draft.assistantResponse,
        metadata: buildAssistantMetadata(draft, draftSections, {
          id: assistantId,
          timestamp: turnTimestamp,
        }),
      },
    ];
  };

  const persistDraft = async (): Promise<void> => {
    if (draft.assistantResponse.length === 0 && draft.toolTimeline.length === 0) return;
    conversation.messages = buildMessages();
    conversation.updatedAt = Date.now();
    await opts.conversationStore.update(conversation);
  };

  // Persist the user turn immediately so a crash mid-run still records what
  // the user said. Fire-and-forget — don't block the run.
  conversation.messages = [...historyMessages, userMessage];
  conversation.subagentCallbackCount = 0;
  conversation._continuationCount = undefined;
  conversation.updatedAt = Date.now();
  opts.conversationStore.update(conversation).catch((err) => {
    log.error(
      `failed to persist user turn: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  try {
    const execution = await executeConversationTurn({
      harness: opts.harness,
      runInput: {
        task: opts.task,
        conversationId: opts.conversationId,
        tenantId: opts.tenantId ?? undefined,
        parameters: withToolResultArchiveParam(
          {
            ...(opts.parameters ?? {}),
            __activeConversationId: opts.conversationId,
            __ownerId: conversation.ownerId,
          },
          conversation,
        ),
        messages: harnessMessages,
        files: opts.files && opts.files.length > 0 ? opts.files : undefined,
        abortSignal: opts.abortSignal,
      },
      initialContextTokens: conversation.contextTokens ?? 0,
      initialContextWindow: conversation.contextWindow ?? 0,
      onEvent: async (event, eventDraft) => {
        // Sync our outer draft from the executor's so persistDraft sees the latest state.
        draft.assistantResponse = eventDraft.assistantResponse;
        draft.toolTimeline = eventDraft.toolTimeline;
        draft.sections = eventDraft.sections;
        draft.currentTools = eventDraft.currentTools;
        draft.currentText = eventDraft.currentText;

        if (event.type === "run:started") {
          latestRunId = event.runId;
        }
        if (event.type === "run:cancelled") {
          runCancelled = true;
          if (event.messages) cancelHarnessMessages = event.messages;
        }
        if (event.type === "compaction:completed") {
          if (event.compactedMessages) {
            historyMessages.length = 0;
            historyMessages.push(...event.compactedMessages);
            const preservedFromHistory = historyMessages.length - 1;
            const removedCount =
              preRunMessages.length - Math.max(0, preservedFromHistory);
            const existingHistory = conversation.compactedHistory ?? [];
            conversation.compactedHistory = [
              ...existingHistory,
              ...preRunMessages.slice(0, removedCount),
            ];
          }
        }
        if (event.type === "step:completed") {
          await persistDraft();
        }
        if (event.type === "tool:approval:required") {
          const toolText = `- approval required \`${event.tool}\``;
          draft.toolTimeline.push(toolText);
          draft.currentTools.push(toolText);
          const existing = Array.isArray(conversation.pendingApprovals)
            ? conversation.pendingApprovals
            : [];
          if (!existing.some((a) => a.approvalId === event.approvalId)) {
            conversation.pendingApprovals = [
              ...existing,
              {
                approvalId: event.approvalId,
                runId: latestRunId || conversation.runtimeRunId || "",
                tool: event.tool,
                toolCallId: undefined,
                input: (event.input ?? {}) as Record<string, unknown>,
                checkpointMessages: undefined,
                baseMessageCount: historyMessages.length,
                pendingToolCalls: [],
              },
            ];
            conversation.updatedAt = Date.now();
            await opts.conversationStore.update(conversation);
          }
          await persistDraft();
        }
        if (event.type === "tool:approval:checkpoint") {
          conversation.messages = buildMessages();
          conversation.pendingApprovals = buildApprovalCheckpoints({
            approvals: event.approvals,
            runId: latestRunId,
            checkpointMessages: event.checkpointMessages,
            baseMessageCount: historyMessages.length,
            pendingToolCalls: event.pendingToolCalls,
          });
          conversation._toolResultArchive = opts.harness.getToolResultArchive(
            opts.conversationId,
          );
          conversation.updatedAt = Date.now();
          await opts.conversationStore.update(conversation);
          checkpointedRun = true;
        }
        if (event.type === "run:completed") {
          if (event.result.continuation && event.result.continuationMessages) {
            runContinuationMessages = event.result.continuationMessages;
            conversation.messages = buildMessages();
            conversation._continuationMessages = runContinuationMessages;
            conversation._harnessMessages = runContinuationMessages;
            conversation._toolResultArchive = opts.harness.getToolResultArchive(
              opts.conversationId,
            );
            conversation.runtimeRunId = latestRunId || conversation.runtimeRunId;
            if (!checkpointedRun) {
              conversation.pendingApprovals = [];
            }
            if ((event.result.contextTokens ?? 0) > 0) {
              conversation.contextTokens = event.result.contextTokens!;
            }
            if ((event.result.contextWindow ?? 0) > 0) {
              conversation.contextWindow = event.result.contextWindow!;
            }
            conversation.updatedAt = Date.now();
            await opts.conversationStore.update(conversation);
          }
        }

        if (opts.onEvent) {
          await opts.onEvent(event);
        }
      },
    });

    flushTurnDraft(draft);
    latestRunId = execution.latestRunId || latestRunId;

    if (!checkpointedRun && !runContinuationMessages) {
      conversation.messages = buildMessages();
      applyTurnMetadata(
        conversation,
        {
          latestRunId,
          contextTokens: execution.runContextTokens,
          contextWindow: execution.runContextWindow,
          harnessMessages: execution.runHarnessMessages,
          toolResultArchive: opts.harness.getToolResultArchive(opts.conversationId),
        },
        { shouldRebuildCanonical },
      );
      await opts.conversationStore.update(conversation);
    }

    return {
      latestRunId,
      cancelled: runCancelled,
      errored: false,
      continuation: !!runContinuationMessages,
      checkpointed: checkpointedRun,
      contextTokens: execution.runContextTokens,
      contextWindow: execution.runContextWindow,
    };
  } catch (error) {
    flushTurnDraft(draft);
    const aborted = opts.abortSignal?.aborted === true;
    if (aborted || runCancelled) {
      if (
        draft.assistantResponse.length > 0 ||
        draft.toolTimeline.length > 0 ||
        draft.sections.length > 0
      ) {
        conversation.messages = buildMessages();
        applyTurnMetadata(
          conversation,
          {
            latestRunId,
            contextTokens: 0,
            contextWindow: 0,
            harnessMessages: cancelHarnessMessages,
            toolResultArchive: opts.harness.getToolResultArchive(opts.conversationId),
          },
          { shouldRebuildCanonical: true },
        );
        await opts.conversationStore.update(conversation);
      }
      if (!checkpointedRun) {
        // Clear any pending approvals — the run was cancelled, they're stale.
        const fresh = await opts.conversationStore.get(opts.conversationId);
        if (fresh && Array.isArray(fresh.pendingApprovals) && fresh.pendingApprovals.length > 0) {
          fresh.pendingApprovals = [];
          await opts.conversationStore.update(fresh);
        }
      }
      return {
        latestRunId,
        cancelled: true,
        errored: false,
        continuation: false,
        checkpointed: checkpointedRun,
        contextTokens: 0,
        contextWindow: 0,
      };
    }

    // Real error: emit run:error, persist whatever we have.
    const errorEvent: AgentEvent = {
      type: "run:error",
      runId: latestRunId || "run_unknown",
      error: {
        code: "RUN_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
    if (opts.onEvent) {
      try {
        await opts.onEvent(errorEvent);
      } catch (hookErr) {
        log.error(
          `onEvent threw on run:error: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
        );
      }
    }
    if (
      draft.assistantResponse.length > 0 ||
      draft.toolTimeline.length > 0 ||
      draft.sections.length > 0
    ) {
      conversation.messages = buildMessages();
      conversation.updatedAt = Date.now();
      await opts.conversationStore.update(conversation);
    }
    return {
      latestRunId,
      cancelled: false,
      errored: true,
      continuation: false,
      checkpointed: checkpointedRun,
      contextTokens: 0,
      contextWindow: 0,
    };
  }
};
