import type { AgentHarness } from "../harness.js";
import type { Conversation } from "../state.js";

// ── Types ──

export type ActiveSubagentRun = {
  abortController: AbortController;
  harness: AgentHarness;
  parentConversationId: string;
};

export type PendingSubagentApproval = {
  resolve: (decidedApprovals: NonNullable<Conversation["pendingApprovals"]>) => void;
  childHarness: AgentHarness;
  checkpoint: NonNullable<Conversation["pendingApprovals"]>[number];
  childConversationId: string;
  parentConversationId: string;
};

// ── Constants ──

/** root -> L1 -> L2 = 3 levels; L2 cannot spawn further */
export const MAX_SUBAGENT_NESTING = 3;
export const MAX_CONCURRENT_SUBAGENTS = 2;
export const MAX_SUBAGENT_CALLBACK_COUNT = 20;
export const CALLBACK_LOCK_STALE_MS = 5 * 60 * 1000;
export const STALE_SUBAGENT_THRESHOLD_MS = 5 * 60 * 1000;
