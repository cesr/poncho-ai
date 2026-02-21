import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";
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

export interface UploadsConfig {
  provider?: "local" | "vercel-blob" | "s3";
  /** Vercel Blob access mode. Must match the store's configuration. Defaults to "public". */
  access?: "public" | "private";
  bucket?: string;
  region?: string;
  endpoint?: string;
}

export type BuiltInToolToggles = {
  list_directory?: boolean;
  read_file?: boolean;
  write_file?: boolean;
};

export interface MessagingChannelConfig {
  platform: "slack";
  botTokenEnv?: string;
  signingSecretEnv?: string;
}

export interface PonchoConfig extends McpConfig {
  harness?: string;
  messaging?: MessagingChannelConfig[];
  tools?: {
    defaults?: BuiltInToolToggles;
    byEnvironment?: {
      development?: BuiltInToolToggles;
      staging?: BuiltInToolToggles;
      production?: BuiltInToolToggles;
    };
  };
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
   *  `skills/` and `.poncho/skills/` are always scanned. */
  skillPaths?: string[];
  uploads?: UploadsConfig;
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
  config: PonchoConfig | undefined,
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
  config: PonchoConfig | undefined,
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

export const loadPonchoConfig = async (
  workingDir: string,
): Promise<PonchoConfig | undefined> => {
  const filePath = resolve(workingDir, "poncho.config.js");
  try {
    await access(filePath);
  } catch {
    return undefined;
  }

  try {
    const imported = (await import(`${filePath}?t=${Date.now()}`)) as {
      default?: PonchoConfig;
    };
    return imported.default;
  } catch (error) {
    // Some serverless packagers load project code as CommonJS and reject ESM
    // config files. Fall back to jiti so both ESM and CJS configs are accepted.
    const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    const imported = (await jiti.import(filePath)) as PonchoConfig | { default?: PonchoConfig };
    if (imported && typeof imported === "object" && "default" in imported) {
      return imported.default;
    }
    if (imported && typeof imported === "object") {
      return imported as PonchoConfig;
    }
    throw error;
  }
};
