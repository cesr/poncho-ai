// ---------------------------------------------------------------------------
// Storage engine factory + re-exports
// ---------------------------------------------------------------------------

export type { StorageEngine, VfsDirEntry, VfsStat } from "./engine.js";
export { InMemoryEngine } from "./memory-engine.js";
export { SqliteEngine } from "./sqlite-engine.js";
export { PostgresEngine } from "./postgres-engine.js";

import type { StorageEngine } from "./engine.js";
import { InMemoryEngine } from "./memory-engine.js";
import { SqliteEngine } from "./sqlite-engine.js";
import { PostgresEngine } from "./postgres-engine.js";

export type StorageProvider = "memory" | "sqlite" | "postgresql" | "local";

export interface StorageFactoryOptions {
  provider?: StorageProvider;
  workingDir: string;
  agentId: string;
  /** Env var name for the PostgreSQL connection URL (default: DATABASE_URL). */
  urlEnv?: string;
  /** Override the SQLite database file path. */
  dbPath?: string;
}

export function createStorageEngine(options: StorageFactoryOptions): StorageEngine {
  const provider = options.provider ?? "sqlite";

  switch (provider) {
    case "memory":
      return new InMemoryEngine(options.agentId);

    case "local":
    case "sqlite":
      return new SqliteEngine({
        workingDir: options.workingDir,
        agentId: options.agentId,
        dbPath: options.dbPath,
      });

    case "postgresql":
      return new PostgresEngine({
        agentId: options.agentId,
        urlEnv: options.urlEnv,
      });

    default: {
      const deprecated = ["redis", "upstash", "dynamodb"];
      if (deprecated.includes(provider)) {
        throw new Error(
          `Storage provider '${provider}' is no longer supported. ` +
            `Please migrate to 'sqlite' or 'postgresql'.`,
        );
      }
      throw new Error(`Unknown storage provider: ${provider}`);
    }
  }
}
