import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createJiti } from "jiti";
import type { JsonSchema } from "@poncho-ai/sdk";
import type { MemoryConfig } from "./memory.js";
import type { McpConfig } from "./mcp.js";
import type { StateConfig } from "./state.js";

export interface StorageConfig {
  provider?: "local" | "memory" | "sqlite" | "postgresql" | "redis" | "upstash" | "dynamodb";
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
  limits?: {
    maxFileSize?: number;
    maxTotalStorage?: number;
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

export interface IsolateBinding {
  description: string;
  inputSchema: JsonSchema;
  handler: (input: Record<string, unknown>) => Promise<unknown> | unknown;
}

/**
 * Network access configuration for the bash sandbox (curl, wget).
 * Network access is disabled by default — you must explicitly allow URLs.
 */
export interface NetworkConfig {
  /**
   * List of allowed URL prefixes. Each entry must be a full origin (scheme + host),
   * optionally followed by a path prefix.
   *
   * Examples:
   * - `"https://api.example.com"` — allows all paths on this origin
   * - `"https://api.example.com/v1/"` — allows only paths starting with /v1/
   *
   * Entries can be plain strings or objects with header transforms for credentials brokering:
   * ```
   * { url: "https://api.example.com", transform: [{ headers: { "Authorization": "Bearer ..." } }] }
   * ```
   */
  allowedUrls?: (string | { url: string; transform?: { headers: Record<string, string> }[] })[];
  /** Allowed HTTP methods. Defaults to `["GET", "HEAD"]`. */
  allowedMethods?: ("GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS")[];
  /** Bypass the allow-list and permit all URLs and methods. Only use in trusted environments. */
  dangerouslyAllowAll?: boolean;
  /** Maximum number of redirects to follow. Default: 20. */
  maxRedirects?: number;
  /** Request timeout in milliseconds. Default: 30000. */
  timeoutMs?: number;
  /** Maximum response body size in bytes. Default: 10MB. */
  maxResponseSize?: number;
  /** Reject URLs resolving to private/loopback IPs (SSRF protection). Default: false. */
  denyPrivateRanges?: boolean;
}

export interface BashExecutionLimits {
  /** Maximum function call/recursion depth. Default: 100. */
  maxCallDepth?: number;
  /** Maximum number of commands to execute. Default: 10000. */
  maxCommandCount?: number;
  /** Maximum loop iterations for while/for/until. Default: 10000. */
  maxLoopIterations?: number;
  /** Maximum total output size (stdout + stderr) in bytes. Default: 10MB. */
  maxOutputSize?: number;
  /** Maximum string length in bytes. Default: 10MB. */
  maxStringLength?: number;
  /** Maximum array elements. Default: 100000. */
  maxArrayElements?: number;
}

export interface BashConfig {
  /**
   * Whitelist of allowed commands. When set, only these commands are available.
   * Omit to allow all built-in commands.
   *
   * @example ["cat", "grep", "jq", "echo", "ls", "head", "tail", "wc", "sort"]
   */
  commands?: string[];
  /** Execution limits to prevent runaway scripts. */
  executionLimits?: BashExecutionLimits;
  /** Enable python3/python commands in the sandbox. Default: false. */
  python?: boolean;
  /** Enable js-exec/node commands via QuickJS in the sandbox. Default: false. */
  javascript?: boolean;
  /** Environment variables injected into every bash session. */
  env?: Record<string, string>;
}

export interface IsolateConfig {
  /** V8 isolate memory limit in MB. Default: 128 */
  memoryLimit?: number;
  /** Execution timeout in ms. Default: 10000 */
  timeLimit?: number;
  /** Max combined stdout+stderr in bytes. Default: 65536 */
  outputLimit?: number;
  /** Max code input size in bytes. Default: 102400 (100KB) */
  codeLimit?: number;
  /** npm packages to bundle and make available via require() */
  libraries?: string[];
  /** External API access */
  apis?: {
    fetch?: { allowedDomains: string[] };
  };
  /** Builder-defined custom bindings injected into the isolate */
  bindings?: Record<string, IsolateBinding>;
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
  /** Enable sandboxed V8 isolate code execution. */
  isolate?: IsolateConfig;
  /**
   * Network access for sandboxed tools (bash curl/wget, isolate fetch).
   * Disabled by default — you must explicitly allow URLs.
   */
  network?: NetworkConfig;
  /** Bash sandbox configuration. */
  bash?: BashConfig;
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
