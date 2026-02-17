import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { StateProviderName } from "./state.js";
import {
  ensureAgentIdentity,
  getAgentStoreDirectory,
  slugifyStorageComponent,
  STORAGE_SCHEMA_VERSION,
} from "./agent-identity.js";

export interface MainMemory {
  content: string;
  updatedAt: number;
}

export interface MemoryConfig {
  enabled?: boolean;
  provider?: StateProviderName;
  url?: string;
  token?: string;
  table?: string;
  region?: string;
  ttl?: number;
  maxRecallConversations?: number;
}

export interface MemoryStore {
  getMainMemory(): Promise<MainMemory>;
  updateMainMemory(input: { content: string; mode?: "replace" | "append" }): Promise<MainMemory>;
}

type MainMemoryPayload = {
  main: MainMemory;
};

type RecallItem = {
  conversationId: string;
  title: string;
  updatedAt: number;
  content: string;
};

const DEFAULT_MAIN_MEMORY: MainMemory = {
  content: "",
  updatedAt: 0,
};
const LOCAL_MEMORY_FILE = "memory.json";

const writeJsonAtomic = async (filePath: string, payload: unknown): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmpPath, filePath);
};

const scoreText = (text: string, query: string): number => {
  const normalized = query.trim().toLowerCase();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return 0;
  }
  const haystack = text.toLowerCase();
  let score = haystack.includes(normalized) ? 5 : 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
};

class InMemoryMemoryStore implements MemoryStore {
  private mainMemory: MainMemory = { ...DEFAULT_MAIN_MEMORY };
  private readonly ttlMs?: number;

  constructor(ttlSeconds?: number) {
    this.ttlMs = typeof ttlSeconds === "number" ? ttlSeconds * 1000 : undefined;
  }

  private isExpired(updatedAt: number): boolean {
    return typeof this.ttlMs === "number" && Date.now() - updatedAt > this.ttlMs;
  }

  async getMainMemory(): Promise<MainMemory> {
    if (this.mainMemory.updatedAt > 0 && this.isExpired(this.mainMemory.updatedAt)) {
      this.mainMemory = { ...DEFAULT_MAIN_MEMORY };
    }
    return this.mainMemory;
  }

  async updateMainMemory(input: {
    content: string;
    mode?: "replace" | "append";
  }): Promise<MainMemory> {
    const now = Date.now();
    const existing = await this.getMainMemory();
    const nextContent =
      input.mode === "append" && existing.content
        ? `${existing.content}\n\n${input.content}`.trim()
        : input.content;
    this.mainMemory = {
      content: nextContent.trim(),
      updatedAt: now,
    };
    return this.mainMemory;
  }
}

class FileMainMemoryStore implements MemoryStore {
  private readonly workingDir: string;
  private filePath = "";
  private readonly ttlMs?: number;
  private loaded = false;
  private writing = Promise.resolve();
  private mainMemory: MainMemory = { ...DEFAULT_MAIN_MEMORY };

  constructor(workingDir: string, ttlSeconds?: number) {
    this.workingDir = workingDir;
    this.ttlMs = typeof ttlSeconds === "number" ? ttlSeconds * 1000 : undefined;
  }

  private async ensureFilePath(): Promise<void> {
    if (this.filePath) {
      return;
    }
    const identity = await ensureAgentIdentity(this.workingDir);
    this.filePath = resolve(getAgentStoreDirectory(identity), LOCAL_MEMORY_FILE);
  }

  private isExpired(updatedAt: number): boolean {
    return typeof this.ttlMs === "number" && Date.now() - updatedAt > this.ttlMs;
  }

  private async ensureLoaded(): Promise<void> {
    await this.ensureFilePath();
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as MainMemoryPayload;
      const content = typeof parsed.main?.content === "string" ? parsed.main.content : "";
      const updatedAt = typeof parsed.main?.updatedAt === "number" ? parsed.main.updatedAt : 0;
      this.mainMemory = { content, updatedAt };
    } catch {
      // Missing or invalid file should not crash local mode.
    }
  }

  private async persist(): Promise<void> {
    const payload: MainMemoryPayload = { main: this.mainMemory };
    this.writing = this.writing.then(async () => {
      await writeJsonAtomic(this.filePath, payload);
    });
    await this.writing;
  }

  async getMainMemory(): Promise<MainMemory> {
    await this.ensureLoaded();
    if (this.mainMemory.updatedAt > 0 && this.isExpired(this.mainMemory.updatedAt)) {
      this.mainMemory = { ...DEFAULT_MAIN_MEMORY };
      await this.persist();
    }
    return this.mainMemory;
  }

  async updateMainMemory(input: {
    content: string;
    mode?: "replace" | "append";
  }): Promise<MainMemory> {
    await this.ensureLoaded();
    const existing = await this.getMainMemory();
    const nextContent =
      input.mode === "append" && existing.content
        ? `${existing.content}\n\n${input.content}`.trim()
        : input.content;
    this.mainMemory = {
      content: nextContent.trim(),
      updatedAt: Date.now(),
    };
    await this.persist();
    return this.mainMemory;
  }
}

abstract class KeyValueMainMemoryStoreBase implements MemoryStore {
  protected readonly ttl?: number;
  protected readonly memoryFallback: InMemoryMemoryStore;

  constructor(ttl?: number) {
    this.ttl = ttl;
    this.memoryFallback = new InMemoryMemoryStore(ttl);
  }

  protected abstract getRaw(key: string): Promise<string | undefined>;
  protected abstract setRaw(key: string, value: string): Promise<void>;
  protected abstract setRawWithTtl(key: string, value: string, ttl: number): Promise<void>;

  protected async readPayload(key: string): Promise<MainMemoryPayload> {
    try {
      const raw = await this.getRaw(key);
      if (!raw) {
        return { main: { ...DEFAULT_MAIN_MEMORY } };
      }
      const parsed = JSON.parse(raw) as MainMemoryPayload;
      const content = typeof parsed.main?.content === "string" ? parsed.main.content : "";
      const updatedAt = typeof parsed.main?.updatedAt === "number" ? parsed.main.updatedAt : 0;
      return { main: { content, updatedAt } };
    } catch {
      const main = await this.memoryFallback.getMainMemory();
      return { main };
    }
  }

  protected async writePayload(key: string, payload: MainMemoryPayload): Promise<void> {
    try {
      const serialized = JSON.stringify(payload);
      if (typeof this.ttl === "number") {
        await this.setRawWithTtl(key, serialized, Math.max(1, this.ttl));
      } else {
        await this.setRaw(key, serialized);
      }
    } catch {
      await this.memoryFallback.updateMainMemory({
        content: payload.main.content,
        mode: "replace",
      });
    }
  }

  async getMainMemory(): Promise<MainMemory> {
    const payload = await this.readPayload(this.key());
    return payload.main;
  }

  async updateMainMemory(input: {
    content: string;
    mode?: "replace" | "append";
  }): Promise<MainMemory> {
    const key = this.key();
    const payload = await this.readPayload(key);
    const nextContent =
      input.mode === "append" && payload.main.content
        ? `${payload.main.content}\n\n${input.content}`.trim()
        : input.content;
    payload.main = {
      content: nextContent.trim(),
      updatedAt: Date.now(),
    };
    await this.writePayload(key, payload);
    return payload.main;
  }

  protected abstract key(): string;
}

class UpstashMemoryStore extends KeyValueMainMemoryStoreBase {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly storageKey: string;

  constructor(options: {
    baseUrl: string;
    token: string;
    storageKey: string;
    ttl?: number;
  }) {
    super(options.ttl);
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.storageKey = options.storageKey;
  }

  protected key(): string {
    return this.storageKey;
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
}

class RedisMemoryStore extends KeyValueMainMemoryStoreBase {
  private readonly storageKey: string;
  private readonly clientPromise: Promise<
    | {
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
      }
    | undefined
  >;

  constructor(options: {
    url: string;
    storageKey: string;
    ttl?: number;
  }) {
    super(options.ttl);
    this.storageKey = options.storageKey;
    this.clientPromise = (async () => {
      try {
        const redisModule = (await import("redis")) as unknown as {
          createClient: (args: { url: string }) => {
            connect: () => Promise<unknown>;
            get: (key: string) => Promise<string | null>;
            set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
          };
        };
        const client = redisModule.createClient({ url: options.url });
        await client.connect();
        return client;
      } catch {
        return undefined;
      }
    })();
  }

  protected key(): string {
    return this.storageKey;
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
}

class DynamoDbMemoryStore extends KeyValueMainMemoryStoreBase {
  private readonly storageKey: string;
  private readonly table: string;
  private readonly clientPromise: Promise<
    | {
        send: (command: unknown) => Promise<unknown>;
        GetItemCommand: new (input: unknown) => unknown;
        PutItemCommand: new (input: unknown) => unknown;
      }
    | undefined
  >;

  constructor(options: {
    table: string;
    storageKey: string;
    region?: string;
    ttl?: number;
  }) {
    super(options.ttl);
    this.storageKey = options.storageKey;
    this.table = options.table;
    this.clientPromise = (async () => {
      try {
        const module = (await import("@aws-sdk/client-dynamodb")) as {
          DynamoDBClient: new (input: { region?: string }) => {
            send: (command: unknown) => Promise<unknown>;
          };
          GetItemCommand: new (input: unknown) => unknown;
          PutItemCommand: new (input: unknown) => unknown;
        };
        const client = new module.DynamoDBClient({ region: options.region });
        return {
          send: client.send.bind(client),
          GetItemCommand: module.GetItemCommand,
          PutItemCommand: module.PutItemCommand,
        };
      } catch {
        return undefined;
      }
    })();
  }

  protected key(): string {
    return this.storageKey;
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
}

export const createMemoryStore = (
  agentId: string,
  config?: MemoryConfig,
  options?: { workingDir?: string },
): MemoryStore => {
  const provider = config?.provider ?? "local";
  const ttl = config?.ttl;
  const storageKey = `poncho:${STORAGE_SCHEMA_VERSION}:${slugifyStorageComponent(
    agentId,
  )}:memory:main`;
  const workingDir = options?.workingDir ?? process.cwd();
  if (provider === "local") {
    return new FileMainMemoryStore(workingDir, ttl);
  }
  if (provider === "memory") {
    return new InMemoryMemoryStore(ttl);
  }
  if (provider === "upstash") {
    const url =
      config?.url ??
      process.env.UPSTASH_REDIS_REST_URL ??
      process.env.KV_REST_API_URL ??
      "";
    const token =
      config?.token ??
      process.env.UPSTASH_REDIS_REST_TOKEN ??
      process.env.KV_REST_API_TOKEN ??
      "";
    if (url && token) {
      return new UpstashMemoryStore({
        baseUrl: url,
        token,
        storageKey,
        ttl,
      });
    }
    return new InMemoryMemoryStore(ttl);
  }
  if (provider === "redis") {
    const url = config?.url ?? process.env.REDIS_URL ?? "";
    if (url) {
      return new RedisMemoryStore({
        url,
        storageKey,
        ttl,
      });
    }
    return new InMemoryMemoryStore(ttl);
  }
  if (provider === "dynamodb") {
    const table = config?.table ?? process.env.PONCHO_DYNAMODB_TABLE ?? "";
    if (table) {
      return new DynamoDbMemoryStore({
        table,
        storageKey,
        region: config?.region,
        ttl,
      });
    }
    return new InMemoryMemoryStore(ttl);
  }
  return new InMemoryMemoryStore(ttl);
};

const asRecallCorpus = (raw: unknown): RecallItem[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const record = item as Record<string, unknown>;
      const conversationId =
        typeof record.conversationId === "string" ? record.conversationId : "";
      const title = typeof record.title === "string" ? record.title : "Conversation";
      const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
      const content = typeof record.content === "string" ? record.content : "";
      if (!conversationId || !content) {
        return undefined;
      }
      return { conversationId, title, updatedAt, content } satisfies RecallItem;
    })
    .filter((item): item is RecallItem => Boolean(item));
};

const buildRecallSnippet = (content: string, query: string, maxChars = 360): string => {
  const normalized = query.trim().toLowerCase();
  const index = content.toLowerCase().indexOf(normalized);
  if (index === -1) {
    return content.slice(0, maxChars);
  }
  const start = Math.max(0, index - 120);
  const end = Math.min(content.length, index + normalized.length + 180);
  return content.slice(start, end);
};

export const createMemoryTools = (
  store: MemoryStore,
  options?: { maxRecallConversations?: number },
): ToolDefinition[] => {
  const maxRecallConversations = Math.max(1, options?.maxRecallConversations ?? 20);
  return [
    defineTool({
      name: "memory_main_get",
      description: "Get the current persistent main memory document.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const memory = await store.getMainMemory();
        return { memory };
      },
    }),
    defineTool({
      name: "memory_main_update",
      description:
        "Update persistent main memory when new stable preferences, long-term goals, or durable facts appear. Proactively evaluate every turn whether memory should be updated, and avoid storing ephemeral details.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["replace", "append"],
            description: "replace overwrites memory; append adds content to the end",
          },
          content: {
            type: "string",
            description: "The memory content to write",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
      handler: async (input) => {
        const content = typeof input.content === "string" ? input.content.trim() : "";
        if (!content) {
          throw new Error("content is required");
        }
        const mode =
          input.mode === "append" || input.mode === "replace"
            ? input.mode
            : "replace";
        const memory = await store.updateMainMemory({ content, mode });
        return { ok: true, memory };
      },
    }),
    defineTool({
      name: "conversation_recall",
      description:
        "Recall relevant snippets from previous conversations when prior context is likely important (for example: 'as we discussed', 'last time', or ambiguous references).",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query for past conversation recall",
          },
          limit: {
            type: "number",
            description: "Maximum snippets to return",
          },
          excludeConversationId: {
            type: "string",
            description: "Optional conversation id to exclude from recall",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        if (!query) {
          throw new Error("query is required");
        }
        const limit = Math.max(
          1,
          Math.min(5, typeof input.limit === "number" ? input.limit : 3),
        );
        const excludeConversationId =
          typeof input.excludeConversationId === "string"
            ? input.excludeConversationId
            : "";
        const corpus = asRecallCorpus(context.parameters.__conversationRecallCorpus).slice(
          0,
          maxRecallConversations,
        );
        const results = corpus
          .filter((item) =>
            excludeConversationId ? item.conversationId !== excludeConversationId : true,
          )
          .map((item) => ({
            ...item,
            score: scoreText(`${item.title}\n${item.content}`, query),
          }))
          .filter((item) => item.score > 0)
          .sort((a, b) => {
            if (b.score === a.score) {
              return b.updatedAt - a.updatedAt;
            }
            return b.score - a.score;
          })
          .slice(0, limit)
          .map((item) => ({
            conversationId: item.conversationId,
            title: item.title,
            updatedAt: item.updatedAt,
            snippet: buildRecallSnippet(item.content, query),
          }));
        return { results };
      },
    }),
  ];
};
