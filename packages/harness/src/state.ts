import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Message } from "@poncho-ai/sdk";
import {
  ensureAgentIdentity,
  getAgentStoreDirectory,
  slugifyStorageComponent,
  STORAGE_SCHEMA_VERSION,
} from "./agent-identity.js";

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

export interface Conversation {
  conversationId: string;
  title: string;
  messages: Message[];
  runtimeRunId?: string;
  pendingApprovals?: Array<{
    approvalId: string;
    runId: string;
    tool: string;
    input: Record<string, unknown>;
  }>;
  ownerId: string;
  tenantId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationStore {
  list(ownerId?: string): Promise<Conversation[]>;
  get(conversationId: string): Promise<Conversation | undefined>;
  create(ownerId?: string, title?: string): Promise<Conversation>;
  update(conversation: Conversation): Promise<void>;
  rename(conversationId: string, title: string): Promise<Conversation | undefined>;
  delete(conversationId: string): Promise<boolean>;
}

export type StateProviderName =
  | "local"
  | "memory"
  | "redis"
  | "upstash"
  | "dynamodb";

export interface StateConfig {
  provider?: StateProviderName;
  ttl?: number;
  url?: string;
  token?: string;
  table?: string;
  region?: string;
}

const DEFAULT_OWNER = "local-owner";
const LOCAL_STATE_FILE = "state.json";
const CONVERSATIONS_DIRECTORY = "conversations";
const LOCAL_CONVERSATION_INDEX_FILE = "index.json";

type StoreIdentityOptions = {
  workingDir: string;
  agentId?: string;
};

const toStoreIdentity = async ({
  workingDir,
  agentId,
}: StoreIdentityOptions): Promise<{ name: string; id: string }> => {
  const ensured = await ensureAgentIdentity(workingDir);
  if (!agentId) {
    return ensured;
  }
  return { name: ensured.name, id: agentId };
};

const writeJsonAtomic = async (filePath: string, payload: unknown): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmpPath, filePath);
};

const formatUtcTimestamp = (value: number): string =>
  new Date(value)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

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
    if (!state) {
      return undefined;
    }
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

class UpstashStateStore implements StateStore {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly ttl?: number;

  constructor(baseUrl: string, token: string, ttl?: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.ttl = ttl;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  async get(runId: string): Promise<ConversationState | undefined> {
    const response = await fetch(`${this.baseUrl}/get/${encodeURIComponent(runId)}`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as { result?: string | null };
    if (!payload.result) {
      return undefined;
    }
    return JSON.parse(payload.result) as ConversationState;
  }

  async set(state: ConversationState): Promise<void> {
    const serialized = JSON.stringify({ ...state, updatedAt: Date.now() });
    const path =
      typeof this.ttl === "number"
        ? `${this.baseUrl}/setex/${encodeURIComponent(state.runId)}/${Math.max(
            1,
            this.ttl,
          )}/${encodeURIComponent(serialized)}`
        : `${this.baseUrl}/set/${encodeURIComponent(state.runId)}/${encodeURIComponent(
            serialized,
          )}`;
    await fetch(path, { method: "POST", headers: this.headers() });
  }

  async delete(runId: string): Promise<void> {
    await fetch(`${this.baseUrl}/del/${encodeURIComponent(runId)}`, {
      method: "POST",
      headers: this.headers(),
    });
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

  async list(ownerId = DEFAULT_OWNER): Promise<Conversation[]> {
    this.purgeExpired();
    return Array.from(this.conversations.values())
      .filter((conversation) => conversation.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(conversationId: string): Promise<Conversation | undefined> {
    this.purgeExpired();
    return this.conversations.get(conversationId);
  }

  async create(ownerId = DEFAULT_OWNER, title?: string): Promise<Conversation> {
    const now = Date.now();
    const conversation: Conversation = {
      conversationId: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random()}`,
      title: normalizeTitle(title),
      messages: [],
      ownerId,
      tenantId: null,
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
    if (!existing) {
      return undefined;
    }
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
}

type ConversationStoreFile = {
  schemaVersion: string;
  conversations: Array<{
    conversationId: string;
    title: string;
    updatedAt: number;
    ownerId: string;
    fileName: string;
  }>;
};

class FileConversationStore implements ConversationStore {
  private readonly workingDir: string;
  private readonly agentId?: string;
  private readonly conversations = new Map<string, ConversationStoreFile["conversations"][number]>();
  private loaded = false;
  private writing = Promise.resolve();
  private paths?: { conversationsDir: string; indexPath: string };

  constructor(workingDir: string, agentId?: string) {
    this.workingDir = workingDir;
    this.agentId = agentId;
  }

  private async resolvePaths(): Promise<{ conversationsDir: string; indexPath: string }> {
    if (this.paths) {
      return this.paths;
    }
    const identity = await toStoreIdentity({
      workingDir: this.workingDir,
      agentId: this.agentId,
    });
    const agentDir = getAgentStoreDirectory(identity);
    const conversationsDir = resolve(agentDir, CONVERSATIONS_DIRECTORY);
    const indexPath = resolve(conversationsDir, LOCAL_CONVERSATION_INDEX_FILE);
    this.paths = { conversationsDir, indexPath };
    return this.paths;
  }

  private async writeIndex(): Promise<void> {
    const { indexPath } = await this.resolvePaths();
    const payload: ConversationStoreFile = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      conversations: Array.from(this.conversations.values()).sort((a, b) => b.updatedAt - a.updatedAt),
    };
    await writeJsonAtomic(indexPath, payload);
  }

  private async readConversationFile(fileName: string): Promise<Conversation | undefined> {
    const { conversationsDir } = await this.resolvePaths();
    const filePath = resolve(conversationsDir, fileName);
    try {
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as Conversation;
    } catch {
      return undefined;
    }
  }

  private async rebuildIndexFromFiles(): Promise<void> {
    const { conversationsDir } = await this.resolvePaths();
    this.conversations.clear();
    try {
      const entries = await readdir(conversationsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.name === LOCAL_CONVERSATION_INDEX_FILE) {
          continue;
        }
        const conversation = await this.readConversationFile(entry.name);
        if (!conversation) {
          continue;
        }
        this.conversations.set(conversation.conversationId, {
          conversationId: conversation.conversationId,
          title: conversation.title,
          updatedAt: conversation.updatedAt,
          ownerId: conversation.ownerId,
          fileName: entry.name,
        });
      }
    } catch {
      // Missing directory should behave like empty.
    }
    await this.writeIndex();
  }

  private resolveConversationFileName(conversation: Conversation): string {
    const ts = formatUtcTimestamp(conversation.createdAt || Date.now());
    return `${ts}--${slugifyStorageComponent(conversation.conversationId)}.json`;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const { indexPath } = await this.resolvePaths();
    try {
      const raw = await readFile(indexPath, "utf8");
      const parsed = JSON.parse(raw) as ConversationStoreFile;
      for (const conversation of parsed.conversations ?? []) {
        this.conversations.set(conversation.conversationId, conversation);
      }
    } catch {
      await this.rebuildIndexFromFiles();
    }
  }

  private async persistConversation(conversation: Conversation): Promise<void> {
    const { conversationsDir } = await this.resolvePaths();
    const existing = this.conversations.get(conversation.conversationId);
    const fileName = existing?.fileName ?? this.resolveConversationFileName(conversation);
    const filePath = resolve(conversationsDir, fileName);
    this.writing = this.writing.then(async () => {
      await writeJsonAtomic(filePath, conversation);
      this.conversations.set(conversation.conversationId, {
        conversationId: conversation.conversationId,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        ownerId: conversation.ownerId,
        fileName,
      });
      await this.writeIndex();
    });
    await this.writing;
  }

  async list(ownerId = DEFAULT_OWNER): Promise<Conversation[]> {
    await this.ensureLoaded();
    const summaries = Array.from(this.conversations.values())
      .filter((conversation) => conversation.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const conversations: Conversation[] = [];
    for (const summary of summaries) {
      const loaded = await this.readConversationFile(summary.fileName);
      if (loaded) {
        conversations.push(loaded);
      }
    }
    return conversations;
  }

  async get(conversationId: string): Promise<Conversation | undefined> {
    await this.ensureLoaded();
    const summary = this.conversations.get(conversationId);
    if (!summary) {
      return undefined;
    }
    return await this.readConversationFile(summary.fileName);
  }

  async create(ownerId = DEFAULT_OWNER, title?: string): Promise<Conversation> {
    await this.ensureLoaded();
    const now = Date.now();
    const conversation: Conversation = {
      conversationId: randomUUID(),
      title: normalizeTitle(title),
      messages: [],
      ownerId,
      tenantId: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.persistConversation(conversation);
    return conversation;
  }

  async update(conversation: Conversation): Promise<void> {
    await this.ensureLoaded();
    const next = {
      ...conversation,
      updatedAt: Date.now(),
    };
    await this.persistConversation(next);
  }

  async rename(conversationId: string, title: string): Promise<Conversation | undefined> {
    await this.ensureLoaded();
    const existing = await this.get(conversationId);
    if (!existing) {
      return undefined;
    }
    const updated: Conversation = {
      ...existing,
      title: normalizeTitle(title || existing.title),
      updatedAt: Date.now(),
    };
    await this.persistConversation(updated);
    return updated;
  }

  async delete(conversationId: string): Promise<boolean> {
    await this.ensureLoaded();
    const { conversationsDir } = await this.resolvePaths();
    const existing = this.conversations.get(conversationId);
    const removed = this.conversations.delete(conversationId);
    if (removed) {
      this.writing = this.writing.then(async () => {
        if (existing) {
          await rm(resolve(conversationsDir, existing.fileName), { force: true });
        }
        await this.writeIndex();
      });
      await this.writing;
    }
    return removed;
  }
}

type LocalStateFile = {
  states: ConversationState[];
};

class FileStateStore implements StateStore {
  private readonly workingDir: string;
  private readonly agentId?: string;
  private filePath = "";
  private readonly states = new Map<string, ConversationState>();
  private readonly ttlMs?: number;
  private loaded = false;
  private writing = Promise.resolve();

  constructor(workingDir: string, ttlSeconds?: number, agentId?: string) {
    this.workingDir = workingDir;
    this.agentId = agentId;
    this.ttlMs = typeof ttlSeconds === "number" ? ttlSeconds * 1000 : undefined;
  }

  private async ensureFilePath(): Promise<void> {
    if (this.filePath) {
      return;
    }
    const identity = await toStoreIdentity({
      workingDir: this.workingDir,
      agentId: this.agentId,
    });
    this.filePath = resolve(getAgentStoreDirectory(identity), LOCAL_STATE_FILE);
  }

  private isExpired(state: ConversationState): boolean {
    return typeof this.ttlMs === "number" && Date.now() - state.updatedAt > this.ttlMs;
  }

  private async ensureLoaded(): Promise<void> {
    await this.ensureFilePath();
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as LocalStateFile;
      for (const state of parsed.states ?? []) {
        this.states.set(state.runId, state);
      }
    } catch {
      // Missing/invalid file should not crash local mode.
    }
  }

  private async persist(): Promise<void> {
    const payload: LocalStateFile = {
      states: Array.from(this.states.values()),
    };
    this.writing = this.writing.then(async () => {
      await writeJsonAtomic(this.filePath, payload);
    });
    await this.writing;
  }

  async get(runId: string): Promise<ConversationState | undefined> {
    await this.ensureLoaded();
    const state = this.states.get(runId);
    if (!state) {
      return undefined;
    }
    if (this.isExpired(state)) {
      this.states.delete(runId);
      await this.persist();
      return undefined;
    }
    return state;
  }

  async set(state: ConversationState): Promise<void> {
    await this.ensureLoaded();
    this.states.set(state.runId, { ...state, updatedAt: Date.now() });
    await this.persist();
  }

  async delete(runId: string): Promise<void> {
    await this.ensureLoaded();
    this.states.delete(runId);
    await this.persist();
  }
}

interface RawKeyValueClient {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
}

type ConversationMeta = {
  conversationId: string;
  title: string;
  updatedAt: number;
  ownerId: string;
};

abstract class KeyValueConversationStoreBase implements ConversationStore {
  protected readonly ttl?: number;
  private readonly agentIdPromise: Promise<string>;
  private readonly ownerLocks = new Map<string, Promise<void>>();
  protected readonly memoryFallback: InMemoryConversationStore;

  constructor(ttl: number | undefined, workingDir: string, agentId?: string) {
    this.ttl = ttl;
    this.memoryFallback = new InMemoryConversationStore(ttl);
    this.agentIdPromise = toStoreIdentity({ workingDir, agentId }).then((identity) => identity.id);
  }

  protected abstract client(): Promise<RawKeyValueClient | undefined>;

  private async withOwnerLock(ownerId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.ownerLocks.get(ownerId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.ownerLocks.set(ownerId, next);
    try {
      await next;
    } finally {
      if (this.ownerLocks.get(ownerId) === next) {
        this.ownerLocks.delete(ownerId);
      }
    }
  }

  private async namespace(): Promise<string> {
    const agentId = await this.agentIdPromise;
    return `poncho:${STORAGE_SCHEMA_VERSION}:${slugifyStorageComponent(agentId)}`;
  }

  private async conversationKey(conversationId: string): Promise<string> {
    return `${await this.namespace()}:conv:${conversationId}`;
  }

  private async conversationMetaKey(conversationId: string): Promise<string> {
    return `${await this.namespace()}:convmeta:${conversationId}`;
  }

  private async ownerIndexKey(ownerId: string): Promise<string> {
    return `${await this.namespace()}:owner:${slugifyStorageComponent(ownerId)}:conversations`;
  }

  private async getOwnerConversationIds(ownerId: string): Promise<string[]> {
    const kv = await this.client();
    if (!kv) {
      return [];
    }
    try {
      const raw = await kv.get(await this.ownerIndexKey(ownerId));
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as { ids?: string[] };
      return Array.isArray(parsed.ids)
        ? parsed.ids.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      return [];
    }
  }

  private async setOwnerConversationIds(ownerId: string, ids: string[]): Promise<void> {
    const kv = await this.client();
    if (!kv) {
      return;
    }
    const key = await this.ownerIndexKey(ownerId);
    const payload = JSON.stringify({ schemaVersion: STORAGE_SCHEMA_VERSION, ids });
    if (ids.length === 0) {
      await kv.del(key);
      return;
    }
    await kv.set(key, payload, this.ttl);
  }

  private async getConversationMeta(conversationId: string): Promise<ConversationMeta | undefined> {
    const kv = await this.client();
    if (!kv) {
      return undefined;
    }
    try {
      const raw = await kv.get(await this.conversationMetaKey(conversationId));
      if (!raw) {
        return undefined;
      }
      return JSON.parse(raw) as ConversationMeta;
    } catch {
      return undefined;
    }
  }

  async list(ownerId = DEFAULT_OWNER): Promise<Conversation[]> {
    const kv = await this.client();
    if (!kv) {
      return await this.memoryFallback.list(ownerId);
    }
    const ids = await this.getOwnerConversationIds(ownerId);
    const conversations: Conversation[] = [];
    for (const id of ids) {
      const raw = await kv.get(await this.conversationKey(id));
      if (!raw) {
        continue;
      }
      try {
        conversations.push(JSON.parse(raw) as Conversation);
      } catch {
        // Skip invalid records.
      }
    }
    return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(conversationId: string): Promise<Conversation | undefined> {
    const kv = await this.client();
    if (!kv) {
      return await this.memoryFallback.get(conversationId);
    }
    const raw = await kv.get(await this.conversationKey(conversationId));
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as Conversation;
    } catch {
      return undefined;
    }
  }

  async create(ownerId = DEFAULT_OWNER, title?: string): Promise<Conversation> {
    const now = Date.now();
    const conversation: Conversation = {
      conversationId: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random()}`,
      title: normalizeTitle(title),
      messages: [],
      ownerId,
      tenantId: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.update(conversation);
    return conversation;
  }

  async update(conversation: Conversation): Promise<void> {
    const kv = await this.client();
    if (!kv) {
      await this.memoryFallback.update(conversation);
      return;
    }
    const existing = await this.get(conversation.conversationId);
    const nextConversation: Conversation = {
      ...conversation,
      updatedAt: Date.now(),
    };
    const convKey = await this.conversationKey(nextConversation.conversationId);
    const metaKey = await this.conversationMetaKey(nextConversation.conversationId);
    await kv.set(convKey, JSON.stringify(nextConversation), this.ttl);
    await kv.set(
      metaKey,
      JSON.stringify({
        conversationId: nextConversation.conversationId,
        title: nextConversation.title,
        updatedAt: nextConversation.updatedAt,
        ownerId: nextConversation.ownerId,
      } satisfies ConversationMeta),
      this.ttl,
    );
    if (existing && existing.ownerId !== nextConversation.ownerId) {
      await this.withOwnerLock(existing.ownerId, async () => {
        const ids = await this.getOwnerConversationIds(existing.ownerId);
        await this.setOwnerConversationIds(
          existing.ownerId,
          ids.filter((id) => id !== nextConversation.conversationId),
        );
      });
    }
    await this.withOwnerLock(nextConversation.ownerId, async () => {
      const ids = await this.getOwnerConversationIds(nextConversation.ownerId);
      const deduped = [nextConversation.conversationId, ...ids.filter((id) => id !== nextConversation.conversationId)];
      await this.setOwnerConversationIds(nextConversation.ownerId, deduped);
    });
  }

  async rename(conversationId: string, title: string): Promise<Conversation | undefined> {
    const existing = await this.get(conversationId);
    if (!existing) {
      return undefined;
    }
    const updated: Conversation = {
      ...existing,
      title: normalizeTitle(title || existing.title),
      updatedAt: Date.now(),
    };
    await this.update(updated);
    return updated;
  }

  async delete(conversationId: string): Promise<boolean> {
    const kv = await this.client();
    if (!kv) {
      return await this.memoryFallback.delete(conversationId);
    }
    const existing = await this.get(conversationId);
    if (!existing) {
      return false;
    }
    await kv.del(await this.conversationKey(conversationId));
    await kv.del(await this.conversationMetaKey(conversationId));
    await this.withOwnerLock(existing.ownerId, async () => {
      const ids = await this.getOwnerConversationIds(existing.ownerId);
      await this.setOwnerConversationIds(
        existing.ownerId,
        ids.filter((id) => id !== conversationId),
      );
    });
    return true;
  }
}

class UpstashConversationStore extends KeyValueConversationStoreBase {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string, workingDir: string, ttl?: number, agentId?: string) {
    super(ttl, workingDir, agentId);
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  protected async client(): Promise<RawKeyValueClient | undefined> {
    return {
      get: async (key: string) => {
        const response = await fetch(`${this.baseUrl}/get/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: this.headers(),
        });
        if (!response.ok) {
          return undefined;
        }
        const payload = (await response.json()) as { result?: string | null };
        return payload.result ?? undefined;
      },
      set: async (key: string, value: string, ttl?: number) => {
        const endpoint =
          typeof ttl === "number"
            ? `${this.baseUrl}/setex/${encodeURIComponent(key)}/${Math.max(
                1,
                ttl,
              )}/${encodeURIComponent(value)}`
            : `${this.baseUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
        await fetch(endpoint, {
          method: "POST",
          headers: this.headers(),
        });
      },
      del: async (key: string) => {
        await fetch(`${this.baseUrl}/del/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: this.headers(),
        });
      },
    };
  }
}

class RedisLikeStateStore implements StateStore {
  private readonly memoryFallback: InMemoryStateStore;
  private readonly ttl?: number;
  private readonly clientPromise: Promise<
    | {
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
        del: (key: string) => Promise<unknown>;
      }
    | undefined
  >;

  constructor(url: string, ttl?: number) {
    this.ttl = ttl;
    this.memoryFallback = new InMemoryStateStore(ttl);
    this.clientPromise = (async () => {
      try {
        const redisModule = (await import("redis")) as unknown as {
          createClient: (options: { url: string }) => {
            connect: () => Promise<unknown>;
            get: (key: string) => Promise<string | null>;
            set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
            del: (key: string) => Promise<unknown>;
          };
        };
        const client = redisModule.createClient({ url });
        await client.connect();
        return client;
      } catch {
        return undefined;
      }
    })();
  }

  async get(runId: string): Promise<ConversationState | undefined> {
    const client = await this.clientPromise;
    if (!client) {
      return await this.memoryFallback.get(runId);
    }
    const raw = await client.get(runId);
    return raw ? (JSON.parse(raw) as ConversationState) : undefined;
  }

  async set(state: ConversationState): Promise<void> {
    const client = await this.clientPromise;
    if (!client) {
      await this.memoryFallback.set(state);
      return;
    }
    const serialized = JSON.stringify({ ...state, updatedAt: Date.now() });
    if (typeof this.ttl === "number") {
      await client.set(state.runId, serialized, { EX: Math.max(1, this.ttl) });
      return;
    }
    await client.set(state.runId, serialized);
  }

  async delete(runId: string): Promise<void> {
    const client = await this.clientPromise;
    if (!client) {
      await this.memoryFallback.delete(runId);
      return;
    }
    await client.del(runId);
  }
}

class RedisLikeConversationStore extends KeyValueConversationStoreBase {
  private readonly clientPromise: Promise<
    | {
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
        del: (key: string) => Promise<unknown>;
      }
    | undefined
  >;

  constructor(url: string, workingDir: string, ttl?: number, agentId?: string) {
    super(ttl, workingDir, agentId);
    this.clientPromise = (async () => {
      try {
        const redisModule = (await import("redis")) as unknown as {
          createClient: (options: { url: string }) => {
            connect: () => Promise<unknown>;
            get: (key: string) => Promise<string | null>;
            set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
            del: (key: string) => Promise<unknown>;
          };
        };
        const client = redisModule.createClient({ url });
        await client.connect();
        return client;
      } catch {
        return undefined;
      }
    })();
  }

  protected async client(): Promise<RawKeyValueClient | undefined> {
    const client = await this.clientPromise;
    if (!client) {
      return undefined;
    }
    return {
      get: async (key: string) => {
        const value = await client.get(key);
        return value ?? undefined;
      },
      set: async (key: string, value: string, ttl?: number) => {
        if (typeof ttl === "number") {
          await client.set(key, value, { EX: Math.max(1, ttl) });
          return;
        }
        await client.set(key, value);
      },
      del: async (key: string) => {
        await client.del(key);
      },
    };
  }
}

class DynamoDbStateStore implements StateStore {
  private readonly memoryFallback: InMemoryStateStore;
  private readonly table: string;
  private readonly ttl?: number;
  private readonly clientPromise: Promise<
    | {
        send: (command: unknown) => Promise<unknown>;
        GetItemCommand: new (input: unknown) => unknown;
        PutItemCommand: new (input: unknown) => unknown;
        DeleteItemCommand: new (input: unknown) => unknown;
      }
    | undefined
  >;

  constructor(table: string, region?: string, ttl?: number) {
    this.table = table;
    this.ttl = ttl;
    this.memoryFallback = new InMemoryStateStore(ttl);
    this.clientPromise = (async () => {
      try {
        const module = (await import("@aws-sdk/client-dynamodb")) as {
          DynamoDBClient: new (input: { region?: string }) => { send: (command: unknown) => Promise<unknown> };
          GetItemCommand: new (input: unknown) => unknown;
          PutItemCommand: new (input: unknown) => unknown;
          DeleteItemCommand: new (input: unknown) => unknown;
        };
        return {
          send: module.DynamoDBClient
            ? new module.DynamoDBClient({ region }).send.bind(
                new module.DynamoDBClient({ region }),
              )
            : async () => ({}),
          GetItemCommand: module.GetItemCommand,
          PutItemCommand: module.PutItemCommand,
          DeleteItemCommand: module.DeleteItemCommand,
        };
      } catch {
        return undefined;
      }
    })();
  }

  async get(runId: string): Promise<ConversationState | undefined> {
    const client = await this.clientPromise;
    if (!client) {
      return await this.memoryFallback.get(runId);
    }
    const result = (await client.send(
      new client.GetItemCommand({
        TableName: this.table,
        Key: { runId: { S: runId } },
      }),
    )) as {
      Item?: {
        value?: { S?: string };
      };
    };
    const raw = result.Item?.value?.S;
    return raw ? (JSON.parse(raw) as ConversationState) : undefined;
  }

  async set(state: ConversationState): Promise<void> {
    const client = await this.clientPromise;
    if (!client) {
      await this.memoryFallback.set(state);
      return;
    }
    const updatedState = { ...state, updatedAt: Date.now() };
    const ttlEpoch =
      typeof this.ttl === "number"
        ? Math.floor(Date.now() / 1000) + Math.max(1, this.ttl)
        : undefined;
    await client.send(
      new client.PutItemCommand({
        TableName: this.table,
        Item: {
          runId: { S: state.runId },
          value: { S: JSON.stringify(updatedState) },
          ...(typeof ttlEpoch === "number" ? { ttl: { N: String(ttlEpoch) } } : {}),
        },
      }),
    );
  }

  async delete(runId: string): Promise<void> {
    const client = await this.clientPromise;
    if (!client) {
      await this.memoryFallback.delete(runId);
      return;
    }
    await client.send(
      new client.DeleteItemCommand({
        TableName: this.table,
        Key: { runId: { S: runId } },
      }),
    );
  }
}

class DynamoDbConversationStore extends KeyValueConversationStoreBase {
  private readonly table: string;
  private readonly clientPromise: Promise<
    | {
        send: (command: unknown) => Promise<unknown>;
        GetItemCommand: new (input: unknown) => unknown;
        PutItemCommand: new (input: unknown) => unknown;
        DeleteItemCommand: new (input: unknown) => unknown;
      }
    | undefined
  >;

  constructor(table: string, workingDir: string, region?: string, ttl?: number, agentId?: string) {
    super(ttl, workingDir, agentId);
    this.table = table;
    this.clientPromise = (async () => {
      try {
        const module = (await import("@aws-sdk/client-dynamodb")) as {
          DynamoDBClient: new (input: { region?: string }) => { send: (command: unknown) => Promise<unknown> };
          GetItemCommand: new (input: unknown) => unknown;
          PutItemCommand: new (input: unknown) => unknown;
          DeleteItemCommand: new (input: unknown) => unknown;
        };
        const client = new module.DynamoDBClient({ region });
        return {
          send: client.send.bind(client),
          GetItemCommand: module.GetItemCommand,
          PutItemCommand: module.PutItemCommand,
          DeleteItemCommand: module.DeleteItemCommand,
        };
      } catch {
        return undefined;
      }
    })();
  }

  protected async client(): Promise<RawKeyValueClient | undefined> {
    const client = await this.clientPromise;
    if (!client) {
      return undefined;
    }
    return {
      get: async (key: string) => {
        const result = (await client.send(
          new client.GetItemCommand({
            TableName: this.table,
            Key: { runId: { S: key } },
          }),
        )) as {
          Item?: {
            value?: { S?: string };
          };
        };
        return result.Item?.value?.S;
      },
      set: async (key: string, value: string, ttl?: number) => {
        const ttlEpoch =
          typeof ttl === "number" ? Math.floor(Date.now() / 1000) + Math.max(1, ttl) : undefined;
        await client.send(
          new client.PutItemCommand({
            TableName: this.table,
            Item: {
              runId: { S: key },
              value: { S: value },
              ...(typeof ttlEpoch === "number" ? { ttl: { N: String(ttlEpoch) } } : {}),
            },
          }),
        );
      },
      del: async (key: string) => {
        await client.send(
          new client.DeleteItemCommand({
            TableName: this.table,
            Key: { runId: { S: key } },
          }),
        );
      },
    };
  }
}

export const createStateStore = (
  config?: StateConfig,
  options?: { workingDir?: string; agentId?: string },
): StateStore => {
  const provider = config?.provider ?? "local";
  const ttl = config?.ttl;
  const workingDir = options?.workingDir ?? process.cwd();
  if (provider === "local") {
    return new FileStateStore(workingDir, ttl, options?.agentId);
  }
  if (provider === "memory") {
    return new InMemoryStateStore(ttl);
  }
  if (provider === "upstash") {
    const url = config?.url ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
    const token = config?.token ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
    if (url && token) {
      return new UpstashStateStore(url, token, ttl);
    }
    return new InMemoryStateStore(ttl);
  }
  if (provider === "redis") {
    const url = config?.url ?? process.env.REDIS_URL ?? "";
    if (url) {
      return new RedisLikeStateStore(url, ttl);
    }
    return new InMemoryStateStore(ttl);
  }
  if (provider === "dynamodb") {
    const table = config?.table ?? process.env.PONCHO_DYNAMODB_TABLE ?? "";
    if (table) {
      return new DynamoDbStateStore(table, config?.region as string | undefined, ttl);
    }
    return new InMemoryStateStore(ttl);
  }
  return new InMemoryStateStore(ttl);
};

export const createConversationStore = (
  config?: StateConfig,
  options?: { workingDir?: string; agentId?: string },
): ConversationStore => {
  const provider = config?.provider ?? "local";
  const ttl = config?.ttl;
  const workingDir = options?.workingDir ?? process.cwd();
  if (provider === "local") {
    return new FileConversationStore(workingDir, options?.agentId);
  }
  if (provider === "memory") {
    return new InMemoryConversationStore(ttl);
  }
  if (provider === "upstash") {
    const url =
      config?.url ??
      (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "");
    const token =
      config?.token ??
      (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "");
    if (url && token) {
      return new UpstashConversationStore(url, token, workingDir, ttl, options?.agentId);
    }
    return new InMemoryConversationStore(ttl);
  }
  if (provider === "redis") {
    const url = config?.url ?? process.env.REDIS_URL ?? "";
    if (url) {
      return new RedisLikeConversationStore(url, workingDir, ttl, options?.agentId);
    }
    return new InMemoryConversationStore(ttl);
  }
  if (provider === "dynamodb") {
    const table = config?.table ?? process.env.PONCHO_DYNAMODB_TABLE ?? "";
    if (table) {
      return new DynamoDbConversationStore(
        table,
        workingDir,
        config?.region as string | undefined,
        ttl,
        options?.agentId,
      );
    }
    return new InMemoryConversationStore(ttl);
  }
  return new InMemoryConversationStore(ttl);
};
