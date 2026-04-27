/**
 * Shared API response types used by both the CLI server and the client SDK.
 * Defining them here ensures compile-time drift detection between the two.
 */

export interface ApiApprovalResponse {
  ok: true;
  approvalId: string;
  approved: boolean;
  batchComplete?: boolean;
}

export interface ApiStopRunResponse {
  ok: true;
  stopped: boolean;
  runId?: string;
}

export interface ApiCompactResponse {
  compacted: boolean;
  messagesBefore: number;
  messagesAfter: number;
  warning?: string;
}

export interface ApiSubagentSummary {
  conversationId: string;
  title: string;
  task: string;
  status: string;
  messageCount: number;
  hasPendingApprovals: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiThreadSummary {
  conversationId: string;
  parentConversationId: string;
  parentMessageId: string;
  title: string;
  parentMessageSummary?: string;
  messageCount: number;
  /** messageCount - snapshotLength: number of replies posted into the thread. */
  replyCount: number;
  snapshotLength: number;
  createdAt: number;
  updatedAt: number;
  /** Same as updatedAt; named for the inline-row UI. */
  lastReplyAt: number;
}

export interface ApiThreadListResponse {
  threads: ApiThreadSummary[];
}

export interface ApiCreateThreadRequest {
  parentMessageId: string;
  title?: string;
}

export interface ApiCreateThreadResponse {
  thread: ApiThreadSummary;
  conversationId: string;
}

export interface ApiSecretEntry {
  name: string;
  label?: string;
  isSet: boolean;
}

export interface ApiSlashCommand {
  command: string;
  description: string;
  type: "command" | "skill";
}
