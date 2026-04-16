import type { AgentEvent, Message } from "@poncho-ai/sdk";
import type { Conversation, ConversationStore } from "../state.js";
import type { AgentHarness } from "../harness.js";
import type { TelemetryEmitter } from "../telemetry.js";
import {
  executeConversationTurn,
  flushTurnDraft,
  buildAssistantMetadata,
  applyTurnMetadata,
  normalizeApprovalCheckpoint,
  buildApprovalCheckpoints,
  createTurnDraftState,
  type TurnDraftState,
  type ExecuteTurnResult,
  type StoredApproval,
} from "./turn.js";
import { withToolResultArchiveParam, MAX_CONTINUATION_COUNT } from "./continuation.js";

// ── Types ──

export type ActiveConversationRun = {
  ownerId: string;
  abortController: AbortController;
  runId: string | null;
};

export type EventSink = (conversationId: string, event: AgentEvent) => void | Promise<void>;

/**
 * Hook called before and after continuation runs to manage transport-specific
 * state (e.g. SSE stream lifecycle). The orchestrator doesn't know about SSE —
 * the CLI wires this up.
 */
export interface OrchestratorHooks {
  /** Called before a continuation run starts. Resets/creates event streams. */
  onContinuationStart?(conversationId: string): void;
  /** Called after a continuation run finishes. Cleans up event streams. */
  onContinuationEnd?(conversationId: string): void;
  /** Called when a subagent conversation needs continuation. */
  runSubagentContinuation?(
    conversationId: string,
    conversation: Conversation,
    continuationMessages: Message[],
  ): AsyncGenerator<AgentEvent>;
  /** Called when an approval checkpoint is stored during resumeRunFromCheckpoint.
   *  Transport layer can use this for platform-specific notifications (e.g. Telegram). */
  onApprovalCheckpoint?(conversationId: string, approvals: Array<{ approvalId: string; tool: string; input: Record<string, unknown> }>): void;
  /** Called after resumeRunFromCheckpoint completes. Transport layer can check
   *  for pending subagent callbacks and manage stream lifecycle. */
  onResumeComplete?(conversationId: string, checkpointedRun: boolean): void;
}

/** @deprecated Use OrchestratorHooks instead */
export type ContinuationHooks = OrchestratorHooks;

export interface OrchestratorOptions {
  harness: AgentHarness;
  conversationStore: ConversationStore;
  eventSink: EventSink;
  telemetry?: TelemetryEmitter;
  hooks?: OrchestratorHooks;
  /** @deprecated Use hooks instead */
  continuationHooks?: OrchestratorHooks;
}

// ── AgentOrchestrator ──

export class AgentOrchestrator {
  readonly harness: AgentHarness;
  readonly conversationStore: ConversationStore;
  readonly eventSink: EventSink;
  readonly telemetry?: TelemetryEmitter;
  private hooks?: OrchestratorHooks;

  // ── Runtime state ──
  readonly activeConversationRuns = new Map<string, ActiveConversationRun>();
  readonly runOwners = new Map<string, string>();
  readonly runConversations = new Map<string, string>();
  readonly approvalDecisionTracker = new Map<string, Map<string, boolean>>();

  constructor(options: OrchestratorOptions) {
    this.harness = options.harness;
    this.conversationStore = options.conversationStore;
    this.eventSink = options.eventSink;
    this.telemetry = options.telemetry;
    this.hooks = options.hooks ?? options.continuationHooks;
  }

  setHooks(hooks: OrchestratorHooks): void {
    this.hooks = hooks;
  }

  /** @deprecated Use setHooks instead */
  setContinuationHooks(hooks: OrchestratorHooks): void {
    this.hooks = hooks;
  }

  // ── Continuation ──

  async runContinuation(
    conversationId: string,
    onYield?: (event: AgentEvent) => void | Promise<void>,
  ): Promise<void> {
    const conversation = await this.conversationStore.getWithArchive(conversationId);
    if (!conversation) return;
    if (Array.isArray(conversation.pendingApprovals) && conversation.pendingApprovals.length > 0) return;
    if (!conversation._continuationMessages?.length) return;
    if (conversation.runStatus === "running") return;

    const count = (conversation._continuationCount ?? 0) + 1;
    if (count > MAX_CONTINUATION_COUNT) {
      console.warn(`[poncho][continuation] Max continuation count (${MAX_CONTINUATION_COUNT}) reached for ${conversationId}`);
      conversation._continuationMessages = undefined;
      conversation._continuationCount = undefined;
      await this.conversationStore.update(conversation);
      return;
    }

    const continuationMessages = [...conversation._continuationMessages];
    conversation._continuationMessages = undefined;
    conversation._continuationCount = count;
    conversation.runStatus = "running";
    await this.conversationStore.update(conversation);

    const abortController = new AbortController();
    this.activeConversationRuns.set(conversationId, {
      ownerId: conversation.ownerId,
      abortController,
      runId: null,
    });

    this.hooks?.onContinuationStart?.(conversationId);

    try {
      if (conversation.parentConversationId && this.hooks?.runSubagentContinuation) {
        for await (const event of this.hooks.runSubagentContinuation(conversationId, conversation, continuationMessages)) {
          if (onYield) await onYield(event);
        }
      } else if (!conversation.parentConversationId) {
        await this.runChatContinuation(conversationId, conversation, continuationMessages, onYield);
      }
    } finally {
      this.activeConversationRuns.delete(conversationId);
      this.hooks?.onContinuationEnd?.(conversationId);
    }
  }

  async runChatContinuation(
    conversationId: string,
    conversation: Conversation,
    continuationMessages: Message[],
    onYield?: (event: AgentEvent) => void | Promise<void>,
  ): Promise<void> {
    const execution = await executeConversationTurn({
      harness: this.harness,
      runInput: {
        conversationId,
        tenantId: conversation.tenantId ?? undefined,
        parameters: withToolResultArchiveParam({
          __activeConversationId: conversationId,
          __ownerId: conversation.ownerId,
        }, conversation),
        messages: continuationMessages,
        abortSignal: this.activeConversationRuns.get(conversationId)?.abortController.signal,
      },
      initialContextTokens: conversation.contextTokens ?? 0,
      initialContextWindow: conversation.contextWindow ?? 0,
      onEvent: async (event) => {
        if (event.type === "run:started") {
          this.runOwners.set(event.runId, conversation.ownerId);
          this.runConversations.set(event.runId, conversationId);
          const active = this.activeConversationRuns.get(conversationId);
          if (active) active.runId = event.runId;
        }
        if (this.telemetry) await this.telemetry.emit(event);
        await this.eventSink(conversationId, event);
        if (onYield) await onYield(event);
      },
    });
    flushTurnDraft(execution.draft);

    const freshConv = await this.conversationStore.get(conversationId);
    if (!freshConv) return;

    const hasContent = execution.draft.assistantResponse.length > 0 || execution.draft.toolTimeline.length > 0;
    if (hasContent) {
      freshConv.messages = [
        ...freshConv.messages,
        {
          role: "assistant" as const,
          content: execution.draft.assistantResponse,
          metadata: buildAssistantMetadata(execution.draft),
        },
      ];
    }

    applyTurnMetadata(freshConv, {
      latestRunId: execution.latestRunId,
      contextTokens: execution.runContextTokens,
      contextWindow: execution.runContextWindow,
      continuation: execution.runContinuation,
      continuationMessages: execution.runContinuationMessages,
      harnessMessages: execution.runHarnessMessages,
      toolResultArchive: this.harness.getToolResultArchive(conversationId),
    }, { shouldRebuildCanonical: true });
    if (execution.runContinuation) {
      freshConv._continuationCount = conversation._continuationCount;
    }
    await this.conversationStore.update(freshConv);
  }

  // ── Approval checkpoint management ──

  async findPendingApproval(
    approvalId: string,
    owner: string,
  ): Promise<{ conversation: Conversation; approval: StoredApproval } | undefined> {
    const searchedConversationIds = new Set<string>();
    const scan = async (conversations: Conversation[]) => {
      for (const conv of conversations) {
        if (searchedConversationIds.has(conv.conversationId)) continue;
        searchedConversationIds.add(conv.conversationId);
        if (!Array.isArray(conv.pendingApprovals)) continue;
        const match = conv.pendingApprovals.find((a) => a.approvalId === approvalId);
        if (match) {
          return { conversation: conv, approval: match as StoredApproval };
        }
      }
      return undefined;
    };

    const ownerScoped = await scan(await this.conversationStore.list(owner));
    if (ownerScoped) return ownerScoped;

    if (owner === "local-owner") {
      return await scan(await this.conversationStore.list());
    }
    return undefined;
  }

  async resumeRunFromCheckpoint(
    conversationId: string,
    conversation: Conversation,
    checkpoint: StoredApproval,
    toolResults: Array<{ callId: string; toolName: string; result?: unknown; error?: string }>,
  ): Promise<void> {
    const abortController = new AbortController();
    this.activeConversationRuns.set(conversationId, {
      ownerId: conversation.ownerId,
      abortController,
      runId: null,
    });
    let latestRunId = conversation.runtimeRunId ?? "";
    let checkpointedRun = false;

    const normalizedCheckpoint = normalizeApprovalCheckpoint(checkpoint, conversation.messages);
    const baseMessages = normalizedCheckpoint.baseMessageCount != null
      ? conversation.messages.slice(0, normalizedCheckpoint.baseMessageCount)
      : [];
    const fullCheckpointMessages = [...baseMessages, ...normalizedCheckpoint.checkpointMessages!];

    let resumeToolResultMsg: Message | undefined;
    const lastCpMsg = fullCheckpointMessages[fullCheckpointMessages.length - 1];
    if (lastCpMsg?.role === "assistant") {
      try {
        const parsed = JSON.parse(typeof lastCpMsg.content === "string" ? lastCpMsg.content : "");
        const cpToolCalls: Array<{ id: string; name: string }> = parsed.tool_calls ?? [];
        if (cpToolCalls.length > 0) {
          const providedMap = new Map(toolResults.map(r => [r.callId, r]));
          resumeToolResultMsg = {
            role: "tool",
            content: JSON.stringify(cpToolCalls.map(tc => {
              const provided = providedMap.get(tc.id);
              return {
                type: "tool_result",
                tool_use_id: tc.id,
                tool_name: provided?.toolName ?? tc.name,
                content: provided
                  ? (provided.error ? `Tool error: ${provided.error}` : JSON.stringify(provided.result ?? null))
                  : "Tool error: Tool execution deferred (pending approval checkpoint)",
              };
            })),
            metadata: { timestamp: Date.now() },
          };
        }
      } catch { /* last message is not a parseable assistant-with-tools — skip */ }
    }
    const fullCheckpointWithResults = resumeToolResultMsg
      ? [...fullCheckpointMessages, resumeToolResultMsg]
      : fullCheckpointMessages;

    let draftRef: TurnDraftState | undefined;
    let execution: ExecuteTurnResult | undefined;

    try {
      execution = await executeConversationTurn({
        harness: this.harness,
        events: this.harness.continueFromToolResult({
          messages: fullCheckpointMessages,
          toolResults,
          conversationId,
          abortSignal: abortController.signal,
        }),
        initialContextTokens: conversation.contextTokens ?? 0,
        initialContextWindow: conversation.contextWindow ?? 0,
        onEvent: async (event, draft) => {
          draftRef = draft;
          if (event.type === "run:started") {
            latestRunId = event.runId;
            this.runOwners.set(event.runId, conversation.ownerId);
            this.runConversations.set(event.runId, conversationId);
            const active = this.activeConversationRuns.get(conversationId);
            if (active && active.abortController === abortController) {
              active.runId = event.runId;
            }
          }
          if (event.type === "tool:approval:required") {
            const toolText = `- approval required \`${(event as { tool: string }).tool}\``;
            draft.toolTimeline.push(toolText);
            draft.currentTools.push(toolText);
          }
          if (event.type === "tool:approval:checkpoint") {
            const cpEvent = event as {
              approvals: Array<{ approvalId: string; tool: string; toolCallId: string; input: Record<string, unknown> }>;
              checkpointMessages: Message[];
              pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
            };
            const conv = await this.conversationStore.get(conversationId);
            if (conv) {
              conv.pendingApprovals = buildApprovalCheckpoints({
                approvals: cpEvent.approvals,
                runId: latestRunId,
                checkpointMessages: [...fullCheckpointWithResults, ...cpEvent.checkpointMessages],
                baseMessageCount: 0,
                pendingToolCalls: cpEvent.pendingToolCalls,
              });
              conv.updatedAt = Date.now();
              await this.conversationStore.update(conv);
              this.hooks?.onApprovalCheckpoint?.(
                conversationId,
                cpEvent.approvals.map(a => ({ approvalId: a.approvalId, tool: a.tool, input: a.input })),
              );
            }
            checkpointedRun = true;
          }
          if (this.telemetry) await this.telemetry.emit(event);
          await this.eventSink(conversationId, event);
        },
      });
      flushTurnDraft(execution.draft);
      latestRunId = execution.latestRunId || latestRunId;
    } catch (err) {
      console.error("[resume-run] error:", err instanceof Error ? err.message : err);
      if (draftRef) {
        draftRef.assistantResponse = draftRef.assistantResponse || `[Error: ${err instanceof Error ? err.message : "Unknown error"}]`;
        flushTurnDraft(draftRef);
      }
    }

    const draft = execution?.draft ?? draftRef ?? createTurnDraftState();

    if (!checkpointedRun) {
      const conv = await this.conversationStore.get(conversationId);
      if (conv) {
        const hasAssistantContent =
          draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0 || draft.sections.length > 0;
        if (hasAssistantContent) {
          const prevMessages = conv.messages;
          const lastMsg = prevMessages[prevMessages.length - 1];
          if (lastMsg && lastMsg.role === "assistant" && lastMsg.metadata) {
            const existingToolActivity = (lastMsg.metadata as Record<string, unknown>).toolActivity;
            const existingSections = (lastMsg.metadata as Record<string, unknown>).sections;
            const mergedTimeline = [
              ...(Array.isArray(existingToolActivity) ? existingToolActivity as string[] : []),
              ...draft.toolTimeline,
            ];
            const mergedSections = [
              ...(Array.isArray(existingSections) ? existingSections as Array<{ type: "text" | "tools"; content: string | string[] }> : []),
              ...draft.sections,
            ];
            const mergedText = (typeof lastMsg.content === "string" ? lastMsg.content : "") + draft.assistantResponse;
            conv.messages = [
              ...prevMessages.slice(0, -1),
              {
                role: "assistant" as const,
                content: mergedText,
                metadata: {
                  toolActivity: mergedTimeline,
                  sections: mergedSections.length > 0 ? mergedSections : undefined,
                } as Message["metadata"],
              },
            ];
          } else {
            conv.messages = [
              ...prevMessages,
              {
                role: "assistant" as const,
                content: draft.assistantResponse,
                metadata: buildAssistantMetadata(draft),
              },
            ];
          }
        }
        applyTurnMetadata(conv, {
          latestRunId,
          contextTokens: execution?.runContextTokens ?? 0,
          contextWindow: execution?.runContextWindow ?? 0,
          harnessMessages: execution?.runHarnessMessages,
        }, { shouldRebuildCanonical: true });
        await this.conversationStore.update(conv);
      }
    } else {
      const conv = await this.conversationStore.get(conversationId);
      if (conv) {
        conv.runStatus = "idle";
        conv.updatedAt = Date.now();
        await this.conversationStore.update(conv);
      }
    }

    this.activeConversationRuns.delete(conversationId);
    if (latestRunId) {
      this.runOwners.delete(latestRunId);
      this.runConversations.delete(latestRunId);
    }
    console.log("[resume-run] complete for", conversationId);

    this.hooks?.onResumeComplete?.(conversationId, checkpointedRun);
  }
}
