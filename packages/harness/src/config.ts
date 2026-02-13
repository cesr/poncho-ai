import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpConfig } from "./mcp.js";

export interface AgentlConfig extends McpConfig {
  harness?: string;
  auth?: {
    required?: boolean;
    type?: "bearer" | "header" | "custom";
    headerName?: string;
    validate?: (token: string, req?: unknown) => Promise<boolean> | boolean;
  };
  state?: {
    provider?: "memory" | "redis" | "upstash" | "vercel-kv" | "dynamodb";
    ttl?: number;
    [key: string]: unknown;
  };
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
