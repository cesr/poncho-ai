// ---------------------------------------------------------------------------
// SqliteEngine – better-sqlite3 backed storage engine.
// ---------------------------------------------------------------------------

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { QueryExecutor, QueryRow } from "./sql-dialect.js";
import { SqlStorageEngine, sqliteDialect } from "./sql-dialect.js";

type Database = import("better-sqlite3").Database;

const isServerless = (): boolean =>
  !!(
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY ||
    process.env.RENDER
  );

export class SqliteEngine extends SqlStorageEngine {
  private db!: Database;
  private readonly dbPath: string;
  protected readonly executor: QueryExecutor;

  constructor(options: { workingDir: string; agentId: string; dbPath?: string }) {
    super(sqliteDialect, options.agentId);

    this.dbPath =
      options.dbPath ??
      (isServerless()
        ? resolve("/tmp/.poncho/poncho.db")
        : resolve(options.workingDir, ".poncho", "poncho.db"));

    this.executor = {
      run: async (sql: string, params?: unknown[]): Promise<void> => {
        this.db.prepare(sql).run(...(params ?? []));
      },
      get: async <T extends QueryRow = QueryRow>(
        sql: string,
        params?: unknown[],
      ): Promise<T | undefined> => {
        return this.db.prepare(sql).get(...(params ?? [])) as T | undefined;
      },
      all: async <T extends QueryRow = QueryRow>(
        sql: string,
        params?: unknown[],
      ): Promise<T[]> => {
        return this.db.prepare(sql).all(...(params ?? [])) as T[];
      },
      exec: async (sql: string): Promise<void> => {
        this.db.exec(sql);
      },
      transaction: async (fn: () => Promise<void>): Promise<void> => {
        this.db.exec("BEGIN");
        try {
          await fn();
          this.db.exec("COMMIT");
        } catch (err) {
          this.db.exec("ROLLBACK");
          throw err;
        }
      },
    };
  }

  protected override async onBeforeInit(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });

    const BetterSqlite3 = (await import("better-sqlite3")).default;
    this.db = new BetterSqlite3(this.dbPath);

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    if (isServerless()) {
      console.warn(
        "[poncho] SQLite storage detected in serverless environment. " +
          "Data will NOT persist between invocations. " +
          "Configure `storage.provider: 'postgresql'` for persistent storage.",
      );
    }
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    // Patch listAllPaths to use synchronous better-sqlite3 queries
    this.vfs.listAllPaths = (tenantId: string): string[] => {
      if (!this.db) return [];
      const rows = this.db
        .prepare("SELECT path FROM vfs_entries WHERE agent_id = ? AND tenant_id = ?")
        .all(this.agentId, tenantId) as Array<{ path: string }>;
      return rows.map((r) => r.path);
    };
  }

  async close(): Promise<void> {
    this.db?.close();
  }
}
