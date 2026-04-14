import type { AgentEvent } from "@poncho-ai/sdk";
import type { ApiCompactResponse, ApiStopRunResponse } from "@poncho-ai/sdk";
import type { BaseClient } from "./base.js";
import type { ConversationRecord, ConversationSummary } from "./types.js";

export interface SubscribeToEventsOptions {
  liveOnly?: boolean;
  signal?: AbortSignal;
}

export function listConversations(this: BaseClient): Promise<ConversationSummary[]> {
  return this.json<{ conversations: ConversationSummary[] }>(
    "/api/conversations",
  ).then((p) => p.conversations);
}

export async function createConversation(
  this: BaseClient,
  input?: { title?: string },
): Promise<ConversationRecord> {
  return this.json<{ conversation: ConversationRecord }>("/api/conversations", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  }).then((p) => p.conversation);
}

export async function getConversation(
  this: BaseClient,
  conversationId: string,
): Promise<ConversationRecord> {
  return this.json<{ conversation: ConversationRecord }>(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
  ).then((p) => p.conversation);
}

export async function getConversationStatus(
  this: BaseClient,
  conversationId: string,
): Promise<{
  conversation: ConversationRecord;
  hasActiveRun: boolean;
  hasRunningSubagents: boolean;
  needsContinuation?: boolean;
}> {
  return this.json(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
  );
}

export async function deleteConversation(
  this: BaseClient,
  conversationId: string,
): Promise<void> {
  await this.json(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE" },
  );
}

export async function renameConversation(
  this: BaseClient,
  conversationId: string,
  title: string,
): Promise<ConversationRecord> {
  return this.json<{ conversation: ConversationRecord }>(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ title }),
    },
  ).then((p) => p.conversation);
}

export async function stopRun(
  this: BaseClient,
  conversationId: string,
  runId?: string,
): Promise<ApiStopRunResponse> {
  return this.json<ApiStopRunResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/stop`,
    {
      method: "POST",
      body: JSON.stringify({ runId }),
    },
  );
}

export async function compactConversation(
  this: BaseClient,
  conversationId: string,
  instructions?: string,
): Promise<ApiCompactResponse> {
  return this.json<ApiCompactResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/compact`,
    {
      method: "POST",
      body: JSON.stringify({ instructions }),
    },
  );
}

export async function listTodos(
  this: BaseClient,
  conversationId: string,
): Promise<unknown[]> {
  return this.json<{ todos: unknown[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/todos`,
  ).then((p) => p.todos);
}

export async function* subscribeToEvents(
  this: BaseClient,
  conversationId: string,
  options?: SubscribeToEventsOptions,
): AsyncGenerator<AgentEvent> {
  const params: Record<string, string | undefined> = {};
  if (options?.liveOnly) params.live_only = "true";

  const url = this.buildUrl(
    `/api/conversations/${encodeURIComponent(conversationId)}/events`,
    params,
  );

  const response = await this.fetchImpl(`${this.baseUrl}${url}`, {
    method: "GET",
    headers: this.headers(),
    signal: options?.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Subscribe to events failed: HTTP ${response.status}`);
  }

  yield* this.readSseStream(response);
}
