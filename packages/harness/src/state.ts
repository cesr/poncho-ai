import type { Message } from "@poncho-ai/sdk";

export interface ConversationState {
  runId: string;
  messages: Message[];
  updatedAt: number;
}

export interface StateStore {
  get(runId: string): Promise<ConversationState | undefined>;
  set(state: ConversationState): Promise<void>;
  delete(runId: string): Promise<void>;
}

export interface PendingSubagentResult {
  subagentId: string;
  task: string;
  status: "completed" | "error" | "stopped";
  result?: import("@poncho-ai/sdk").RunResult;
  error?: import("@poncho-ai/sdk").AgentFailure;
  timestamp: number;
}

export interface ArchivedToolResult {
  toolResultId: string;
  conversationId: string;
  toolName: string;
  toolCallId: string;
  createdAt: number;
  sizeBytes: number;
  payload: string;
}

export interface Conversation {
  conversationId: string;
  title: string;
  messages: Message[];
  compactedHistory?: Message[];
  runtimeRunId?: string;
  pendingApprovals?: Array<{
    approvalId: string;
    runId: string;
    tool: string;
    toolCallId?: string;
    input: Record<string, unknown>;
    checkpointMessages?: Message[];
    baseMessageCount?: number;
    pendingToolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    decision?: "approved" | "denied";
  }>;
  runStatus?: "running" | "idle";
  ownerId: string;
  tenantId: string | null;
  contextTokens?: number;
  contextWindow?: number;
  parentConversationId?: string;
  subagentMeta?: {
    task: string;
    status: "running" | "completed" | "error" | "stopped";
    result?: import("@poncho-ai/sdk").RunResult;
    error?: import("@poncho-ai/sdk").AgentFailure;
  };
  channelMeta?: {
    platform: string;
    channelId: string;
    platformThreadId: string;
  };
  pendingSubagentResults?: PendingSubagentResult[];
  subagentCallbackCount?: number;
  runningCallbackSince?: number;
  lastActivityAt?: number;
  _continuationMessages?: Message[];
  _continuationCount?: number;
  _harnessMessages?: Message[];
  _toolResultArchive?: Record<string, ArchivedToolResult>;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationStore {
  list(ownerId?: string, tenantId?: string | null): Promise<Conversation[]>;
  listSummaries(ownerId?: string, tenantId?: string | null): Promise<ConversationSummary[]>;
  get(conversationId: string): Promise<Conversation | undefined>;
  create(ownerId?: string, title?: string, tenantId?: string | null): Promise<Conversation>;
  update(conversation: Conversation): Promise<void>;
  rename(conversationId: string, title: string): Promise<Conversation | undefined>;
  delete(conversationId: string): Promise<boolean>;
  appendSubagentResult(conversationId: string, result: PendingSubagentResult): Promise<void>;
  clearCallbackLock(conversationId: string): Promise<Conversation | undefined>;
}

export type StateProviderName =
  | "local"
  | "memory"
  | "sqlite"
  | "postgresql"
  | "redis"
  | "upstash"
  | "dynamodb";

export interface StateConfig {
  provider?: StateProviderName;
  ttl?: number;
  urlEnv?: string;
  tokenEnv?: string;
  table?: string;
  region?: string;
}

const DEFAULT_OWNER = "local-owner";

const normalizeTitle = (title?: string): string => {
  return title && title.trim().length > 0 ? title.trim() : "New conversation";
};

export class InMemoryStateStore implements StateStore {
  private readonly store = new Map<string, ConversationState>();
  private readonly ttlMs?: number;

  constructor(ttlSeconds?: number) {
    this.ttlMs = typeof ttlSeconds === "number" ? ttlSeconds * 1000 : undefined;
  }

  private isExpired(state: ConversationState): boolean {
    return typeof this.ttlMs === "number" && Date.now() - state.updatedAt > this.ttlMs;
  }

  async get(runId: string): Promise<ConversationState | undefined> {
    const state = this.store.get(runId);
    if (!state) return undefined;
    if (this.isExpired(state)) {
      this.store.delete(runId);
      return undefined;
    }
    return state;
  }

  async set(state: ConversationState): Promise<void> {
    this.store.set(state.runId, { ...state, updatedAt: Date.now() });
  }

  async delete(runId: string): Promise<void> {
    this.store.delete(runId);
  }
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly ttlMs?: number;

  constructor(ttlSeconds?: number) {
    this.ttlMs = typeof ttlSeconds === "number" ? ttlSeconds * 1000 : undefined;
  }

  private isExpired(updatedAt: number): boolean {
    return typeof this.ttlMs === "number" && Date.now() - updatedAt > this.ttlMs;
  }

  private purgeExpired(): void {
    for (const [conversationId, conversation] of this.conversations.entries()) {
      if (this.isExpired(conversation.updatedAt)) {
        this.conversations.delete(conversationId);
      }
    }
  }

  async list(ownerId?: string, tenantId?: string | null): Promise<Conversation[]> {
    this.purgeExpired();
    return Array.from(this.conversations.values())
      .filter((conversation) => !ownerId || conversation.ownerId === ownerId)
      .filter((c) => tenantId === undefined || c.tenantId === tenantId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listSummaries(ownerId?: string, tenantId?: string | null): Promise<ConversationSummary[]> {
    this.purgeExpired();
    return Array.from(this.conversations.values())
      .filter((c) => !ownerId || c.ownerId === ownerId)
      .filter((c) => tenantId === undefined || c.tenantId === tenantId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({
        conversationId: c.conversationId,
        title: c.title,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
        ownerId: c.ownerId,
        tenantId: c.tenantId,
        parentConversationId: c.parentConversationId,
        messageCount: c.messages.length,
        hasPendingApprovals: Array.isArray(c.pendingApprovals) && c.pendingApprovals.length > 0,
        channelMeta: c.channelMeta,
      }));
  }

  async get(conversationId: string): Promise<Conversation | undefined> {
    this.purgeExpired();
    return this.conversations.get(conversationId);
  }

  async create(ownerId = DEFAULT_OWNER, title?: string, tenantId: string | null = null): Promise<Conversation> {
    const now = Date.now();
    const conversation: Conversation = {
      conversationId: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random()}`,
      title: normalizeTitle(title),
      messages: [],
      ownerId,
      tenantId,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(conversation.conversationId, conversation);
    return conversation;
  }

  async update(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.conversationId, {
      ...conversation,
      updatedAt: Date.now(),
    });
  }

  async rename(conversationId: string, title: string): Promise<Conversation | undefined> {
    const existing = await this.get(conversationId);
    if (!existing) return undefined;
    const updated: Conversation = {
      ...existing,
      title: normalizeTitle(title || existing.title),
      updatedAt: Date.now(),
    };
    this.conversations.set(conversationId, updated);
    return updated;
  }

  async delete(conversationId: string): Promise<boolean> {
    return this.conversations.delete(conversationId);
  }

  async appendSubagentResult(conversationId: string, result: PendingSubagentResult): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    if (!conversation.pendingSubagentResults) conversation.pendingSubagentResults = [];
    conversation.pendingSubagentResults.push(result);
    conversation.updatedAt = Date.now();
  }

  async clearCallbackLock(conversationId: string): Promise<Conversation | undefined> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return undefined;
    conversation.runningCallbackSince = undefined;
    conversation.updatedAt = Date.now();
    return conversation;
  }
}

export type ConversationSummary = {
  conversationId: string;
  title: string;
  updatedAt: number;
  createdAt?: number;
  ownerId: string;
  tenantId?: string | null;
  parentConversationId?: string;
  messageCount?: number;
  hasPendingApprovals?: boolean;
  channelMeta?: {
    platform: string;
    channelId: string;
    platformThreadId: string;
  };
};

// ---------------------------------------------------------------------------
// Legacy factories — return InMemory stores. The harness now uses
// engine-backed stores via storage/store-adapters.ts. These factories
// exist only for backward compatibility with external callers and tests.
// ---------------------------------------------------------------------------

export const createStateStore = (
  config?: StateConfig,
  _options?: { workingDir?: string; agentId?: string },
): StateStore => {
  const ttl = config?.ttl;
  return new InMemoryStateStore(ttl);
};

export const createConversationStore = (
  config?: StateConfig,
  _options?: { workingDir?: string; agentId?: string },
): ConversationStore => {
  const ttl = config?.ttl;
  return new InMemoryConversationStore(ttl);
};
