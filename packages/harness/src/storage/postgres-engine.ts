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
      onnotice: () => {}, // suppress CREATE TABLE IF NOT EXISTS notices
    });
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    this.patchVfs();
  }

  async close(): Promise<void> {
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
    if (!params || params.length === 0) {
      return this.sql.unsafe(sql);
    }
    return this.sql.unsafe(sql, params);
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
