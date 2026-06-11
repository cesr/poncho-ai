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
        // DDL is idempotent in our migrations (`CREATE TABLE IF NOT
        // EXISTS`, etc.), so retrying on a stale-socket drop is
        // safe — same idempotency as `query()` reads/writes.
        await this.runWithRetry(() => this.sql.unsafe(sql));
      },
      transaction: async (fn: () => Promise<void>): Promise<void> => {
        // Transactions are inherently retry-safe at the
        // CONNECTION_ENDED boundary: if the connection dies before
        // BEGIN takes effect server-side, no work was committed and
        // re-running `fn` produces the correct end state. The retry
        // only catches the connection-level reject from the
        // postgres.js client; a partial-commit + drop scenario
        // surfaces as a different error code and bypasses the
        // retry, preserving the caller's expectation that a
        // returned transaction either fully committed or fully
        // rolled back.
        await this.runWithRetry(() => this.sql.begin(async () => {
          await fn();
        }));
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
      // connections server-side after a few minutes — and on
      // Railway in particular, mid-stream drops within a few
      // seconds of inactivity are common. Without these knobs,
      // porsager/postgres keeps stale sockets in the pool; the
      // next query on one rejects with
      // `write CONNECTION_ENDED <host>:5432` at `durMs=0`,
      // surfacing as a hard failure to the caller.
      //
      //   - `idle_timeout: 5` closes idle connections client-side
      //     aggressively. Empirically Railway's pg drops sockets
      //     well before the 20s value that managed-provider docs
      //     suggest; 5s is short enough to win the race in
      //     practice while staying long enough that bursty
      //     workloads still get connection reuse.
      //   - `max_lifetime: 300` (5 min) recycles long-lived
      //     connections defensively. Even with idle_timeout, a
      //     connection that's been actively serving small queries
      //     for an hour can hit provider-side max-age limits.
      //   - `connect_timeout: 10` — slightly less patient on
      //     initial connect than the 30s default. Combined with
      //     the retry below, "connection refused" surfaces faster
      //     during incidents and the caller can shed load instead
      //     of stacking up.
      //
      // Pool size (`max: 10`) unchanged.
      idle_timeout: 5,
      max_lifetime: 60 * 5,
      connect_timeout: 10,
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
   * Retry on transient connection-layer failures. Three attempts
   * with exponential-ish backoff (0, 50ms, 200ms) — the pool may
   * have multiple stale sockets accumulated during an idle period
   * (especially on managed Postgres after boot when no traffic
   * has flowed for a while), so a single retry can land on a
   * second stale socket and still fail. Three attempts virtually
   * always exhausts the staleness wave; if all three throw, the
   * failure is real and the caller should see it.
   *
   * Applied to every pg path the executor exposes:
   *  - `query()` (run/get/all)  — natural retry: queries are
   *    idempotent at the connection-failure boundary because the
   *    server-side rollback runs cleanly on socket close.
   *  - `exec(sql)` for DDL      — `CREATE TABLE IF NOT EXISTS` and
   *    friends are idempotent by construction.
   *  - `transaction(fn)`        — only retried when the
   *    CONNECTION_ENDED reject arrives *before* the transaction
   *    body started executing on the connection; if it errors
   *    mid-transaction, the postgres.js client surfaces a
   *    different error class (the inner SQL error) and bypasses
   *    this retry, preserving the all-or-nothing semantics.
   */
  private async runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    const backoffs = [0, 50, 200];
    let lastErr: unknown;
    for (let attempt = 0; attempt < backoffs.length; attempt++) {
      if (backoffs[attempt] > 0) {
        await new Promise((r) => setTimeout(r, backoffs[attempt]));
      }
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const code = (err as { code?: string } | null | undefined)?.code;
        if (
          code === "CONNECTION_ENDED" ||
          code === "CONNECTION_CLOSED" ||
          code === "CONNECTION_DESTROYED" ||
          code === "CONNECT_TIMEOUT" ||
          code === "ECONNRESET"
        ) {
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
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
