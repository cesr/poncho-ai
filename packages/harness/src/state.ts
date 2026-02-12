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

export type StateProviderName =
  | "memory"
  | "redis"
  | "upstash"
  | "vercel-kv"
  | "dynamodb";

export interface StateConfig {
  provider?: StateProviderName;
  ttl?: number;
  url?: string;
  token?: string;
  table?: string;
  region?: string;
}

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

class VercelKvStateStore implements StateStore {
  private readonly memoryFallback: InMemoryStateStore;
  private readonly ttl?: number;
  private readonly kvPromise: Promise<
    | {
        get: (key: string) => Promise<unknown>;
        set: (key: string, value: unknown, options?: { ex?: number }) => Promise<unknown>;
        del: (key: string) => Promise<unknown>;
      }
    | undefined
  >;

  constructor(ttl?: number) {
    this.ttl = ttl;
    this.memoryFallback = new InMemoryStateStore(ttl);
    this.kvPromise = (async () => {
      try {
        const module = (await import("@vercel/kv")) as {
          kv?: {
            get: (key: string) => Promise<unknown>;
            set: (key: string, value: unknown, options?: { ex?: number }) => Promise<unknown>;
            del: (key: string) => Promise<unknown>;
          };
        };
        return module.kv;
      } catch {
        return undefined;
      }
    })();
  }

  async get(runId: string): Promise<ConversationState | undefined> {
    const kv = await this.kvPromise;
    if (!kv) {
      return await this.memoryFallback.get(runId);
    }
    const value = await kv.get(runId);
    return value ? (value as ConversationState) : undefined;
  }

  async set(state: ConversationState): Promise<void> {
    const kv = await this.kvPromise;
    if (!kv) {
      await this.memoryFallback.set(state);
      return;
    }
    await kv.set(
      state.runId,
      { ...state, updatedAt: Date.now() },
      typeof this.ttl === "number" ? { ex: Math.max(1, this.ttl) } : undefined,
    );
  }

  async delete(runId: string): Promise<void> {
    const kv = await this.kvPromise;
    if (!kv) {
      await this.memoryFallback.delete(runId);
      return;
    }
    await kv.del(runId);
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

export const createStateStore = (config?: StateConfig): StateStore => {
  const provider = config?.provider ?? "memory";
  const ttl = config?.ttl;
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
  if (provider === "vercel-kv") {
    return new VercelKvStateStore(ttl);
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
