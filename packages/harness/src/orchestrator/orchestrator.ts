import type { AgentEvent, Message } from "@poncho-ai/sdk";
import type { Conversation, ConversationStore } from "../state.js";
import type { AgentHarness } from "../harness.js";
import type { TelemetryEmitter } from "../telemetry.js";
import {
  executeConversationTurn,
  flushTurnDraft,
  buildAssistantMetadata,
  applyTurnMetadata,
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
export interface ContinuationHooks {
  /** Called before a continuation run starts. Resets/creates event streams. */
  onContinuationStart?(conversationId: string): void;
  /** Called after a continuation run finishes. Cleans up event streams. */
  onContinuationEnd?(conversationId: string): void;
  /** Called when a subagent conversation needs continuation. The orchestrator
   *  delegates subagent continuation to the CLI since it requires child harness
   *  creation and subagent lifecycle management (Phase 5). */
  runSubagentContinuation?(
    conversationId: string,
    conversation: Conversation,
    continuationMessages: Message[],
  ): AsyncGenerator<AgentEvent>;
}

export interface OrchestratorOptions {
  harness: AgentHarness;
  conversationStore: ConversationStore;
  eventSink: EventSink;
  telemetry?: TelemetryEmitter;
  continuationHooks?: ContinuationHooks;
}

// ── AgentOrchestrator ──

export class AgentOrchestrator {
  readonly harness: AgentHarness;
  readonly conversationStore: ConversationStore;
  readonly eventSink: EventSink;
  readonly telemetry?: TelemetryEmitter;
  private continuationHooks?: ContinuationHooks;

  // ── Runtime state ──
  readonly activeConversationRuns = new Map<string, ActiveConversationRun>();
  readonly runOwners = new Map<string, string>();
  readonly runConversations = new Map<string, string>();

  constructor(options: OrchestratorOptions) {
    this.harness = options.harness;
    this.conversationStore = options.conversationStore;
    this.eventSink = options.eventSink;
    this.telemetry = options.telemetry;
    this.continuationHooks = options.continuationHooks;
  }

  setContinuationHooks(hooks: ContinuationHooks): void {
    this.continuationHooks = hooks;
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

    this.continuationHooks?.onContinuationStart?.(conversationId);

    try {
      if (conversation.parentConversationId && this.continuationHooks?.runSubagentContinuation) {
        for await (const event of this.continuationHooks.runSubagentContinuation(conversationId, conversation, continuationMessages)) {
          if (onYield) await onYield(event);
        }
      } else if (!conversation.parentConversationId) {
        await this.runChatContinuation(conversationId, conversation, continuationMessages, onYield);
      }
    } finally {
      this.activeConversationRuns.delete(conversationId);
      this.continuationHooks?.onContinuationEnd?.(conversationId);
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
}
