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
import {
  appendEntriesSafe,
  assistantMessageEntry,
  compactionEntry,
  harnessMessageEntries,
  newHarnessMessagesThisTurn,
  userMessageEntry,
  verifyEntriesParity,
} from "./entries-dual-write.js";

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
  /**
   * Forwarded to `RunInput.disablePromptCache`. Set true for one-shot
   * turns with no follow-up coming (cron-fired jobs, etc.) so the
   * harness skips the Anthropic cache write.
   */
  disablePromptCache?: boolean;
  /**
   * Forwarded to `RunInput.suppressTelemetry`. Set true to emit no telemetry
   * for this run (e.g. an incognito / telemetry-off turn) even on a harness
   * built with an OTLP exporter attached.
   */
  suppressTelemetry?: boolean;
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

  // `incomplete: true` (the default) marks the trailing assistant message as
  // an in-flight DRAFT — content for a turn that hasn't finished. A consumer
  // (e.g. PonchOS's WS snapshot) uses this to strip the draft from the
  // authoritative snapshot: the in-flight turn is delivered by the event
  // stream instead, so the snapshot and the event log never both carry it
  // (no reconnect duplication). The three TERMINAL writes (normal finalize,
  // cancelled, errored) pass `incomplete: false` — at that point the turn is
  // done and the assistant message is authoritative.
  const buildMessages = (incomplete = true): Message[] => {
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
        metadata: {
          ...buildAssistantMetadata(draft, draftSections, {
            id: assistantId,
            timestamp: turnTimestamp,
          }),
          // Only stamp the flag when true; finalize omits it so completed
          // assistants stay clean (no `incomplete: false` noise on the row).
          ...(incomplete ? { incomplete: true } : {}),
        },
      },
    ];
  };

  const persistDraft = async (): Promise<void> => {
    if (draft.assistantResponse.length === 0 && draft.toolTimeline.length === 0) return;
    conversation.messages = buildMessages();
    conversation.updatedAt = Date.now();
    await opts.conversationStore.update(conversation);
  };

  // Snapshot the harness-message array as it stood BEFORE this turn so the
  // finalize path can diff out the messages this turn appended (dual-write).
  const preTurnHarnessMessages = conversation._harnessMessages
    ? [...conversation._harnessMessages]
    : undefined;
  // The stable per-turn id used to group dual-write entries.
  const turnId = assistantId;

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

  // DUAL-WRITE (additive, mirrors the user-turn blob write above): append a
  // user_message entry. Fire-and-forget — never blocks or breaks the turn.
  void appendEntriesSafe(
    opts.conversationStore,
    conversation,
    [userMessageEntry(userMessage, turnId)],
    log,
  );

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
        disablePromptCache: opts.disablePromptCache,
        suppressTelemetry: opts.suppressTelemetry,
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

            // DUAL-WRITE (mirrors the compactedHistory blob write above): the
            // compacted array is [summaryMessage, ...keptMessages]. BEST-EFFORT
            // firstKeptSeq: the entry-log seqs of the kept harness messages
            // aren't known here, so we derive a sentinel from the kept-count by
            // reading the current max harness_message seq and pointing at the
            // tail. We read the existing entries to compute it.
            const summaryMessage = event.compactedMessages[0];
            const keptCount = Math.max(0, event.compactedMessages.length - 1);
            if (summaryMessage) {
              void (async () => {
                try {
                  const existing = await opts.conversationStore.readEntries(
                    opts.conversationId,
                    { types: ["harness_message"] },
                  );
                  // firstKeptSeq = seq of the (keptCount)-th-from-last existing
                  // harness message, so rebuild keeps exactly that many.
                  const harnessSeqs = existing.map((e) => e.seq);
                  const firstKeptSeq =
                    harnessSeqs.length >= keptCount && keptCount > 0
                      ? harnessSeqs[harnessSeqs.length - keptCount]!
                      : (harnessSeqs[harnessSeqs.length - 1] ?? 0) + 1;
                  await appendEntriesSafe(
                    opts.conversationStore,
                    conversation,
                    [
                      compactionEntry(summaryMessage, firstKeptSeq, {
                        tokensBefore: conversation.contextTokens,
                      }),
                    ],
                    log,
                  );
                } catch (err) {
                  log.error(
                    `[entries-dual-write] compaction append failed: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                  );
                }
              })();
            }
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
                kind: "approval",
              },
            ];
            conversation.updatedAt = Date.now();
            await opts.conversationStore.update(conversation);
          }
          await persistDraft();
        }
        if (event.type === "tool:device:required") {
          const toolText = `- device dispatch \`${event.tool}\``;
          draft.toolTimeline.push(toolText);
          draft.currentTools.push(toolText);
          const existing = Array.isArray(conversation.pendingApprovals)
            ? conversation.pendingApprovals
            : [];
          if (!existing.some((a) => a.approvalId === event.requestId)) {
            conversation.pendingApprovals = [
              ...existing,
              {
                approvalId: event.requestId,
                runId: latestRunId || conversation.runtimeRunId || "",
                tool: event.tool,
                toolCallId: undefined,
                input: (event.input ?? {}) as Record<string, unknown>,
                checkpointMessages: undefined,
                baseMessageCount: historyMessages.length,
                pendingToolCalls: [],
                kind: "device",
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
            kind: "approval",
          });
          conversation._toolResultArchive = opts.harness.getToolResultArchive(
            opts.conversationId,
          );
          conversation.updatedAt = Date.now();
          await opts.conversationStore.update(conversation);
          checkpointedRun = true;
        }
        if (event.type === "tool:device:checkpoint") {
          conversation.messages = buildMessages();
          conversation.pendingApprovals = buildApprovalCheckpoints({
            approvals: event.approvals,
            runId: latestRunId,
            checkpointMessages: event.checkpointMessages,
            baseMessageCount: historyMessages.length,
            pendingToolCalls: event.pendingToolCalls,
            kind: "device",
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
      conversation.messages = buildMessages(false); // terminal: turn complete
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

      // DUAL-WRITE at finalize (mirrors applyTurnMetadata's _harnessMessages
      // write + the final assistant bubble in conversation.messages):
      //   1. harness_message entries for the messages this turn appended,
      //   2. the final assistant_message entry.
      // Best-effort + fire-and-forget; never blocks the return.
      const finalAssistant =
        conversation.messages[conversation.messages.length - 1];
      const { messages: newHarness, approximate } = newHarnessMessagesThisTurn(
        preTurnHarnessMessages,
        conversation._harnessMessages,
      );
      if (approximate) {
        log.warn(
          `[entries-dual-write] ${opts.conversationId} harness-message diff approximate ` +
            `(blob array shrank this turn — likely compaction); appended full context`,
        );
      }
      const finalizeEntries = [
        ...harnessMessageEntries(newHarness, turnId),
        ...(finalAssistant && finalAssistant.role === "assistant"
          ? [assistantMessageEntry(finalAssistant, turnId, latestRunId)]
          : []),
      ];
      void appendEntriesSafe(
        opts.conversationStore,
        conversation,
        finalizeEntries,
        log,
      ).then(() =>
        verifyEntriesParity(
          opts.conversationStore,
          opts.conversationId,
          {
            harnessMessages: conversation._harnessMessages,
            displayMessages: conversation.messages,
          },
          log,
        ),
      );
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
        conversation.messages = buildMessages(false); // terminal: cancelled
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
      conversation.messages = buildMessages(false); // terminal: errored
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
