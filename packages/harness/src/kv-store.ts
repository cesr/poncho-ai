import type { StateConfig } from "./state.js";

/**
 * Minimal raw key-value interface shared by MemoryStore, TodoStore, and any
 * future stores that sit on top of the same user-configured backend.
 */
export interface RawKVStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Upstash
// ---------------------------------------------------------------------------

class UpstashKVStore implements RawKVStore {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  private headers(): HeadersInit {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }

  async get(key: string): Promise<string | undefined> {
    const response = await fetch(`${this.baseUrl}/get/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as { result?: string | null };
    return payload.result ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(["SET", key, value]),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[kv][upstash] SET failed (${response.status}): ${text.slice(0, 200)}`);
    }
  }

  async setWithTtl(key: string, value: string, ttl: number): Promise<void> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(["SETEX", key, Math.max(1, ttl), value]),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[kv][upstash] SETEX failed (${response.status}): ${text.slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

class RedisKVStore implements RawKVStore {
  private readonly clientPromise: Promise<
    | {
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
      }
    | undefined
  >;

  constructor(url: string) {
    this.clientPromise = (async () => {
      try {
        const redisModule = (await import("redis")) as unknown as {
          createClient: (args: { url: string }) => {
            connect: () => Promise<unknown>;
            get: (key: string) => Promise<string | null>;
            set: (key: string, value: string, options?: { EX?: number }) => Promise<unknown>;
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

  async get(key: string): Promise<string | undefined> {
    const client = await this.clientPromise;
    if (!client) throw new Error("Redis unavailable");
    const value = await client.get(key);
    return value ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const client = await this.clientPromise;
    if (!client) throw new Error("Redis unavailable");
    await client.set(key, value);
  }

  async setWithTtl(key: string, value: string, ttl: number): Promise<void> {
    const client = await this.clientPromise;
    if (!client) throw new Error("Redis unavailable");
    await client.set(key, value, { EX: Math.max(1, ttl) });
  }
}

// ---------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------

class DynamoDbKVStore implements RawKVStore {
  private readonly table: string;
  private readonly clientPromise: Promise<
    | {
        send: (command: unknown) => Promise<unknown>;
        GetItemCommand: new (input: unknown) => unknown;
        PutItemCommand: new (input: unknown) => unknown;
      }
    | undefined
  >;

  constructor(table: string, region?: string) {
    this.table = table;
    this.clientPromise = (async () => {
      try {
        const module = (await import("@aws-sdk/client-dynamodb")) as {
          DynamoDBClient: new (input: { region?: string }) => {
            send: (command: unknown) => Promise<unknown>;
          };
          GetItemCommand: new (input: unknown) => unknown;
          PutItemCommand: new (input: unknown) => unknown;
        };
        const client = new module.DynamoDBClient({ region });
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

  async get(key: string): Promise<string | undefined> {
    const client = await this.clientPromise;
    if (!client) throw new Error("DynamoDB unavailable");
    const result = (await client.send(
      new client.GetItemCommand({ TableName: this.table, Key: { runId: { S: key } } }),
    )) as { Item?: { value?: { S?: string } } };
    return result.Item?.value?.S;
  }

  async set(key: string, value: string): Promise<void> {
    const client = await this.clientPromise;
    if (!client) throw new Error("DynamoDB unavailable");
    await client.send(
      new client.PutItemCommand({
        TableName: this.table,
        Item: { runId: { S: key }, value: { S: value } },
      }),
    );
  }

  async setWithTtl(key: string, value: string, ttl: number): Promise<void> {
    const client = await this.clientPromise;
    if (!client) throw new Error("DynamoDB unavailable");
    const ttlEpoch = Math.floor(Date.now() / 1000) + Math.max(1, ttl);
    await client.send(
      new client.PutItemCommand({
        TableName: this.table,
        Item: { runId: { S: key }, value: { S: value }, ttl: { N: String(ttlEpoch) } },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Factory — resolves the user's storage config into a RawKVStore, or
// undefined when the provider is "local" or "memory" (handled by callers).
// ---------------------------------------------------------------------------

export const createRawKVStore = (config?: StateConfig): RawKVStore | undefined => {
  const provider = config?.provider ?? "local";

  if (provider === "upstash") {
    const urlEnv = config?.urlEnv ?? (process.env.UPSTASH_REDIS_REST_URL ? "UPSTASH_REDIS_REST_URL" : "KV_REST_API_URL");
    const tokenEnv = config?.tokenEnv ?? (process.env.UPSTASH_REDIS_REST_TOKEN ? "UPSTASH_REDIS_REST_TOKEN" : "KV_REST_API_TOKEN");
    const url = process.env[urlEnv] ?? "";
    const token = process.env[tokenEnv] ?? "";
    if (url && token) return new UpstashKVStore(url, token);
  }

  if (provider === "redis") {
    const urlEnv = config?.urlEnv ?? "REDIS_URL";
    const url = process.env[urlEnv] ?? "";
    if (url) return new RedisKVStore(url);
  }

  if (provider === "dynamodb") {
    const table = config?.table ?? process.env.PONCHO_DYNAMODB_TABLE ?? "";
    if (table) return new DynamoDbKVStore(table, config?.region);
  }

  return undefined;
};
