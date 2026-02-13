import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { Message } from "@agentl/sdk";

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
const CONVERSATIONS_STATE_KEY = "__agentl_conversations__";
const LOCAL_CONVERSATIONS_FILE = "local-conversations.json";
const LOCAL_STATE_FILE = "local-state.json";

const getStateDirectory = (): string => {
  const isServerless =
    process.env.VERCEL === "1" ||
    process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
    process.env.SERVERLESS === "1";
  if (isServerless) {
    return "/tmp/.agentl/state";
  }
  return resolve(homedir(), ".agentl", "state");
};

const projectScopedFilePath = (workingDir: string, suffix: string): string => {
  const projectName = basename(workingDir).replace(/[^a-zA-Z0-9_-]+/g, "-") || "project";
  const projectHash = createHash("sha256").update(workingDir).digest("hex").slice(0, 12);
  return resolve(getStateDirectory(), `${projectName}-${projectHash}-${suffix}`);
};

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
  conversations: Conversation[];
};

class FileConversationStore implements ConversationStore {
  private readonly filePath: string;
  private readonly conversations = new Map<string, Conversation>();
  private loaded = false;
  private writing = Promise.resolve();

  constructor(workingDir: string) {
    this.filePath = projectScopedFilePath(workingDir, LOCAL_CONVERSATIONS_FILE);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as ConversationStoreFile;
      for (const conversation of parsed.conversations ?? []) {
        this.conversations.set(conversation.conversationId, conversation);
      }
    } catch {
      // Missing or invalid file should not crash local mode.
    }
  }

  private async persist(): Promise<void> {
    const payload: ConversationStoreFile = {
      conversations: Array.from(this.conversations.values()),
    };
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
    });
    await this.writing;
  }

  async list(ownerId = DEFAULT_OWNER): Promise<Conversation[]> {
    await this.ensureLoaded();
    return Array.from(this.conversations.values())
      .filter((conversation) => conversation.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(conversationId: string): Promise<Conversation | undefined> {
    await this.ensureLoaded();
    return this.conversations.get(conversationId);
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
    this.conversations.set(conversation.conversationId, conversation);
    await this.persist();
    return conversation;
  }

  async update(conversation: Conversation): Promise<void> {
    await this.ensureLoaded();
    this.conversations.set(conversation.conversationId, {
      ...conversation,
      updatedAt: Date.now(),
    });
    await this.persist();
  }

  async rename(conversationId: string, title: string): Promise<Conversation | undefined> {
    await this.ensureLoaded();
    const existing = this.conversations.get(conversationId);
    if (!existing) {
      return undefined;
    }
    const updated: Conversation = {
      ...existing,
      title: normalizeTitle(title || existing.title),
      updatedAt: Date.now(),
    };
    this.conversations.set(conversationId, updated);
    await this.persist();
    return updated;
  }

  async delete(conversationId: string): Promise<boolean> {
    await this.ensureLoaded();
    const removed = this.conversations.delete(conversationId);
    if (removed) {
      await this.persist();
    }
    return removed;
  }
}

type LocalStateFile = {
  states: ConversationState[];
};

class FileStateStore implements StateStore {
  private readonly filePath: string;
  private readonly states = new Map<string, ConversationState>();
  private readonly ttlMs?: number;
  private loaded = false;
  private writing = Promise.resolve();

  constructor(workingDir: string, ttlSeconds?: number) {
    this.filePath = projectScopedFilePath(workingDir, LOCAL_STATE_FILE);
    this.ttlMs = typeof ttlSeconds === "number" ? ttlSeconds * 1000 : undefined;
  }

  private isExpired(state: ConversationState): boolean {
    return typeof this.ttlMs === "number" && Date.now() - state.updatedAt > this.ttlMs;
  }

  private async ensureLoaded(): Promise<void> {
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
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(payload, null, 2), "utf8");
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

abstract class KeyValueConversationStoreBase implements ConversationStore {
  protected readonly memoryFallback: InMemoryConversationStore;
  protected readonly ttl?: number;

  constructor(ttl?: number) {
    this.ttl = ttl;
    this.memoryFallback = new InMemoryConversationStore(ttl);
  }

  protected abstract getRaw(key: string): Promise<string | undefined>;
  protected abstract setRaw(key: string, value: string): Promise<void>;
  protected abstract setRawWithTtl(key: string, value: string, ttl: number): Promise<void>;
  protected abstract delRaw(key: string): Promise<void>;

  private async readAllConversations(): Promise<Conversation[]> {
    try {
      const raw = await this.getRaw(CONVERSATIONS_STATE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as { conversations?: Conversation[] };
      return Array.isArray(parsed.conversations) ? parsed.conversations : [];
    } catch {
      return await this.memoryFallback.list(DEFAULT_OWNER);
    }
  }

  private async writeAllConversations(conversations: Conversation[]): Promise<void> {
    const payload = JSON.stringify({ conversations });
    try {
      if (typeof this.ttl === "number") {
        await this.setRawWithTtl(CONVERSATIONS_STATE_KEY, payload, Math.max(1, this.ttl));
      } else {
        await this.setRaw(CONVERSATIONS_STATE_KEY, payload);
      }
    } catch {
      // Fallback keeps local dev usable when provider is temporarily unavailable.
      for (const conversation of conversations) {
        await this.memoryFallback.update(conversation);
      }
    }
  }

  async list(ownerId = DEFAULT_OWNER): Promise<Conversation[]> {
    const conversations = await this.readAllConversations();
    return conversations
      .filter((conversation) => conversation.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(conversationId: string): Promise<Conversation | undefined> {
    const conversations = await this.readAllConversations();
    return conversations.find((conversation) => conversation.conversationId === conversationId);
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
    const conversations = await this.readAllConversations();
    conversations.push(conversation);
    await this.writeAllConversations(conversations);
    return conversation;
  }

  async update(conversation: Conversation): Promise<void> {
    const conversations = await this.readAllConversations();
    const next = conversations.map((item) =>
      item.conversationId === conversation.conversationId
        ? { ...conversation, updatedAt: Date.now() }
        : item,
    );
    await this.writeAllConversations(next);
  }

  async rename(conversationId: string, title: string): Promise<Conversation | undefined> {
    const conversations = await this.readAllConversations();
    let updated: Conversation | undefined;
    const next = conversations.map((item) => {
      if (item.conversationId !== conversationId) {
        return item;
      }
      updated = {
        ...item,
        title: normalizeTitle(title || item.title),
        updatedAt: Date.now(),
      };
      return updated;
    });
    if (!updated) {
      return undefined;
    }
    await this.writeAllConversations(next);
    return updated;
  }

  async delete(conversationId: string): Promise<boolean> {
    const conversations = await this.readAllConversations();
    const next = conversations.filter((item) => item.conversationId !== conversationId);
    if (next.length === conversations.length) {
      return false;
    }
    if (next.length === 0) {
      try {
        await this.delRaw(CONVERSATIONS_STATE_KEY);
      } catch {
        // Fall through to write empty payload for resilience.
        await this.writeAllConversations(next);
      }
      return true;
    }
    await this.writeAllConversations(next);
    return true;
  }
}

class UpstashConversationStore extends KeyValueConversationStoreBase {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string, ttl?: number) {
    super(ttl);
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  protected async getRaw(key: string): Promise<string | undefined> {
    const response = await fetch(`${this.baseUrl}/get/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as { result?: string | null };
    return payload.result ?? undefined;
  }

  protected async setRaw(key: string, value: string): Promise<void> {
    await fetch(
      `${this.baseUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`,
      { method: "POST", headers: this.headers() },
    );
  }

  protected async setRawWithTtl(key: string, value: string, ttl: number): Promise<void> {
    await fetch(
      `${this.baseUrl}/setex/${encodeURIComponent(key)}/${Math.max(1, ttl)}/${encodeURIComponent(
        value,
      )}`,
      { method: "POST", headers: this.headers() },
    );
  }

  protected async delRaw(key: string): Promise<void> {
    await fetch(`${this.baseUrl}/del/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: this.headers(),
    });
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

  constructor(url: string, ttl?: number) {
    super(ttl);
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

  protected async getRaw(key: string): Promise<string | undefined> {
    const client = await this.clientPromise;
    if (!client) {
      throw new Error("Redis unavailable");
    }
    const value = await client.get(key);
    return value ?? undefined;
  }

  protected async setRaw(key: string, value: string): Promise<void> {
    const client = await this.clientPromise;
    if (!client) {
      throw new Error("Redis unavailable");
    }
    await client.set(key, value);
  }

  protected async setRawWithTtl(key: string, value: string, ttl: number): Promise<void> {
    const client = await this.clientPromise;
    if (!client) {
      throw new Error("Redis unavailable");
    }
    await client.set(key, value, { EX: Math.max(1, ttl) });
  }

  protected async delRaw(key: string): Promise<void> {
    const client = await this.clientPromise;
    if (!client) {
      throw new Error("Redis unavailable");
    }
    await client.del(key);
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

  constructor(table: string, region?: string, ttl?: number) {
    super(ttl);
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

  protected async getRaw(key: string): Promise<string | undefined> {
    const client = await this.clientPromise;
    if (!client) {
      throw new Error("DynamoDB unavailable");
    }
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
  }

  protected async setRaw(key: string, value: string): Promise<void> {
    const client = await this.clientPromise;
    if (!client) {
      throw new Error("DynamoDB unavailable");
    }
    await client.send(
      new client.PutItemCommand({
        TableName: this.table,
        Item: {
          runId: { S: key },
          value: { S: value },
        },
      }),
    );
  }

  protected async setRawWithTtl(key: string, value: string, ttl: number): Promise<void> {
    const client = await this.clientPromise;
    if (!client) {
      throw new Error("DynamoDB unavailable");
    }
    const ttlEpoch = Math.floor(Date.now() / 1000) + Math.max(1, ttl);
    await client.send(
      new client.PutItemCommand({
        TableName: this.table,
        Item: {
          runId: { S: key },
          value: { S: value },
          ttl: { N: String(ttlEpoch) },
        },
      }),
    );
  }

  protected async delRaw(key: string): Promise<void> {
    const client = await this.clientPromise;
    if (!client) {
      throw new Error("DynamoDB unavailable");
    }
    await client.send(
      new client.DeleteItemCommand({
        TableName: this.table,
        Key: { runId: { S: key } },
      }),
    );
  }
}

export const createStateStore = (
  config?: StateConfig,
  options?: { workingDir?: string },
): StateStore => {
  const provider = config?.provider ?? "local";
  const ttl = config?.ttl;
  const workingDir = options?.workingDir ?? process.cwd();
  if (provider === "local") {
    return new FileStateStore(workingDir, ttl);
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
    const table = config?.table ?? process.env.AGENTL_DYNAMODB_TABLE ?? "";
    if (table) {
      return new DynamoDbStateStore(table, config?.region as string | undefined, ttl);
    }
    return new InMemoryStateStore(ttl);
  }
  return new InMemoryStateStore(ttl);
};

export const createConversationStore = (
  config?: StateConfig,
  options?: { workingDir?: string },
): ConversationStore => {
  const provider = config?.provider ?? "local";
  const ttl = config?.ttl;
  const workingDir = options?.workingDir ?? process.cwd();
  if (provider === "local") {
    return new FileConversationStore(workingDir);
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
      return new UpstashConversationStore(url, token, ttl);
    }
    return new InMemoryConversationStore(ttl);
  }
  if (provider === "redis") {
    const url = config?.url ?? process.env.REDIS_URL ?? "";
    if (url) {
      return new RedisLikeConversationStore(url, ttl);
    }
    return new InMemoryConversationStore(ttl);
  }
  if (provider === "dynamodb") {
    const table = config?.table ?? process.env.AGENTL_DYNAMODB_TABLE ?? "";
    if (table) {
      return new DynamoDbConversationStore(table, config?.region as string | undefined, ttl);
    }
    return new InMemoryConversationStore(ttl);
  }
  return new InMemoryConversationStore(ttl);
};
