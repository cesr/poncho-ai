// ---------------------------------------------------------------------------
// PostgresEngine – postgres.js backed storage engine.
// ---------------------------------------------------------------------------

import type { QueryExecutor, QueryRow } from "./sql-dialect.js";
import { SqlStorageEngine, postgresDialect } from "./sql-dialect.js";

export class PostgresEngine extends SqlStorageEngine {
  private sql: any; // postgres.js Sql instance
  private readonly urlEnv: string;
  protected readonly executor: QueryExecutor;

  /** In-memory path cache per tenant for sync getAllPaths(). */
  private pathCache = new Map<string, string[]>();

  constructor(options: { agentId: string; urlEnv?: string }) {
    super(postgresDialect, options.agentId);
    this.urlEnv = options.urlEnv ?? "DATABASE_URL";

    this.executor = {
      run: async (sql: string, params?: unknown[]): Promise<void> => {
        await this.query(sql, params);
      },
      get: async <T extends QueryRow = QueryRow>(
        sql: string,
        params?: unknown[],
      ): Promise<T | undefined> => {
        const rows = await this.query(sql, params);
        return (rows[0] as T) ?? undefined;
      },
      all: async <T extends QueryRow = QueryRow>(
        sql: string,
        params?: unknown[],
      ): Promise<T[]> => {
        const rows = await this.query(sql, params);
        return rows as T[];
      },
      exec: async (sql: string): Promise<void> => {
        await this.sql.unsafe(sql);
      },
      transaction: async (fn: () => Promise<void>): Promise<void> => {
        await this.sql.begin(async () => {
          await fn();
        });
      },
    };
  }

  protected override async onBeforeInit(): Promise<void> {
    const url = process.env[this.urlEnv];
    if (!url) {
      throw new Error(
        `PostgreSQL connection URL not found. Set ${this.urlEnv} environment variable.`,
      );
    }
    const postgres = (await import("postgres")).default;
    this.sql = postgres(url, {
      onnotice: () => {},
      prepare: false,
      // Connection-pool resilience. Managed Postgres providers
      // (Railway, Neon, Heroku, etc.) routinely drop idle TCP
      // connections server-side after a few minutes. Without these
      // knobs, porsager/postgres keeps stale sockets in the pool;
      // the next query on one rejects with
      // `write CONNECTION_ENDED <host>:5432` at `durMs=0`, surfacing
      // as a hard failure to the caller. Two complementary settings:
      //
      //   - `idle_timeout: 20` closes idle connections client-side
      //     after 20s, before any reasonable provider-side timer
      //     fires. Fresh connection on next checkout = no stale
      //     socket race.
      //   - `max_lifetime: 600` (10 min) recycles long-lived
      //     connections defensively even if they've stayed busy,
      //     which sidesteps a separate class of provider-side
      //     "max connection age" limits.
      //
      // Defaults remain `max: 10`, `connect_timeout: 30` — leaving
      // pool size + initial connect behavior unchanged.
      idle_timeout: 20,
      max_lifetime: 60 * 10,
    });
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    this.patchVfs();
  }

  async close(): Promise<void> {
    this.flushEgressStats();
    await this.sql?.end();
  }

  /** Refresh the path cache for a tenant (call before bash.exec()). */
  async refreshPathCache(tenantId: string): Promise<void> {
    const rows = await this.query(
      "SELECT path FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2",
      [this.agentId, tenantId],
    );
    this.pathCache.set(tenantId, rows.map((r: any) => r.path as string));
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private patchVfs(): void {
    this.vfs.listAllPaths = (tenantId: string): string[] => {
      return this.pathCache.get(tenantId) ?? [];
    };

    const origWrite = this.vfs.writeFile;
    this.vfs.writeFile = async (
      tenantId: string,
      path: string,
      content: Uint8Array,
      mimeType?: string,
    ) => {
      await origWrite(tenantId, path, content, mimeType);
      this.addToPathCache(tenantId, path);
    };

    const origDelete = this.vfs.deleteFile;
    this.vfs.deleteFile = async (tenantId: string, path: string) => {
      await origDelete(tenantId, path);
      this.removeFromPathCache(tenantId, path);
    };

    const origRename = this.vfs.rename;
    this.vfs.rename = async (
      tenantId: string,
      oldPath: string,
      newPath: string,
    ) => {
      await origRename(tenantId, oldPath, newPath);
      this.removeFromPathCache(tenantId, oldPath);
      this.addToPathCache(tenantId, newPath);
    };
  }

  private async query(sql: string, params?: unknown[]): Promise<any[]> {
    return this.runWithRetry(() =>
      !params || params.length === 0
        ? this.sql.unsafe(sql)
        : this.sql.unsafe(sql, params),
    );
  }

  /**
   * Single retry on a transient connection-layer failure. The
   * `idle_timeout` / `max_lifetime` config above prevents *most*
   * stale-connection cases, but a query can still race a
   * provider-initiated drop in flight — the postgres.js client
   * rejects with `code: "CONNECTION_ENDED"` and the next attempt
   * checks out a fresh connection from the pool. One retry is
   * enough; if it fails again the host-side network is genuinely
   * broken and the caller should see the error.
   *
   * Only retries reads + the standard exec/run paths in `query`;
   * `sql.unsafe(sql)` calls in `executeRaw` (migration DDL) and
   * `sql.begin(...)` transactions are unwrapped — those are
   * idempotent-by-construction (DDL is `IF NOT EXISTS`) or
   * atomically scoped (transactions roll back cleanly), and adding
   * a retry around them would complicate the transaction
   * semantics.
   */
  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { code?: string } | null | undefined)?.code;
      if (code === "CONNECTION_ENDED" || code === "CONNECTION_CLOSED" || code === "CONNECTION_DESTROYED") {
        return await fn();
      }
      throw err;
    }
  }

  private addToPathCache(tenantId: string, path: string): void {
    const paths = this.pathCache.get(tenantId);
    if (paths && !paths.includes(path)) {
      paths.push(path);
    }
  }

  private removeFromPathCache(tenantId: string, path: string): void {
    const paths = this.pathCache.get(tenantId);
    if (paths) {
      const idx = paths.indexOf(path);
      if (idx !== -1) paths.splice(idx, 1);
    }
  }
}
