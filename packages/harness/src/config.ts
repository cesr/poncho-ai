import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import type { MemoryConfig } from "./memory.js";
import type { McpConfig } from "./mcp.js";
import type { StateConfig } from "./state.js";

export interface StorageConfig {
  provider?: "local" | "memory" | "redis" | "upstash" | "dynamodb";
  urlEnv?: string;
  tokenEnv?: string;
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

export type ToolAccess = boolean | "approval";

/** @deprecated Use flat tool keys on `tools` instead. Kept for backward compat. */
export type BuiltInToolToggles = {
  list_directory?: boolean;
  read_file?: boolean;
  write_file?: boolean;
  edit_file?: boolean;
  delete_file?: boolean;
  delete_directory?: boolean;
  todo_list?: boolean;
  todo_add?: boolean;
  todo_update?: boolean;
  todo_remove?: boolean;
  web_search?: boolean;
  web_fetch?: boolean;
};

export interface MessagingChannelConfig {
  platform: "slack" | "resend" | "telegram";
  // Slack
  botTokenEnv?: string;
  signingSecretEnv?: string;
  // Resend (email)
  apiKeyEnv?: string;
  webhookSecretEnv?: string;
  fromEnv?: string;
  replyToEnv?: string;
  allowedSenders?: string[];
  mode?: "auto-reply" | "tool";
  allowedRecipients?: string[];
  maxSendsPerRun?: number;
  // Telegram
  allowedUserIds?: number[];
}

export interface PonchoConfig extends McpConfig {
  harness?: string;
  messaging?: MessagingChannelConfig[];
  tools?: {
    defaults?: BuiltInToolToggles;
    byEnvironment?: {
      development?: Record<string, ToolAccess>;
      staging?: Record<string, ToolAccess>;
      production?: Record<string, ToolAccess>;
    };
    [toolName: string]:
      | ToolAccess
      | BuiltInToolToggles
      | Record<string, Record<string, ToolAccess>>
      | undefined;
  };
  auth?: {
    required?: boolean;
    type?: "bearer" | "header" | "custom";
    headerName?: string;
    tokenEnv?: string;
    validate?: (token: string, req?: unknown) => Promise<boolean> | boolean;
  };
  state?: {
    provider?: "local" | "memory" | "redis" | "upstash" | "dynamodb";
    ttl?: number;
    [key: string]: unknown;
  };
  memory?: MemoryConfig;
  storage?: StorageConfig;
  providers?: {
    openai?: { apiKeyEnv?: string };
    openaiCodex?: {
      refreshTokenEnv?: string;
      accessTokenEnv?: string;
      accessTokenExpiresAtEnv?: string;
      accountIdEnv?: string;
      authFilePathEnv?: string;
    };
    anthropic?: { apiKeyEnv?: string };
  };
  telemetry?: {
    enabled?: boolean;
    otlp?: string | {
      url: string;
      headers?: Record<string, string>;
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
  /** One-off reminders. When enabled, the agent gets set_reminder / list_reminders / cancel_reminder tools. */
  reminders?: {
    enabled?: boolean;
    /** Cron expression controlling how often the reminder poll runs (local and serverless). Default: every 10 minutes. */
    pollSchedule?: string;
  };
  /**
   * Declare env var names that tenants can self-manage via the web UI or API.
   * Key = env var name, value = human-readable label shown in the settings panel.
   * Example: { LINEAR_API_KEY: "Linear API Key", STRIPE_KEY: "Stripe Secret Key" }
   */
  tenantSecrets?: Record<string, string>;
  /** Set to `false` to disable the built-in web UI (headless / API-only mode). */
  webUi?: false;
  /** Enable browser automation tools. Set `true` for defaults, or provide config. */
  browser?:
    | boolean
    | {
        viewport?: { width?: number; height?: number };
        quality?: number;
        everyNthFrame?: number;
        profileDir?: string;
        sessionName?: string;
        executablePath?: string;
        headless?: boolean;
        /** Custom user-agent string. When stealth is enabled (default) a
         *  realistic Chrome UA is used automatically. */
        userAgent?: string;
        /** Reduce bot-detection fingerprints. Defaults to `true`. */
        stealth?: boolean;
        /** Cloud browser provider for serverless/remote deployments.
         *  Requires the provider's API key env var (e.g. `BROWSERBASE_API_KEY`). */
        provider?: "browserbase" | "browseruse" | "kernel";
        /** Connect to an existing browser via CDP URL or port.
         *  Mutually exclusive with `provider`. */
        cdpUrl?: string;
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
      urlEnv: config.storage.urlEnv,
      tokenEnv: config.storage.tokenEnv,
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
      urlEnv: config.storage.urlEnv,
      tokenEnv: config.storage.tokenEnv,
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
