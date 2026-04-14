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
