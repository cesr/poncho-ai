import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { MemoryConfig } from "./memory.js";
import type { McpConfig } from "./mcp.js";
import type { StateConfig } from "./state.js";

export interface StorageConfig {
  provider?: "local" | "memory" | "redis" | "upstash" | "dynamodb";
  url?: string;
  token?: string;
  table?: string;
  region?: string;
  ttl?:
    | number
    | {
        conversations?: number;
        memory?: number;
      };
  memory?: {
    enabled?: boolean;
    maxRecallConversations?: number;
  };
}

export interface AgentlConfig extends McpConfig {
  harness?: string;
  auth?: {
    required?: boolean;
    type?: "bearer" | "header" | "custom";
    headerName?: string;
    validate?: (token: string, req?: unknown) => Promise<boolean> | boolean;
  };
  state?: {
    provider?: "local" | "memory" | "redis" | "upstash" | "dynamodb";
    ttl?: number;
    [key: string]: unknown;
  };
  memory?: MemoryConfig;
  storage?: StorageConfig;
  telemetry?: {
    enabled?: boolean;
    otlp?: string;
    latitude?: {
      apiKey?: string;
      projectId?: string | number;
      path?: string;
      documentPath?: string;
    };
    handler?: (event: unknown) => Promise<void> | void;
  };
  skills?: Record<string, Record<string, unknown>>;
  /** Extra directories (relative to project root) to scan for skills.
   *  `skills/` and `.agentl/skills/` are always scanned. */
  skillPaths?: string[];
  build?: {
    vercel?: Record<string, unknown>;
    docker?: Record<string, unknown>;
    lambda?: Record<string, unknown>;
    fly?: Record<string, unknown>;
  };
}

const resolveTtl = (
  ttl: StorageConfig["ttl"] | undefined,
  key: "conversations" | "memory",
): number | undefined => {
  if (typeof ttl === "number") {
    return ttl;
  }
  if (ttl && typeof ttl === "object" && typeof ttl[key] === "number") {
    return ttl[key];
  }
  return undefined;
};

export const resolveStateConfig = (
  config: AgentlConfig | undefined,
): StateConfig | undefined => {
  if (config?.storage) {
    return {
      provider: config.storage.provider,
      url: config.storage.url,
      token: config.storage.token,
      table: config.storage.table,
      region: config.storage.region,
      ttl: resolveTtl(config.storage.ttl, "conversations"),
    };
  }
  return config?.state as StateConfig | undefined;
};

export const resolveMemoryConfig = (
  config: AgentlConfig | undefined,
): MemoryConfig | undefined => {
  if (config?.storage) {
    return {
      enabled: config.storage.memory?.enabled ?? config.memory?.enabled,
      provider: config.storage.provider,
      url: config.storage.url,
      token: config.storage.token,
      table: config.storage.table,
      region: config.storage.region,
      ttl: resolveTtl(config.storage.ttl, "memory"),
      maxRecallConversations:
        config.storage.memory?.maxRecallConversations ??
        config.memory?.maxRecallConversations,
    };
  }
  return config?.memory;
};

export const loadAgentlConfig = async (
  workingDir: string,
): Promise<AgentlConfig | undefined> => {
  const filePath = resolve(workingDir, "agentl.config.js");
  try {
    await access(filePath);
  } catch {
    return undefined;
  }

  const imported = (await import(`${filePath}?t=${Date.now()}`)) as {
    default?: AgentlConfig;
  };

  return imported.default;
};
