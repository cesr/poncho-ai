import type { ContentPart, RunResult } from "@poncho-ai/sdk";

export interface SyncRunResponse {
  runId: string;
  status: RunResult["status"];
  result: RunResult;
  pendingSubagents?: boolean;
}

export interface ContinueInput {
  runId: string;
  message: string;
  parameters?: Record<string, unknown>;
}

export interface ConversationSummary {
  conversationId: string;
  title: string;
  runtimeRunId?: string;
  ownerId: string;
  tenantId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  parentConversationId?: string;
  parentMessageId?: string;
}

export interface FileAttachment {
  /** base64-encoded file data or a URL */
  data: string;
  mediaType: string;
  filename?: string;
}

export interface ConversationRecord extends Omit<ConversationSummary, "messageCount"> {
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>;
}
