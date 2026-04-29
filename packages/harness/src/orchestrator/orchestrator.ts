import type { AgentEvent, Message } from "@poncho-ai/sdk";
import type { Conversation, ConversationStore, PendingSubagentResult } from "../state.js";
import type { AgentHarness } from "../harness.js";
import type { TelemetryEmitter } from "../telemetry.js";
import type { SubagentManager, SubagentSpawnResult } from "../subagent-manager.js";
import {
  executeConversationTurn,
  flushTurnDraft,
  buildAssistantMetadata,
  applyTurnMetadata,
  normalizeApprovalCheckpoint,
  buildApprovalCheckpoints,
  createTurnDraftState,
  recordStandardTurnEvent,
  type TurnDraftState,
  type ExecuteTurnResult,
  type StoredApproval,
} from "./turn.js";
import { withToolResultArchiveParam, MAX_CONTINUATION_COUNT } from "./continuation.js";
import { resolveRunRequest } from "./history.js";
import {
  type ActiveSubagentRun,
  type PendingSubagentApproval,
  MAX_SUBAGENT_NESTING,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_SUBAGENT_CALLBACK_COUNT,
  CALLBACK_LOCK_STALE_MS,
  STALE_SUBAGENT_THRESHOLD_MS,
} from "./subagents.js";

// ── Types ──

export type ActiveConversationRun = {
  ownerId: string;
  abortController: AbortController;
  runId: string | null;
};

export type EventSink = (conversationId: string, event: AgentEvent) => void | Promise<void>;

export interface OrchestratorHooks {
  /** Called before a continuation run starts. Resets/creates event streams. */
  onContinuationStart?(conversationId: string): void;
  /** Called after a continuation run finishes. Cleans up event streams. */
  onContinuationEnd?(conversationId: string): void;
  /** Called when an approval checkpoint is stored during resumeRunFromCheckpoint.
   *  Transport layer can use this for platform-specific notifications (e.g. Telegram). */
  onApprovalCheckpoint?(conversationId: string, approvals: Array<{ approvalId: string; tool: string; input: Record<string, unknown> }>): void;
  /** Called after resumeRunFromCheckpoint completes. Transport layer can check
   *  for pending subagent callbacks and manage stream lifecycle.
   *  @deprecated Orchestrator handles post-resume subagent work internally in Phase 5+. */
  onResumeComplete?(conversationId: string, checkpointedRun: boolean): void;

  // ── Subagent hooks ──

  /** Create a child AgentHarness for subagent execution. Required for subagent support. */
  createChildHarness?(): Promise<AgentHarness>;
  /** Build recall parameters injected into run parameters for conversation context. */
  buildRecallParams?(opts: { ownerId: string; tenantId?: string | null; excludeConversationId: string }): Record<string, unknown>;
  /** Dispatch a background task via serverless self-fetch. If not provided,
   *  the orchestrator calls methods directly (long-lived mode). */
  dispatchBackground?(type: "subagent-run" | "subagent-callback" | "continuation", conversationId: string): void;
  /** Called when a conversation's event stream should be closed/finished. */
  onStreamEnd?(conversationId: string): void;
  /** Called when processSubagentCallback needs to open/reset the parent's event stream. */
  onCallbackStreamReset?(conversationId: string): void;
  /** Notify a messaging platform about a subagent callback result. */
  onMessagingNotify?(conversationId: string, text: string): void;
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
  /** Agent identity ID for tool context. Falls back to harness frontmatter ID. */
  agentId?: string;
  /** Working directory for tool context. */
  workingDir?: string;
}

// ── AgentOrchestrator ──

export class AgentOrchestrator {
  readonly harness: AgentHarness;
  readonly conversationStore: ConversationStore;
  readonly eventSink: EventSink;
  readonly telemetry?: TelemetryEmitter;
  /** @internal */
  hooks?: OrchestratorHooks;
  private readonly agentId: string;
  private readonly workingDir: string;

  // ── Runtime state (conversation runs) ──
  readonly activeConversationRuns = new Map<string, ActiveConversationRun>();
  readonly runOwners = new Map<string, string>();
  readonly runConversations = new Map<string, string>();
  readonly approvalDecisionTracker = new Map<string, Map<string, boolean>>();

  // ── Runtime state (subagents) ──
  readonly activeSubagentRuns = new Map<string, ActiveSubagentRun>();
  readonly recentlySpawnedParents = new Map<string, number>();
  readonly pendingSubagentApprovals = new Map<string, PendingSubagentApproval>();
  readonly pendingCallbackNeeded = new Set<string>();

  constructor(options: OrchestratorOptions) {
    this.harness = options.harness;
    this.conversationStore = options.conversationStore;
    this.eventSink = options.eventSink;
    this.telemetry = options.telemetry;
    this.hooks = options.hooks ?? options.continuationHooks;
    this.agentId = options.agentId ?? options.harness.frontmatter?.id ?? "";
    this.workingDir = options.workingDir ?? "";
  }

  setHooks(hooks: OrchestratorHooks): void {
    this.hooks = hooks;
  }

  /** @deprecated Use setHooks instead */
  setContinuationHooks(hooks: OrchestratorHooks): void {
    this.hooks = hooks;
  }

  private get isServerless(): boolean {
    return typeof this.hooks?.dispatchBackground === "function";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Continuation
  // ══════════════════════════════════════════════════════════════════════════

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
      if (conversation.parentConversationId) {
        for await (const event of this.runSubagentContinuation(conversationId, conversation, continuationMessages)) {
          if (onYield) await onYield(event);
        }
      } else {
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
    const recallParams = this.hooks?.buildRecallParams?.({
      ownerId: conversation.ownerId,
      tenantId: conversation.tenantId,
      excludeConversationId: conversationId,
    }) ?? {};
    const execution = await executeConversationTurn({
      harness: this.harness,
      runInput: {
        conversationId,
        tenantId: conversation.tenantId ?? undefined,
        parameters: withToolResultArchiveParam({
          ...recallParams,
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

  // ══════════════════════════════════════════════════════════════════════════
  // Approval checkpoint management
  // ══════════════════════════════════════════════════════════════════════════

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
      } catch { /* last message is not a parseable assistant-with-tools -- skip */ }
    }
    const fullCheckpointWithResults = resumeToolResultMsg
      ? [...fullCheckpointMessages, resumeToolResultMsg]
      : fullCheckpointMessages;

    let draftRef: TurnDraftState | undefined;
    let execution: ExecuteTurnResult | undefined;
    const resumeRecallParams = this.hooks?.buildRecallParams?.({
      ownerId: conversation.ownerId,
      tenantId: conversation.tenantId,
      excludeConversationId: conversationId,
    }) ?? {};

    try {
      execution = await executeConversationTurn({
        harness: this.harness,
        events: this.harness.continueFromToolResult({
          messages: fullCheckpointMessages,
          toolResults,
          conversationId,
          parameters: withToolResultArchiveParam({
            ...resumeRecallParams,
            __activeConversationId: conversationId,
            __ownerId: conversation.ownerId,
          }, conversation),
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

    // Post-resume: check for pending subagent work
    if (this.hooks?.onResumeComplete) {
      // Legacy hook path (if consumer still provides onResumeComplete)
      this.hooks.onResumeComplete(conversationId, checkpointedRun);
    } else {
      await this._handlePostResumeWork(conversationId);
    }
  }

  /** After a resume completes, check for deferred subagent callbacks. */
  private async _handlePostResumeWork(conversationId: string): Promise<void> {
    const hadDeferred = this.pendingCallbackNeeded.delete(conversationId);
    const postConv = await this.conversationStore.get(conversationId);
    const needsCallback = hadDeferred || !!postConv?.pendingSubagentResults?.length;
    const hasRunningChildren = this.hasRunningSubagentsForParent(conversationId);

    if (!needsCallback && !hasRunningChildren) {
      this.hooks?.onStreamEnd?.(conversationId);
    }
    if (needsCallback) {
      this.processSubagentCallback(conversationId, true).catch(err =>
        console.error(`[poncho][subagent-callback] Post-resume callback failed:`, err instanceof Error ? err.message : err),
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Subagent lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  // ── Helpers ──

  hasRunningSubagentsForParent(parentConversationId: string): boolean {
    for (const run of this.activeSubagentRuns.values()) {
      if (run.parentConversationId === parentConversationId) return true;
    }
    return false;
  }

  getRunningSubagentCountForParent(parentId: string): number {
    let count = 0;
    for (const run of this.activeSubagentRuns.values()) {
      if (run.parentConversationId === parentId) count += 1;
    }
    return count;
  }

  async getSubagentDepth(conversationId: string): Promise<number> {
    let depth = 0;
    let current = await this.conversationStore.get(conversationId);
    while (current?.parentConversationId) {
      depth += 1;
      current = await this.conversationStore.get(current.parentConversationId);
    }
    return depth;
  }

  async hasPendingSubagentWorkForParent(
    parentConversationId: string,
    _owner: string,
  ): Promise<boolean> {
    if (this.hasRunningSubagentsForParent(parentConversationId)) return true;
    if (this.recentlySpawnedParents.has(parentConversationId)) return true;
    if (this.pendingCallbackNeeded.has(parentConversationId)) return true;
    const parentConversation = await this.conversationStore.get(parentConversationId);
    if (!parentConversation) return false;
    if (Array.isArray(parentConversation.pendingSubagentResults) && parentConversation.pendingSubagentResults.length > 0) return true;
    if (typeof parentConversation.runningCallbackSince === "number" && parentConversation.runningCallbackSince > 0) return true;
    return false;
  }

  // ── Subagent approval decision ──

  /**
   * Submit an approval decision for a pending subagent approval.
   * Returns whether the approval was found, the child conversation, and whether all approvals are now decided.
   */
  async submitSubagentApprovalDecision(
    approvalId: string,
    approved: boolean,
  ): Promise<{ found: boolean; childConversationId?: string; allDecided: boolean }> {
    const pending = this.pendingSubagentApprovals.get(approvalId);
    if (!pending) return { found: false, allDecided: false };

    const decision = approved ? "approved" as const : "denied" as const;
    pending.checkpoint.decision = decision;

    await this.eventSink(pending.childConversationId,
      approved
        ? { type: "tool:approval:granted", approvalId }
        : { type: "tool:approval:denied", approvalId },
    );

    // Explicitly update the decision in the conversation store (the store may
    // serialize/deserialize, so in-memory mutation of pending.checkpoint alone
    // is not sufficient).
    const childConv = await this.conversationStore.get(pending.childConversationId);
    if (childConv && Array.isArray(childConv.pendingApprovals)) {
      childConv.pendingApprovals = childConv.pendingApprovals.map(pa =>
        pa.approvalId === approvalId ? { ...pa, decision } : pa,
      );
      await this.conversationStore.update(childConv);
    }

    const allApprovals = childConv?.pendingApprovals ?? [];
    const allDecided = allApprovals.length > 0 && allApprovals.every(pa => pa.decision != null);

    if (allDecided) {
      for (const pa of allApprovals) this.pendingSubagentApprovals.delete(pa.approvalId);
      if (childConv) {
        childConv.pendingApprovals = [];
        await this.conversationStore.update(childConv);
      }
      pending.resolve(allApprovals);
    }

    return { found: true, childConversationId: pending.childConversationId, allDecided };
  }

  // ── Completion + checkpoint resume ──

  async handleSubagentCompletion(subagentId: string): Promise<void> {
    const conv = await this.conversationStore.get(subagentId);
    if (!conv || !conv.parentConversationId) return;
    if (conv.subagentMeta?.status === "completed" || conv.subagentMeta?.status === "error") return;

    conv.subagentMeta = { ...conv.subagentMeta!, status: "completed" };
    conv.updatedAt = Date.now();
    await this.conversationStore.update(conv);

    const lastMsg = conv.messages[conv.messages.length - 1];
    const responseText = lastMsg?.role === "assistant" && typeof lastMsg.content === "string" ? lastMsg.content : "";
    const pendingResult: PendingSubagentResult = {
      subagentId,
      task: conv.subagentMeta?.task ?? conv.title,
      status: "completed",
      result: { status: "completed", response: responseText, steps: 0, tokens: { input: 0, output: 0, cached: 0 }, duration: 0 },
      timestamp: Date.now(),
    };
    await this.conversationStore.appendSubagentResult(conv.parentConversationId, pendingResult);

    await this.eventSink(conv.parentConversationId, {
      type: "subagent:completed",
      subagentId,
      conversationId: subagentId,
    });

    await this.triggerParentCallback(conv.parentConversationId);
  }

  async resumeSubagentFromCheckpoint(subagentId: string): Promise<void> {
    const conv = await this.conversationStore.get(subagentId);
    if (!conv || !conv.parentConversationId) return;

    const allApprovals = (conv.pendingApprovals ?? []).map((approval) =>
      normalizeApprovalCheckpoint(approval, conv.messages),
    );
    if (allApprovals.length === 0) return;
    const allDecided = allApprovals.every(a => a.decision != null);
    if (!allDecided) return;

    conv.pendingApprovals = [];
    conv.subagentMeta = { ...conv.subagentMeta!, status: "running" };
    await this.conversationStore.update(conv);

    const checkpointRef = allApprovals[0]!;
    const toolContext = {
      runId: checkpointRef.runId,
      agentId: this.agentId,
      step: 0,
      workingDir: this.workingDir,
      parameters: {},
      conversationId: subagentId,
    };

    const approvalToolCallIds = new Set(allApprovals.map(a => a.toolCallId));
    const callsToExecute: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    const deniedResults: Array<{ callId: string; toolName: string; error: string }> = [];

    for (const a of allApprovals) {
      if (a.decision === "approved" && a.toolCallId) {
        callsToExecute.push({ id: a.toolCallId, name: a.tool, input: a.input });
      } else if (a.decision === "denied" && a.toolCallId) {
        deniedResults.push({ callId: a.toolCallId, toolName: a.tool, error: "Tool execution denied by user" });
      }
    }

    const pendingToolCalls = checkpointRef.pendingToolCalls ?? [];
    for (const tc of pendingToolCalls) {
      if (!approvalToolCallIds.has(tc.id)) callsToExecute.push(tc);
    }

    let toolResults: Array<{ callId: string; toolName: string; result?: unknown; error?: string }> = [...deniedResults];
    if (callsToExecute.length > 0) {
      const execResults = await this.harness.executeTools(callsToExecute, toolContext);
      toolResults.push(...execResults.map(r => ({
        callId: r.callId,
        toolName: r.tool,
        result: r.output,
        error: r.error,
      })));
    }

    await this.resumeRunFromCheckpoint(subagentId, conv, checkpointRef, toolResults);
    await this.handleSubagentCompletion(subagentId);
  }

  // ── Subagent run ──

  async runSubagent(
    childConversationId: string,
    parentConversationId: string,
    task: string,
    ownerId: string,
  ): Promise<void> {
    if (!this.hooks?.createChildHarness) {
      throw new Error("createChildHarness hook is required for subagent support");
    }

    const childHarness = await this.hooks.createChildHarness();

    const childAbortController = new AbortController();
    this.activeSubagentRuns.set(childConversationId, { abortController: childAbortController, harness: childHarness, parentConversationId });
    this.activeConversationRuns.set(childConversationId, {
      ownerId,
      abortController: childAbortController,
      runId: null,
    });
    // Decrement the temporary spawn counter now that we're registered
    const spawnCount = this.recentlySpawnedParents.get(parentConversationId) ?? 0;
    if (spawnCount <= 1) {
      this.recentlySpawnedParents.delete(parentConversationId);
    } else {
      this.recentlySpawnedParents.set(parentConversationId, spawnCount - 1);
    }

    childHarness.unregisterTools(["memory_main_write", "memory_main_edit"]);

    const draft = createTurnDraftState();
    let latestRunId = "";
    let runResult: { status: "completed" | "error" | "cancelled"; response?: string; steps: number; duration: number; continuation?: boolean; continuationMessages?: Message[] } | undefined;

    try {
      const conversation = await this.conversationStore.getWithArchive(childConversationId);
      if (!conversation) throw new Error("Subagent conversation not found");

      if (conversation.subagentMeta?.status === "stopped") return;

      conversation.lastActivityAt = Date.now();
      await this.conversationStore.update(conversation);

      const runOutcome = resolveRunRequest(conversation, {
        conversationId: childConversationId,
        messages: conversation.messages,
      });
      const harnessMessages = [...runOutcome.messages];

      const recallParams = this.hooks?.buildRecallParams?.({ ownerId, tenantId: conversation.tenantId, excludeConversationId: childConversationId }) ?? {};

      for await (const event of childHarness.runWithTelemetry({
        task,
        conversationId: childConversationId,
        tenantId: conversation.tenantId ?? undefined,
        parameters: withToolResultArchiveParam({
          ...recallParams,
          __activeConversationId: childConversationId,
          __ownerId: ownerId,
        }, conversation),
        messages: harnessMessages,
        abortSignal: childAbortController.signal,
      })) {
        if (event.type === "run:started") {
          latestRunId = event.runId;
          const active = this.activeConversationRuns.get(childConversationId);
          if (active) active.runId = event.runId;
        }
        recordStandardTurnEvent(draft, event);
        if (event.type === "tool:approval:required") {
          const toolText = `- approval required \`${event.tool}\``;
          draft.toolTimeline.push(toolText);
          draft.currentTools.push(toolText);
          await this.eventSink(parentConversationId, {
            type: "subagent:approval_needed",
            subagentId: childConversationId,
            conversationId: childConversationId,
            tool: event.tool,
            approvalId: event.approvalId,
            input: event.input as Record<string, unknown> | undefined,
          });
        }
        if (event.type === "tool:approval:checkpoint") {
          const cpConv = await this.conversationStore.get(childConversationId);
          if (cpConv) {
            const allCpData = buildApprovalCheckpoints({
              approvals: event.approvals,
              runId: latestRunId,
              checkpointMessages: [...harnessMessages, ...event.checkpointMessages],
              baseMessageCount: 0,
              pendingToolCalls: event.pendingToolCalls,
            });
            cpConv.pendingApprovals = allCpData;
            cpConv.updatedAt = Date.now();
            await this.conversationStore.update(cpConv);

            const decidedApprovals = await new Promise<NonNullable<Conversation["pendingApprovals"]>>((resolve) => {
              for (const cpData of allCpData) {
                this.pendingSubagentApprovals.set(cpData.approvalId, {
                  resolve,
                  childHarness,
                  checkpoint: cpData,
                  childConversationId,
                  parentConversationId,
                });
              }
            });

            const checkpointRef = normalizeApprovalCheckpoint(allCpData[0]!, [...harnessMessages]);
            const toolContext = {
              runId: checkpointRef.runId,
              agentId: this.agentId,
              step: 0,
              workingDir: this.workingDir,
              parameters: {},
              conversationId: childConversationId,
            };

            const approvalToolCallIds = new Set(decidedApprovals.map(a => a.toolCallId));
            const callsToExecute: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
            const deniedResults: Array<{ callId: string; toolName: string; error: string }> = [];

            for (const a of decidedApprovals) {
              if (a.decision === "approved" && a.toolCallId) {
                callsToExecute.push({ id: a.toolCallId, name: a.tool, input: a.input });
                const toolText = `- done \`${a.tool}\``;
                draft.toolTimeline.push(toolText);
                draft.currentTools.push(toolText);
              } else if (a.toolCallId) {
                deniedResults.push({ callId: a.toolCallId, toolName: a.tool, error: "Tool execution denied by user" });
                const toolText = `- denied \`${a.tool}\``;
                draft.toolTimeline.push(toolText);
                draft.currentTools.push(toolText);
              }
            }

            const cpPendingToolCalls = checkpointRef.pendingToolCalls ?? [];
            for (const tc of cpPendingToolCalls) {
              if (!approvalToolCallIds.has(tc.id)) {
                callsToExecute.push(tc);
              }
            }

            let toolResults: Array<{ callId: string; toolName: string; result?: unknown; error?: string }> = [...deniedResults];
            if (callsToExecute.length > 0) {
              const execResults = await childHarness.executeTools(callsToExecute, toolContext);
              toolResults.push(...execResults.map(r => ({
                callId: r.callId,
                toolName: r.tool,
                result: r.output,
                error: r.error,
              })));
            }

            const resumeMessages = [...checkpointRef.checkpointMessages!];
            for await (const resumeEvent of childHarness.continueFromToolResult({
              messages: resumeMessages,
              toolResults,
              conversationId: childConversationId,
              abortSignal: childAbortController.signal,
            })) {
              recordStandardTurnEvent(draft, resumeEvent);
              if (resumeEvent.type === "run:completed") {
                runResult = { status: resumeEvent.result.status, response: resumeEvent.result.response, steps: resumeEvent.result.steps, duration: resumeEvent.result.duration };
                if (draft.assistantResponse.length === 0 && resumeEvent.result.response) {
                  draft.assistantResponse = resumeEvent.result.response;
                }
              }
              if (resumeEvent.type === "run:error") {
                draft.assistantResponse = draft.assistantResponse || `[Error: ${resumeEvent.error.message}]`;
              }
              await this.eventSink(childConversationId, resumeEvent);
            }
          }
        }
        if (event.type === "run:completed") {
          runResult = { status: event.result.status, response: event.result.response, steps: event.result.steps, duration: event.result.duration, continuation: event.result.continuation, continuationMessages: event.result.continuationMessages };
          if (draft.assistantResponse.length === 0 && event.result.response) {
            draft.assistantResponse = event.result.response;
          }
        }
        if (event.type === "run:error") {
          draft.assistantResponse = draft.assistantResponse || `[Error: ${event.error.message}]`;
        }
        await this.eventSink(childConversationId, event);
      }

      // Persist assistant turn
      flushTurnDraft(draft);

      const conv = await this.conversationStore.get(childConversationId);
      if (conv) {
        const hasContent = draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0;
        if (hasContent) {
          conv.messages.push({
            role: "assistant",
            content: draft.assistantResponse,
            metadata: buildAssistantMetadata(draft),
          });
        }
        if (runResult?.continuation && runResult.continuationMessages) {
          conv._continuationMessages = runResult.continuationMessages;
        } else {
          conv._continuationMessages = undefined;
          conv._continuationCount = undefined;
        }
        if (runResult?.continuationMessages) {
          conv._harnessMessages = runResult.continuationMessages;
        } else if (runOutcome.shouldRebuildCanonical) {
          conv._harnessMessages = conv.messages;
        }
        conv._toolResultArchive = childHarness.getToolResultArchive(childConversationId);
        conv.lastActivityAt = Date.now();
        conv.updatedAt = Date.now();

        if (runResult?.continuation) {
          await this.conversationStore.update(conv);
          this.hooks?.onStreamEnd?.(childConversationId);
          this.activeSubagentRuns.delete(childConversationId);
          this.activeConversationRuns.delete(childConversationId);
          try { await childHarness.shutdown(); } catch {}

          if (this.isServerless) {
            this.hooks!.dispatchBackground!("continuation", childConversationId);
          } else {
            this.runContinuation(childConversationId).catch(err =>
              console.error(`[poncho][subagent] Continuation failed:`, err instanceof Error ? err.message : err),
            );
          }
          return;
        }

        conv.subagentMeta = { ...conv.subagentMeta!, status: "completed" };
        await this.conversationStore.update(conv);
      }

      this.hooks?.onStreamEnd?.(childConversationId);
      await this.eventSink(parentConversationId, {
        type: "subagent:completed",
        subagentId: childConversationId,
        conversationId: childConversationId,
      });

      let subagentResponse = runResult?.response ?? draft.assistantResponse;
      if (!subagentResponse) {
        const freshSubConv = await this.conversationStore.get(childConversationId);
        if (freshSubConv) {
          const lastAssistant = [...freshSubConv.messages].reverse().find(m => m.role === "assistant");
          if (lastAssistant && typeof lastAssistant.content === "string") {
            subagentResponse = lastAssistant.content;
          }
        }
      }
      const pendingResult: PendingSubagentResult = {
        subagentId: childConversationId,
        task,
        status: "completed",
        result: runResult ? { status: runResult.status, response: subagentResponse, steps: runResult.steps, tokens: { input: 0, output: 0, cached: 0 }, duration: runResult.duration } : undefined,
        timestamp: Date.now(),
      };
      await this.conversationStore.appendSubagentResult(parentConversationId, pendingResult);
      this.triggerParentCallback(parentConversationId).catch(err =>
        console.error(`[poncho][subagent] Parent callback failed:`, err instanceof Error ? err.message : err),
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[poncho][subagent] Error in subagent ${childConversationId}:`, errMsg);

      const conv = await this.conversationStore.get(childConversationId);
      if (conv) {
        conv.subagentMeta = {
          ...conv.subagentMeta!,
          status: "error",
          error: { code: "SUBAGENT_ERROR", message: errMsg },
        };
        conv.updatedAt = Date.now();
        await this.conversationStore.update(conv);
      }

      this.hooks?.onStreamEnd?.(childConversationId);
      await this.eventSink(parentConversationId, {
        type: "subagent:error",
        subagentId: childConversationId,
        conversationId: childConversationId,
        error: errMsg,
      });

      const pendingResult: PendingSubagentResult = {
        subagentId: childConversationId,
        task,
        status: "error",
        error: { code: "SUBAGENT_ERROR", message: errMsg },
        timestamp: Date.now(),
      };
      await this.conversationStore.appendSubagentResult(parentConversationId, pendingResult).catch(() => {});
      this.triggerParentCallback(parentConversationId).catch(err2 =>
        console.error(`[poncho][subagent] Parent callback failed:`, err2 instanceof Error ? err2.message : err2),
      );
    } finally {
      for (const [aid, pa] of this.pendingSubagentApprovals) {
        if (pa.childHarness === childHarness) {
          this.pendingSubagentApprovals.delete(aid);
        }
      }
      this.activeSubagentRuns.delete(childConversationId);
      this.activeConversationRuns.delete(childConversationId);
      try { await childHarness.shutdown(); } catch {}
    }
  }

  // ── Parent callback ──

  async triggerParentCallback(parentConversationId: string): Promise<void> {
    if (this.activeConversationRuns.has(parentConversationId)) {
      this.pendingCallbackNeeded.add(parentConversationId);
      return;
    }
    if (this.isServerless) {
      this.hooks!.dispatchBackground!("subagent-callback", parentConversationId);
      return;
    }
    await this.processSubagentCallback(parentConversationId);
  }

  async processSubagentCallback(conversationId: string, skipLockCheck = false): Promise<void> {
    const conversation = await this.conversationStore.getWithArchive(conversationId);
    if (!conversation) return;

    const pendingResults = conversation.pendingSubagentResults ?? [];
    const hasOrphanedContinuation = pendingResults.length === 0
      && Array.isArray(conversation._continuationMessages)
      && conversation._continuationMessages.length > 0
      && !this.activeConversationRuns.has(conversationId);
    if (pendingResults.length === 0 && !hasOrphanedContinuation) return;

    // Store-based lock for serverless
    if (!skipLockCheck && conversation.runningCallbackSince) {
      const elapsed = Date.now() - conversation.runningCallbackSince;
      if (elapsed < CALLBACK_LOCK_STALE_MS) return;
      console.warn(`[poncho][subagent-callback] Stale lock detected (${elapsed}ms) for ${conversationId}, proceeding`);
    }

    // Acquire lock and clear pending
    conversation.pendingSubagentResults = [];
    conversation.runningCallbackSince = Date.now();
    conversation.runStatus = "running";
    const callbackCount = (conversation.subagentCallbackCount ?? 0) + 1;
    conversation.subagentCallbackCount = callbackCount;

    for (const pr of pendingResults) {
      const resultBody = pr.result
        ? `Status: ${pr.result.status}\nResponse: ${pr.result.response ?? "(no response)"}\nSteps: ${pr.result.steps}, Duration: ${pr.result.duration}ms`
        : pr.error
          ? `Error: ${pr.error.message}`
          : "(no result)";
      conversation.messages.push({
        role: "user",
        content: `[Subagent Result] Subagent "${pr.task}" (${pr.subagentId}) ${pr.status}:\n\n${resultBody}`,
        metadata: { _subagentCallback: true, subagentId: pr.subagentId, task: pr.task, timestamp: pr.timestamp } as Message["metadata"],
      });
    }
    const processedIds = new Set(pendingResults.map(pr => pr.subagentId));
    const freshForPending = await this.conversationStore.get(conversationId);
    const arrivedDuringCallback = (freshForPending?.pendingSubagentResults ?? [])
      .filter(pr => !processedIds.has(pr.subagentId));
    conversation.pendingSubagentResults = arrivedDuringCallback;
    conversation._harnessMessages = [...conversation.messages];
    conversation.updatedAt = Date.now();
    await this.conversationStore.update(conversation);

    if (callbackCount > MAX_SUBAGENT_CALLBACK_COUNT) {
      console.warn(`[poncho][subagent-callback] Circuit breaker: ${callbackCount} callbacks for ${conversationId}, skipping re-run`);
      conversation.runningCallbackSince = undefined;
      conversation.runStatus = "idle";
      await this.conversationStore.update(conversation);
      return;
    }

    const isContinuationResume = hasOrphanedContinuation && pendingResults.length === 0;
    console.log(`[poncho][subagent-callback] Processing ${pendingResults.length} result(s) for ${conversationId} (callback #${callbackCount})${isContinuationResume ? " (continuation resume)" : ""}`);

    const abortController = new AbortController();
    this.activeConversationRuns.set(conversationId, {
      ownerId: conversation.ownerId,
      abortController,
      runId: null,
    });
    this.hooks?.onCallbackStreamReset?.(conversationId);

    const historySelection = resolveRunRequest(conversation, {
      conversationId,
      messages: conversation.messages,
      preferContinuation: isContinuationResume,
    });
    const historyMessages = [...historySelection.messages];
    console.info(
      `[poncho][subagent-callback] conversation="${conversationId}" history_source=${historySelection.source}`,
    );
    let execution: ExecuteTurnResult | undefined;
    const recallParams = this.hooks?.buildRecallParams?.({
      ownerId: conversation.ownerId,
      tenantId: conversation.tenantId,
      excludeConversationId: conversationId,
    }) ?? {};

    try {
      execution = await executeConversationTurn({
        harness: this.harness,
        runInput: {
          task: undefined,
          conversationId,
          tenantId: conversation.tenantId ?? undefined,
          parameters: withToolResultArchiveParam({
            ...recallParams,
            __activeConversationId: conversationId,
            __ownerId: conversation.ownerId,
          }, conversation),
          messages: historyMessages,
          abortSignal: abortController.signal,
        },
        initialContextTokens: conversation.contextTokens ?? 0,
        initialContextWindow: conversation.contextWindow ?? 0,
        onEvent: (event) => {
          if (event.type === "run:started") {
            const active = this.activeConversationRuns.get(conversationId);
            if (active) active.runId = event.runId;
          }
          this.eventSink(conversationId, event);
        },
      });
      flushTurnDraft(execution.draft);

      const callbackNeedsContinuation = execution.runContinuation && execution.runContinuationMessages;
      if (callbackNeedsContinuation || execution.draft.assistantResponse.length > 0 || execution.draft.toolTimeline.length > 0) {
        const freshConv = await this.conversationStore.get(conversationId);
        if (freshConv) {
          if (!callbackNeedsContinuation) {
            freshConv.messages.push({
              role: "assistant",
              content: execution.draft.assistantResponse,
              metadata: buildAssistantMetadata(execution.draft),
            });
          }
          applyTurnMetadata(freshConv, {
            latestRunId: execution.latestRunId,
            contextTokens: execution.runContextTokens,
            contextWindow: execution.runContextWindow,
            continuation: !!callbackNeedsContinuation,
            continuationMessages: execution.runContinuationMessages,
            harnessMessages: callbackNeedsContinuation ? execution.runHarnessMessages : undefined,
            toolResultArchive: this.harness.getToolResultArchive(conversationId),
          }, { shouldRebuildCanonical: true, clearApprovals: false });
          freshConv.runningCallbackSince = undefined;
          await this.conversationStore.update(freshConv);

          // Proactive messaging notification
          if (freshConv.channelMeta && execution.draft.assistantResponse.length > 0) {
            this.hooks?.onMessagingNotify?.(conversationId, execution.draft.assistantResponse);
          }
        }
      }

      // Handle continuation for the callback run itself
      if (execution.runContinuation) {
        if (this.isServerless) {
          this.hooks!.dispatchBackground!("subagent-callback", conversationId);
        } else {
          this.processSubagentCallback(conversationId, true).catch(err =>
            console.error(`[poncho][subagent-callback] Continuation failed:`, err instanceof Error ? err.message : err),
          );
        }
      }
    } catch (err) {
      console.error(`[poncho][subagent-callback] Error during parent re-run for ${conversationId}:`, err instanceof Error ? err.message : err);
      const errConv = await this.conversationStore.get(conversationId);
      if (errConv) {
        errConv.runningCallbackSince = undefined;
        errConv.runStatus = "idle";
        await this.conversationStore.update(errConv);
      }
    } finally {
      this.activeConversationRuns.delete(conversationId);

      const hadDeferredTrigger = this.pendingCallbackNeeded.delete(conversationId);
      const freshConv = await this.conversationStore.get(conversationId);
      const hasPendingInStore = !!freshConv?.pendingSubagentResults?.length;
      const hasRunningCallbackChildren = this.hasRunningSubagentsForParent(conversationId);

      if (!hadDeferredTrigger && !hasPendingInStore && !hasRunningCallbackChildren) {
        this.hooks?.onStreamEnd?.(conversationId);
      }

      if (hadDeferredTrigger || hasPendingInStore) {
        if (this.isServerless) {
          this.hooks!.dispatchBackground!("subagent-callback", conversationId);
        } else {
          this.processSubagentCallback(conversationId, true).catch(err =>
            console.error(`[poncho][subagent-callback] Recursive callback failed:`, err instanceof Error ? err.message : err),
          );
        }
      } else if (freshConv?.runningCallbackSince) {
        const afterClear = await this.conversationStore.clearCallbackLock(conversationId);
        if (afterClear?.pendingSubagentResults?.length) {
          if (this.isServerless) {
            this.hooks!.dispatchBackground!("subagent-callback", conversationId);
          } else {
            this.processSubagentCallback(conversationId, true).catch(err =>
              console.error(`[poncho][subagent-callback] Post-clear callback failed:`, err instanceof Error ? err.message : err),
            );
          }
        }
      }
    }
  }

  // ── Subagent continuation ──

  async *runSubagentContinuation(
    conversationId: string,
    conversation: Conversation,
    continuationMessages: Message[],
  ): AsyncGenerator<AgentEvent> {
    if (!this.hooks?.createChildHarness) {
      throw new Error("createChildHarness hook is required for subagent support");
    }

    const parentConversationId = conversation.parentConversationId!;
    const task = conversation.subagentMeta?.task ?? "";
    const ownerId = conversation.ownerId;

    const childHarness = await this.hooks.createChildHarness();
    childHarness.unregisterTools(["memory_main_write", "memory_main_edit"]);

    const childAbortController = this.activeConversationRuns.get(conversationId)?.abortController ?? new AbortController();
    this.activeSubagentRuns.set(conversationId, { abortController: childAbortController, harness: childHarness, parentConversationId });

    const draft = createTurnDraftState();
    let runResult: { status: string; response?: string; steps: number; duration: number; continuation?: boolean; continuationMessages?: Message[] } | undefined;

    try {
      const recallParams = this.hooks?.buildRecallParams?.({ ownerId, tenantId: conversation.tenantId, excludeConversationId: conversationId }) ?? {};

      for await (const event of childHarness.runWithTelemetry({
        conversationId,
        tenantId: conversation.tenantId ?? undefined,
        parameters: withToolResultArchiveParam({
          ...recallParams,
          __activeConversationId: conversationId,
          __ownerId: ownerId,
        }, conversation),
        messages: continuationMessages,
        abortSignal: childAbortController.signal,
      })) {
        if (event.type === "run:started") {
          const active = this.activeConversationRuns.get(conversationId);
          if (active) active.runId = event.runId;
        }
        recordStandardTurnEvent(draft, event);
        if (event.type === "run:completed") {
          runResult = {
            status: event.result.status,
            response: event.result.response,
            steps: event.result.steps,
            duration: event.result.duration,
            continuation: event.result.continuation,
            continuationMessages: event.result.continuationMessages,
          };
          if (!draft.assistantResponse && event.result.response) {
            draft.assistantResponse = event.result.response;
          }
        }
        if (event.type === "run:error") {
          draft.assistantResponse = draft.assistantResponse || `[Error: ${event.error.message}]`;
        }
        await this.eventSink(conversationId, event);
        yield event;
      }

      flushTurnDraft(draft);

      const conv = await this.conversationStore.get(conversationId);
      if (conv) {
        const hasContent = draft.assistantResponse.length > 0 || draft.toolTimeline.length > 0;
        if (runResult?.continuation && runResult.continuationMessages) {
          if (hasContent) {
            conv.messages.push({
              role: "assistant",
              content: draft.assistantResponse,
              metadata: buildAssistantMetadata(draft),
            });
          }
          conv._continuationMessages = runResult.continuationMessages;
          conv._continuationCount = conversation._continuationCount;
        } else {
          conv._continuationMessages = undefined;
          conv._continuationCount = undefined;
          if (hasContent) {
            conv.messages.push({
              role: "assistant",
              content: draft.assistantResponse,
              metadata: buildAssistantMetadata(draft),
            });
          }
        }
        if (runResult?.continuationMessages) {
          conv._harnessMessages = runResult.continuationMessages;
        } else {
          conv._harnessMessages = conv.messages;
        }
        conv._toolResultArchive = childHarness.getToolResultArchive(conversationId);
        conv.lastActivityAt = Date.now();
        conv.runStatus = "idle";
        conv.updatedAt = Date.now();

        if (runResult?.continuation) {
          await this.conversationStore.update(conv);
          this.activeSubagentRuns.delete(conversationId);
          try { await childHarness.shutdown(); } catch {}
          return;
        }

        conv.subagentMeta = { ...conv.subagentMeta!, status: "completed" };
        await this.conversationStore.update(conv);
      }

      this.activeSubagentRuns.delete(conversationId);
      await this.eventSink(parentConversationId, {
        type: "subagent:completed",
        subagentId: conversationId,
        conversationId,
      });

      let subagentResponse = runResult?.response ?? draft.assistantResponse;
      if (!subagentResponse) {
        const freshSubConv = await this.conversationStore.get(conversationId);
        if (freshSubConv) {
          const lastAssistant = [...freshSubConv.messages].reverse().find(m => m.role === "assistant");
          if (lastAssistant) {
            subagentResponse = typeof lastAssistant.content === "string" ? lastAssistant.content : "";
          }
        }
      }

      const parentConv = await this.conversationStore.get(parentConversationId);
      if (parentConv) {
        const result: PendingSubagentResult = {
          subagentId: conversationId,
          task,
          status: "completed",
          result: { status: "completed", response: subagentResponse, steps: runResult?.steps ?? 0, tokens: { input: 0, output: 0, cached: 0 }, duration: runResult?.duration ?? 0 },
          timestamp: Date.now(),
        };
        await this.conversationStore.appendSubagentResult(parentConversationId, result);

        if (this.isServerless) {
          this.hooks!.dispatchBackground!("subagent-callback", parentConversationId);
        } else {
          this.processSubagentCallback(parentConversationId).catch(err =>
            console.error(`[poncho][subagent] Callback failed:`, err instanceof Error ? err.message : err),
          );
        }
      }

      try { await childHarness.shutdown(); } catch {}
    } catch (err) {
      this.activeSubagentRuns.delete(conversationId);
      try { await childHarness.shutdown(); } catch {}

      const conv = await this.conversationStore.get(conversationId);
      if (conv) {
        conv.subagentMeta = { ...conv.subagentMeta!, status: "error", error: { code: "CONTINUATION_ERROR", message: err instanceof Error ? err.message : String(err) } };
        conv.runStatus = "idle";
        conv._continuationMessages = undefined;
        conv._continuationCount = undefined;
        conv.updatedAt = Date.now();
        await this.conversationStore.update(conv);
      }

      await this.eventSink(conversation.parentConversationId!, {
        type: "subagent:completed",
        subagentId: conversationId,
        conversationId,
      });

      const parentConv = await this.conversationStore.get(conversation.parentConversationId!);
      if (parentConv) {
        const result: PendingSubagentResult = {
          subagentId: conversationId,
          task,
          status: "error",
          error: { code: "CONTINUATION_ERROR", message: err instanceof Error ? err.message : String(err) },
          timestamp: Date.now(),
        };
        await this.conversationStore.appendSubagentResult(conversation.parentConversationId!, result);
        if (this.isServerless) {
          this.hooks!.dispatchBackground!("subagent-callback", conversation.parentConversationId!);
        } else {
          this.processSubagentCallback(conversation.parentConversationId!).catch(() => {});
        }
      }
    }
  }

  // ── SubagentManager factory ──

  createSubagentManager(): SubagentManager {
    return {
      spawn: async (opts): Promise<SubagentSpawnResult> => {
        const depth = await this.getSubagentDepth(opts.parentConversationId);
        if (depth >= MAX_SUBAGENT_NESTING - 1) {
          throw new Error(`Maximum subagent nesting (${MAX_SUBAGENT_NESTING} levels) reached. Cannot spawn deeper subagents.`);
        }
        if (this.getRunningSubagentCountForParent(opts.parentConversationId) >= MAX_CONCURRENT_SUBAGENTS) {
          throw new Error(`Maximum concurrent subagents (${MAX_CONCURRENT_SUBAGENTS}) per parent reached. Wait for running subagents to complete or stop some first.`);
        }

        const conversation = await this.conversationStore.create(
          opts.ownerId,
          opts.task.slice(0, 80),
          opts.tenantId ?? null,
          {
            parentConversationId: opts.parentConversationId,
            subagentMeta: { task: opts.task, status: "running" },
            messages: [{ role: "user", content: opts.task }],
          },
        );

        this.recentlySpawnedParents.set(
          opts.parentConversationId,
          (this.recentlySpawnedParents.get(opts.parentConversationId) ?? 0) + 1,
        );

        await this.eventSink(opts.parentConversationId, {
          type: "subagent:spawned",
          subagentId: conversation.conversationId,
          conversationId: conversation.conversationId,
          task: opts.task,
        });

        if (this.isServerless) {
          this.hooks!.dispatchBackground!("subagent-run", conversation.conversationId);
        } else {
          this.runSubagent(
            conversation.conversationId,
            opts.parentConversationId,
            opts.task,
            opts.ownerId,
          ).catch(err => console.error(`[poncho][subagent] Background spawn failed:`, err instanceof Error ? err.message : err));
        }

        return { subagentId: conversation.conversationId };
      },

      sendMessage: async (subagentId, message): Promise<SubagentSpawnResult> => {
        const conversation = await this.conversationStore.get(subagentId);
        if (!conversation) {
          console.error(`[poncho][subagent] sendMessage: conversation "${subagentId}" not found in store`);
          throw new Error(`Subagent "${subagentId}" not found.`);
        }
        if (!conversation.parentConversationId) {
          throw new Error(`Conversation "${subagentId}" is not a subagent.`);
        }
        if (!conversation.subagentMeta) {
          console.warn(`[poncho][subagent] sendMessage: conversation "${subagentId}" missing subagentMeta, recovering`);
          conversation.subagentMeta = { task: conversation.title, status: "stopped" };
          await this.conversationStore.update(conversation);
        }
        if (conversation.subagentMeta.status === "running") {
          throw new Error(`Subagent "${subagentId}" is currently running. Wait for it to complete before sending a new message.`);
        }

        conversation.messages.push({ role: "user", content: message });
        conversation.subagentMeta.status = "running";
        conversation.updatedAt = Date.now();
        await this.conversationStore.update(conversation);

        if (this.isServerless) {
          this.hooks!.dispatchBackground!("subagent-run", subagentId);
        } else {
          this.runSubagent(
            subagentId,
            conversation.parentConversationId,
            message,
            conversation.ownerId,
          ).catch(err => console.error(`[poncho][subagent] Background sendMessage failed:`, err instanceof Error ? err.message : err));
        }

        return { subagentId };
      },

      stop: async (subagentId) => {
        const active = this.activeSubagentRuns.get(subagentId);
        if (active) {
          active.abortController.abort();
        }
        const conversation = await this.conversationStore.get(subagentId);
        if (conversation?.subagentMeta && conversation.subagentMeta.status === "running") {
          conversation.subagentMeta.status = "stopped";
          conversation.updatedAt = Date.now();
          await this.conversationStore.update(conversation);
        }
      },

      list: async (parentConversationId) => {
        const parentConv = await this.conversationStore.get(parentConversationId);
        const summaries = await this.conversationStore.listSummaries(parentConv?.ownerId ?? "local-owner");
        const childSummaries = summaries.filter((s) => s.parentConversationId === parentConversationId);
        const results: Array<{ subagentId: string; task: string; status: string; messageCount: number }> = [];
        for (const s of childSummaries) {
          const c = await this.conversationStore.get(s.conversationId);
          if (c) {
            results.push({
              subagentId: c.conversationId,
              task: c.subagentMeta?.task ?? c.title,
              status: c.subagentMeta?.status ?? "stopped",
              messageCount: c.messages.length,
            });
          }
        }
        return results;
      },
    };
  }

  // ── Stale subagent recovery ──

  async recoverStaleSubagents(): Promise<void> {
    const allSummaries = await this.conversationStore.listSummaries();
    const subagentSummaries = allSummaries.filter((s) => s.parentConversationId);
    if (subagentSummaries.length === 0) return;
    const parentsToCallback = new Set<string>();
    const CONCURRENCY = 10;
    for (let i = 0; i < subagentSummaries.length; i += CONCURRENCY) {
      const batch = subagentSummaries.slice(i, i + CONCURRENCY);
      const convs = await Promise.all(batch.map((s) => this.conversationStore.get(s.conversationId)));
      for (const conv of convs) {
        if (conv?.subagentMeta?.status === "running" && conv.parentConversationId) {
          const lastActivity = conv.lastActivityAt ?? conv.updatedAt;
          const elapsed = Date.now() - lastActivity;
          if (elapsed < STALE_SUBAGENT_THRESHOLD_MS) continue;

          conv.subagentMeta.status = "error";
          conv.subagentMeta.error = { code: "STALE_SUBAGENT", message: `Subagent inactive for ${Math.round(elapsed / 1000)}s (threshold: ${STALE_SUBAGENT_THRESHOLD_MS / 1000}s)` };
          conv.updatedAt = Date.now();
          await this.conversationStore.update(conv);

          const pendingResult: PendingSubagentResult = {
            subagentId: conv.conversationId,
            task: conv.subagentMeta.task,
            status: "error",
            error: conv.subagentMeta.error,
            timestamp: Date.now(),
          };
          await this.conversationStore.appendSubagentResult(conv.parentConversationId, pendingResult);
          parentsToCallback.add(conv.parentConversationId);
        }
      }
    }
    for (const parentId of parentsToCallback) {
      this.processSubagentCallback(parentId).catch(err =>
        console.error(`[poncho][subagent] Recovery callback failed for ${parentId}:`, err instanceof Error ? err.message : err),
      );
    }
  }
}
