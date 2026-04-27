// ---------------------------------------------------------------------------
// Shared SQL dialect abstraction + SqlStorageEngine base class.
//
// SQLite and PostgreSQL engines extend this base, providing only:
//   - a Dialect (placeholder style, types, now(), etc.)
//   - a query executor
// The base class contains all query logic + migration runner.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { createLogger } from "@poncho-ai/sdk";
import type {
  Conversation,
  ConversationCreateInit,
  ConversationStatusSnapshot,
  ConversationSummary,
  PendingSubagentResult,
} from "../state.js";

const egressLog = createLogger("egress");
import type { MainMemory } from "../memory.js";
import type { TodoItem } from "../todo-tools.js";
import type { Reminder, ReminderCreateInput, ReminderStatus } from "../reminder-store.js";
import type { StorageEngine, VfsDirEntry, VfsStat } from "./engine.js";
import { type DialectTag, migrations } from "./schema.js";

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

export interface Dialect {
  tag: DialectTag;
  /** Return a positional parameter placeholder. 1-indexed. */
  param(index: number): string;
  /** BLOB type name */
  blob: string;
  /** JSON type name */
  json: string;
  /** Current-timestamp expression */
  now(): string;
  /** UPSERT conflict clause for a given PK column list */
  upsert(pkCols: string[]): string;
}

export const sqliteDialect: Dialect = {
  tag: "sqlite",
  param: () => "?",
  blob: "BLOB",
  json: "TEXT",
  now: () => "datetime('now')",
  upsert: (cols) => `ON CONFLICT(${cols.join(", ")}) DO UPDATE SET`,
};

export const postgresDialect: Dialect = {
  tag: "postgresql",
  param: (i) => `$${i}`,
  blob: "BYTEA",
  json: "JSONB",
  now: () => "NOW()",
  upsert: (cols) => `ON CONFLICT(${cols.join(", ")}) DO UPDATE SET`,
};

// ---------------------------------------------------------------------------
// Query executor interface (provided by each engine subclass)
// ---------------------------------------------------------------------------

export interface QueryRow {
  [key: string]: unknown;
}

export interface QueryExecutor {
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T extends QueryRow = QueryRow>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T extends QueryRow = QueryRow>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Execute raw SQL (for migrations). */
  exec(sql: string): Promise<void>;
  /** Run multiple statements in a transaction. */
  transaction(fn: () => Promise<void>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TENANT = "__default__";
const DEFAULT_OWNER = "local-owner";

const normalizeTenant = (tenantId?: string | null): string =>
  tenantId ?? DEFAULT_TENANT;

const normalizeTitle = (title?: string): string =>
  title && title.trim().length > 0 ? title.trim() : "New conversation";

const parentOf = (p: string): string => {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
};

/** Parameterize a query for the dialect: replaces $1..$N with dialect placeholders. */
const rewrite = (sql: string, dialect: Dialect): string => {
  if (dialect.tag === "sqlite") {
    // Replace $1, $2, … with ?
    return sql.replace(/\$\d+/g, "?");
  }
  return sql;
};

// ---------------------------------------------------------------------------
// SqlStorageEngine base class
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Conversation egress meter — tracks estimated bytes read from / written to
// the conversations table per method. Enable periodic logging by setting
// PONCHO_LOG_EGRESS=1 in the environment.
// ---------------------------------------------------------------------------

interface EgressBucket {
  calls: number;
  bytes: number;
}

class ConversationEgressMeter {
  readonly read: Record<string, EgressBucket> = {};
  readonly write: Record<string, EgressBucket> = {};
  private lastLogAt = Date.now();
  private readonly logIntervalMs: number;
  private readonly enabled: boolean;

  constructor(logIntervalMs = 60_000) {
    this.logIntervalMs = logIntervalMs;
    this.enabled = process.env.PONCHO_LOG_EGRESS === "1";
  }

  trackRead(method: string, bytes: number): void {
    const b = (this.read[method] ??= { calls: 0, bytes: 0 });
    b.calls += 1;
    b.bytes += bytes;
    this.maybeLog();
  }

  trackWrite(method: string, bytes: number): void {
    const b = (this.write[method] ??= { calls: 0, bytes: 0 });
    b.calls += 1;
    b.bytes += bytes;
    this.maybeLog();
  }

  private maybeLog(): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (now - this.lastLogAt < this.logIntervalMs) return;
    this.lastLogAt = now;
    this.flush();
  }

  flush(): void {
    if (!this.enabled) return;
    const fmt = (buckets: Record<string, EgressBucket>) =>
      Object.entries(buckets)
        .filter(([, b]) => b.calls > 0)
        .map(([m, b]) => `${m}=${b.calls}calls/${fmtBytes(b.bytes)}`)
        .join(", ");
    const r = fmt(this.read);
    const w = fmt(this.write);
    if (r || w) {
      egressLog.debug(`read: ${r || "(none)"} | write: ${w || "(none)"}`);
    }
    // Reset after logging.
    for (const b of Object.values(this.read)) { b.calls = 0; b.bytes = 0; }
    for (const b of Object.values(this.write)) { b.calls = 0; b.bytes = 0; }
  }
}

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(2)}MB`;
};

/** Estimate the byte size of a string-ish value (JSON column from the DB). */
const colBytes = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  if (Buffer.isBuffer(v)) return v.byteLength;
  // JSONB columns in node-postgres come back as parsed objects — estimate
  // by re-stringifying. This is only called on the measured hot paths, so
  // the overhead is acceptable.
  return JSON.stringify(v).length;
};

export abstract class SqlStorageEngine implements StorageEngine {
  protected readonly dialect: Dialect;
  protected readonly agentId: string;
  protected abstract readonly executor: QueryExecutor;
  protected readonly egressMeter = new ConversationEgressMeter();

  constructor(dialect: Dialect, agentId: string) {
    this.dialect = dialect;
    this.agentId = agentId;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this.onBeforeInit();
    await this.runMigrations();
  }

  abstract close(): Promise<void>;

  /** Flush egress stats before shutdown. Subclasses should call super. */
  protected flushEgressStats(): void {
    this.egressMeter.flush();
  }

  /** Hook for subclass-specific setup (e.g. WAL mode). */
  protected async onBeforeInit(): Promise<void> {}

  // -----------------------------------------------------------------------
  // Migration runner
  // -----------------------------------------------------------------------

  private async runMigrations(): Promise<void> {
    const e = this.executor;

    // Fast path: if we know the latest migration version, just check
    // with a single lightweight query instead of CREATE TABLE + SELECT.
    const latestVersion = migrations[migrations.length - 1]?.version ?? 0;
    try {
      const row = await e.get<{ max_v: number | null }>(
        "SELECT MAX(version) as max_v FROM _migrations",
      );
      if (row && (row.max_v ?? 0) >= latestVersion) return; // all up to date
    } catch {
      // _migrations table doesn't exist yet — fall through to create it
    }

    await e.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
    );

    const row = await e.get<{ max_v: number | null }>(
      "SELECT MAX(version) as max_v FROM _migrations",
    );
    const applied = row?.max_v ?? 0;

    for (const m of migrations) {
      if (m.version <= applied) continue;
      const stmts = m.up(this.dialect.tag);
      await e.transaction(async () => {
        for (const sql of stmts) {
          await e.exec(sql);
        }
        await e.run(
          rewrite("INSERT INTO _migrations (version, name) VALUES ($1, $2)", this.dialect),
          [m.version, m.name],
        );
      });
    }
  }

  // -----------------------------------------------------------------------
  // Conversations
  // -----------------------------------------------------------------------

  conversations = {
    list: async (
      ownerId?: string,
      tenantId?: string | null,
    ): Promise<ConversationSummary[]> => {
      const tid = normalizeTenant(tenantId);
      // When tenantId is undefined (admin), don't filter by tenant
      const filterTenant = tenantId !== undefined;
      const params: unknown[] = [this.agentId];
      let sql = `SELECT id, title, updated_at, created_at, owner_id, tenant_id,
                        message_count, parent_conversation_id,
                        has_pending_approvals, channel_meta
                 FROM conversations WHERE agent_id = $1`;
      if (filterTenant) {
        sql += ` AND tenant_id = $2`;
        params.push(tid);
      }
      if (ownerId) {
        sql += ` AND owner_id = $${params.length + 1}`;
        params.push(ownerId);
      }
      sql += ` ORDER BY updated_at DESC`;

      const rows = await this.executor.all(rewrite(sql, this.dialect), params);
      return rows.map((r) => this.rowToSummary(r));
    },

    get: async (conversationId: string): Promise<Conversation | undefined> => {
      // Skip tool_result_archive — unbounded blob, only needed on run-entry
      // paths which must use getWithArchive() instead.
      const row = await this.executor.get<{
        data: unknown;
        harness_messages: unknown;
        continuation_messages: unknown;
      }>(
        rewrite("SELECT data, harness_messages, continuation_messages FROM conversations WHERE id = $1 AND agent_id = $2", this.dialect),
        [conversationId, this.agentId],
      );
      if (!row) return undefined;
      this.egressMeter.trackRead("get",
        colBytes(row.data) + colBytes(row.harness_messages) + colBytes(row.continuation_messages));
      const conv = this.parseConversation(row.data);
      if (row.harness_messages) {
        conv._harnessMessages =
          typeof row.harness_messages === "string"
            ? JSON.parse(row.harness_messages)
            : row.harness_messages;
      }
      if (row.continuation_messages) {
        conv._continuationMessages =
          typeof row.continuation_messages === "string"
            ? JSON.parse(row.continuation_messages)
            : row.continuation_messages;
      }
      return conv;
    },

    getStatusSnapshot: async (
      conversationId: string,
    ): Promise<ConversationStatusSnapshot | undefined> => {
      // Column-only read. runStatus lives inside the `data` JSON; extract it
      // with a dialect-specific JSON path expression rather than pulling the
      // whole blob.
      const runStatusExpr = this.dialect.tag === "sqlite"
        ? "json_extract(data, '$.runStatus')"
        : "data->>'runStatus'";
      const row = await this.executor.get<{
        updated_at: string;
        message_count: number;
        has_pending_approvals: number | boolean;
        parent_conversation_id: string | null;
        owner_id: string;
        tenant_id: string | null;
        has_continuation_messages: number | boolean;
        run_status: string | null;
      }>(
        rewrite(
          `SELECT updated_at, message_count, has_pending_approvals,
                  parent_conversation_id, owner_id, tenant_id,
                  (continuation_messages IS NOT NULL) AS has_continuation_messages,
                  ${runStatusExpr} AS run_status
           FROM conversations WHERE id = $1 AND agent_id = $2`,
          this.dialect,
        ),
        [conversationId, this.agentId],
      );
      if (!row) return undefined;
      this.egressMeter.trackRead("getStatusSnapshot", 200); // fixed-size column read
      const runStatus = row.run_status === "running" || row.run_status === "idle"
        ? row.run_status
        : null;
      return {
        conversationId,
        updatedAt: new Date(row.updated_at).getTime(),
        messageCount: row.message_count ?? 0,
        hasPendingApprovals: !!row.has_pending_approvals,
        hasContinuationMessages: !!row.has_continuation_messages,
        parentConversationId: row.parent_conversation_id,
        ownerId: row.owner_id,
        tenantId: row.tenant_id === "__default__" ? null : row.tenant_id,
        runStatus,
      };
    },

    getWithArchive: async (conversationId: string): Promise<Conversation | undefined> => {
      const row = await this.executor.get<{
        data: unknown;
        tool_result_archive: unknown;
        harness_messages: unknown;
        continuation_messages: unknown;
      }>(
        rewrite("SELECT data, tool_result_archive, harness_messages, continuation_messages FROM conversations WHERE id = $1 AND agent_id = $2", this.dialect),
        [conversationId, this.agentId],
      );
      if (!row) return undefined;
      this.egressMeter.trackRead("getWithArchive",
        colBytes(row.data) + colBytes(row.tool_result_archive) +
        colBytes(row.harness_messages) + colBytes(row.continuation_messages));
      const conv = this.parseConversation(row.data);
      if (row.tool_result_archive) {
        conv._toolResultArchive =
          typeof row.tool_result_archive === "string"
            ? JSON.parse(row.tool_result_archive)
            : row.tool_result_archive;
      }
      if (row.harness_messages) {
        conv._harnessMessages =
          typeof row.harness_messages === "string"
            ? JSON.parse(row.harness_messages)
            : row.harness_messages;
      }
      if (row.continuation_messages) {
        conv._continuationMessages =
          typeof row.continuation_messages === "string"
            ? JSON.parse(row.continuation_messages)
            : row.continuation_messages;
      }
      return conv;
    },

    create: async (
      ownerId?: string,
      title?: string,
      tenantId?: string | null,
      init?: ConversationCreateInit,
    ): Promise<Conversation> => {
      const id = randomUUID();
      const now = Date.now();
      const conv: Conversation = {
        conversationId: id,
        title: normalizeTitle(title),
        messages: init?.messages ?? [],
        ownerId: ownerId ?? DEFAULT_OWNER,
        tenantId: tenantId === undefined ? null : tenantId,
        createdAt: now,
        updatedAt: now,
        ...(init?.parentConversationId !== undefined
          ? { parentConversationId: init.parentConversationId }
          : {}),
        ...(init?.subagentMeta !== undefined
          ? { subagentMeta: init.subagentMeta }
          : {}),
        ...(init?.channelMeta !== undefined
          ? { channelMeta: init.channelMeta }
          : {}),
      };
      const data = JSON.stringify(conv);
      const channelMetaJson = conv.channelMeta ? JSON.stringify(conv.channelMeta) : null;
      await this.executor.run(
        rewrite(
          `INSERT INTO conversations (id, agent_id, tenant_id, owner_id, title, data, message_count, created_at, updated_at,
               parent_conversation_id, has_pending_approvals, channel_meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          this.dialect,
        ),
        [
          id,
          this.agentId,
          normalizeTenant(tenantId),
          conv.ownerId,
          conv.title,
          data,
          conv.messages.length,
          new Date(now).toISOString(),
          new Date(now).toISOString(),
          conv.parentConversationId ?? null,
          0,
          channelMetaJson,
        ],
      );
      return conv;
    },

    update: async (conversation: Conversation): Promise<void> => {
      conversation.updatedAt = Date.now();
      if (!conversation.createdAt) conversation.createdAt = conversation.updatedAt;
      // Strip heavy internal fields from the data blob — stored in separate columns
      const archive = conversation._toolResultArchive;
      const harnessMessages = conversation._harnessMessages;
      const continuationMessages = conversation._continuationMessages;
      const stripped = { ...conversation };
      delete stripped._toolResultArchive;
      delete stripped._harnessMessages;
      delete stripped._continuationMessages;
      const data = JSON.stringify(stripped);
      const archiveJson = archive ? JSON.stringify(archive) : null;
      const harnessJson = harnessMessages ? JSON.stringify(harnessMessages) : null;
      const continuationJson = continuationMessages ? JSON.stringify(continuationMessages) : null;
      this.egressMeter.trackWrite("update",
        data.length + (archiveJson?.length ?? 0) +
        (harnessJson?.length ?? 0) + (continuationJson?.length ?? 0));
      const msgCount = conversation.messages?.length ?? 0;
      const tid = normalizeTenant(conversation.tenantId);
      const now = new Date(conversation.updatedAt).toISOString();
      const created = new Date(conversation.createdAt).toISOString();
      const parentConvId = conversation.parentConversationId ?? null;
      const hasPendingApprovals = (conversation.pendingApprovals?.length ?? 0) > 0 ? 1 : 0;
      const channelMetaJson = conversation.channelMeta ? JSON.stringify(conversation.channelMeta) : null;
      await this.executor.run(
        rewrite(
          `INSERT INTO conversations (id, agent_id, tenant_id, owner_id, title, data, message_count, created_at, updated_at,
               tool_result_archive, harness_messages, continuation_messages,
               parent_conversation_id, has_pending_approvals, channel_meta)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ${this.dialect.upsert(["id"])}
           data = excluded.data, title = excluded.title, message_count = excluded.message_count,
           updated_at = excluded.updated_at, tenant_id = excluded.tenant_id, owner_id = excluded.owner_id,
           -- tool_result_archive is append-only from the caller's side; if the
           -- in-memory conversation was loaded via the light get() variant it
           -- won't have _toolResultArchive attached, so we must preserve the
           -- existing column instead of clobbering it with NULL.
           tool_result_archive = COALESCE(excluded.tool_result_archive, conversations.tool_result_archive),
           harness_messages = excluded.harness_messages,
           continuation_messages = excluded.continuation_messages,
           parent_conversation_id = excluded.parent_conversation_id,
           has_pending_approvals = excluded.has_pending_approvals,
           channel_meta = excluded.channel_meta`,
          this.dialect,
        ),
        [
          conversation.conversationId,
          this.agentId,
          tid,
          conversation.ownerId,
          conversation.title,
          data,
          msgCount,
          created,
          now,
          archiveJson,
          harnessJson,
          continuationJson,
          parentConvId,
          hasPendingApprovals,
          channelMetaJson,
        ],
      );
    },

    rename: async (
      conversationId: string,
      title: string,
    ): Promise<Conversation | undefined> => {
      const conv = await this.conversations.get(conversationId);
      if (!conv) return undefined;
      conv.title = normalizeTitle(title);
      await this.conversations.update(conv);
      return conv;
    },

    delete: async (conversationId: string): Promise<boolean> => {
      const row = await this.executor.get(
        rewrite("SELECT id FROM conversations WHERE id = $1 AND agent_id = $2", this.dialect),
        [conversationId, this.agentId],
      );
      if (!row) return false;
      await this.executor.run(
        rewrite("DELETE FROM conversations WHERE id = $1 AND agent_id = $2", this.dialect),
        [conversationId, this.agentId],
      );
      return true;
    },

    search: async (
      query: string,
      tenantId?: string | null,
    ): Promise<ConversationSummary[]> => {
      const tid = normalizeTenant(tenantId);
      const filterTenant = tenantId !== undefined;
      const pattern = `%${query}%`;
      // SQLite uses positional ? so we can't reuse $2, need separate params
      const params: unknown[] = [this.agentId, pattern, pattern];
      let sql = `SELECT id, title, updated_at, created_at, owner_id, tenant_id,
                        message_count, parent_conversation_id,
                        has_pending_approvals, channel_meta
                 FROM conversations
                 WHERE agent_id = $1 AND (title LIKE $2 OR data LIKE $3)`;
      if (filterTenant) {
        sql += ` AND tenant_id = $4`;
        params.push(tid);
      }
      sql += ` ORDER BY updated_at DESC`;
      const rows = await this.executor.all(rewrite(sql, this.dialect), params);
      return rows.map((r) => this.rowToSummary(r));
    },

    appendSubagentResult: async (
      conversationId: string,
      result: PendingSubagentResult,
    ): Promise<void> => {
      const conv = await this.conversations.get(conversationId);
      if (!conv) return;
      conv.pendingSubagentResults = [...(conv.pendingSubagentResults ?? []), result];
      await this.conversations.update(conv);
    },

    clearCallbackLock: async (
      conversationId: string,
    ): Promise<Conversation | undefined> => {
      const conv = await this.conversations.get(conversationId);
      if (!conv) return undefined;
      conv.runningCallbackSince = undefined;
      await this.conversations.update(conv);
      return conv;
    },
  };

  // -----------------------------------------------------------------------
  // Memory
  // -----------------------------------------------------------------------

  memory = {
    get: async (tenantId?: string | null): Promise<MainMemory> => {
      const tid = normalizeTenant(tenantId);
      const row = await this.executor.get<{ content: string; updated_at: string }>(
        rewrite(
          "SELECT content, updated_at FROM memory WHERE agent_id = $1 AND tenant_id = $2",
          this.dialect,
        ),
        [this.agentId, tid],
      );
      if (!row) return { content: "", updatedAt: 0 };
      return {
        content: row.content,
        updatedAt: new Date(row.updated_at).getTime(),
      };
    },

    update: async (content: string, tenantId?: string | null): Promise<MainMemory> => {
      const tid = normalizeTenant(tenantId);
      const now = new Date().toISOString();
      await this.executor.run(
        rewrite(
          `INSERT INTO memory (agent_id, tenant_id, content, updated_at)
           VALUES ($1, $2, $3, $4)
           ${this.dialect.upsert(["agent_id", "tenant_id"])}
           content = excluded.content, updated_at = excluded.updated_at`,
          this.dialect,
        ),
        [this.agentId, tid, content, now],
      );
      return { content, updatedAt: new Date(now).getTime() };
    },
  };

  // -----------------------------------------------------------------------
  // Todos
  // -----------------------------------------------------------------------

  todos = {
    get: async (conversationId: string): Promise<TodoItem[]> => {
      const row = await this.executor.get<{ data: string }>(
        rewrite(
          "SELECT data FROM todos WHERE agent_id = $1 AND conversation_id = $2",
          this.dialect,
        ),
        [this.agentId, conversationId],
      );
      if (!row) return [];
      return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    },

    set: async (conversationId: string, todos: TodoItem[]): Promise<void> => {
      const data = JSON.stringify(todos);
      await this.executor.run(
        rewrite(
          `INSERT INTO todos (agent_id, conversation_id, data)
           VALUES ($1, $2, $3)
           ${this.dialect.upsert(["agent_id", "conversation_id"])}
           data = excluded.data`,
          this.dialect,
        ),
        [this.agentId, conversationId, data],
      );
    },
  };

  // -----------------------------------------------------------------------
  // Reminders
  // -----------------------------------------------------------------------

  reminders = {
    list: async (tenantId?: string | null): Promise<Reminder[]> => {
      const tid = normalizeTenant(tenantId);
      const filterTenant = tenantId !== undefined;
      const params: unknown[] = [this.agentId];
      let sql = "SELECT * FROM reminders WHERE agent_id = $1";
      if (filterTenant) {
        sql += " AND tenant_id = $2";
        params.push(tid);
      }
      sql += " ORDER BY scheduled_at ASC";
      const rows = await this.executor.all(rewrite(sql, this.dialect), params);
      return rows.map((r) => this.rowToReminder(r));
    },

    create: async (input: ReminderCreateInput): Promise<Reminder> => {
      const id = randomUUID();
      const now = Date.now();
      const tid = normalizeTenant(input.tenantId);
      const recurrenceJson = input.recurrence ? JSON.stringify(input.recurrence) : null;
      await this.executor.run(
        rewrite(
          `INSERT INTO reminders (id, agent_id, tenant_id, owner_id, conversation_id, task, status, scheduled_at, timezone, created_at, recurrence, occurrence_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          this.dialect,
        ),
        [
          id,
          this.agentId,
          tid,
          input.ownerId ?? null,
          input.conversationId,
          input.task,
          "pending",
          input.scheduledAt,
          input.timezone ?? null,
          new Date(now).toISOString(),
          recurrenceJson,
          0,
        ],
      );
      return {
        id,
        task: input.task,
        scheduledAt: input.scheduledAt,
        timezone: input.timezone,
        status: "pending",
        createdAt: now,
        conversationId: input.conversationId,
        ownerId: input.ownerId,
        tenantId: input.tenantId,
        recurrence: input.recurrence ?? null,
        occurrenceCount: 0,
      };
    },

    update: async (id: string, fields: { scheduledAt?: number; occurrenceCount?: number; status?: ReminderStatus }): Promise<Reminder> => {
      const setClauses: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      if (fields.scheduledAt !== undefined) {
        setClauses.push(`scheduled_at = $${idx++}`);
        params.push(fields.scheduledAt);
      }
      if (fields.occurrenceCount !== undefined) {
        setClauses.push(`occurrence_count = $${idx++}`);
        params.push(fields.occurrenceCount);
      }
      if (fields.status !== undefined) {
        setClauses.push(`status = $${idx++}`);
        params.push(fields.status);
      }
      if (setClauses.length === 0) {
        // Nothing to update — just fetch
        const row = await this.executor.get(
          rewrite("SELECT * FROM reminders WHERE id = $1 AND agent_id = $2", this.dialect),
          [id, this.agentId],
        );
        if (!row) throw new Error(`Reminder ${id} not found`);
        return this.rowToReminder(row);
      }
      params.push(id, this.agentId);
      const idIdx = idx++;
      const agentIdx = idx++;
      await this.executor.run(
        rewrite(
          `UPDATE reminders SET ${setClauses.join(", ")} WHERE id = $${idIdx} AND agent_id = $${agentIdx}`,
          this.dialect,
        ),
        params,
      );
      const row = await this.executor.get(
        rewrite("SELECT * FROM reminders WHERE id = $1 AND agent_id = $2", this.dialect),
        [id, this.agentId],
      );
      if (!row) throw new Error(`Reminder ${id} not found`);
      return this.rowToReminder(row);
    },

    cancel: async (id: string): Promise<Reminder> => {
      await this.executor.run(
        rewrite(
          "UPDATE reminders SET status = 'cancelled' WHERE id = $1 AND agent_id = $2",
          this.dialect,
        ),
        [id, this.agentId],
      );
      const row = await this.executor.get(
        rewrite("SELECT * FROM reminders WHERE id = $1 AND agent_id = $2", this.dialect),
        [id, this.agentId],
      );
      if (!row) throw new Error(`Reminder ${id} not found`);
      return this.rowToReminder(row);
    },

    delete: async (id: string): Promise<void> => {
      await this.executor.run(
        rewrite("DELETE FROM reminders WHERE id = $1 AND agent_id = $2", this.dialect),
        [id, this.agentId],
      );
    },
  };

  // -----------------------------------------------------------------------
  // VFS
  // -----------------------------------------------------------------------

  vfs = {
    readFile: async (tenantId: string, path: string): Promise<Uint8Array> => {
      const row = await this.executor.get<{ content: unknown; type: string }>(
        rewrite(
          "SELECT content, type FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND path = $3",
          this.dialect,
        ),
        [this.agentId, tenantId, path],
      );
      if (!row) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      if (row.type === "directory") throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
      if (row.type === "symlink") {
        // Follow symlink
        const target = await this.resolveSymlink(tenantId, path);
        return this.vfs.readFile(tenantId, target);
      }
      return this.toUint8Array(row.content);
    },

    writeFile: async (
      tenantId: string,
      path: string,
      content: Uint8Array,
      mimeType?: string,
    ): Promise<void> => {
      // Ensure parent directories exist
      await this.ensureParentDirs(tenantId, path);
      const pp = parentOf(path);
      const now = new Date().toISOString();
      await this.executor.run(
        rewrite(
          `INSERT INTO vfs_entries (agent_id, tenant_id, path, parent_path, type, content, mime_type, size, mode, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'file', $5, $6, $7, 438, $8, $9)
           ${this.dialect.upsert(["agent_id", "tenant_id", "path"])}
           content = excluded.content, mime_type = excluded.mime_type, size = excluded.size, updated_at = excluded.updated_at, type = 'file'`,
          this.dialect,
        ),
        [this.agentId, tenantId, path, pp, content, mimeType ?? null, content.byteLength, now, now],
      );
    },

    appendFile: async (
      tenantId: string,
      path: string,
      content: Uint8Array,
    ): Promise<void> => {
      const existing = await this.executor.get<{ content: unknown }>(
        rewrite(
          "SELECT content FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND path = $3 AND type = 'file'",
          this.dialect,
        ),
        [this.agentId, tenantId, path],
      );
      if (existing) {
        const prev = this.toUint8Array(existing.content);
        const merged = new Uint8Array(prev.byteLength + content.byteLength);
        merged.set(prev);
        merged.set(content, prev.byteLength);
        await this.vfs.writeFile(tenantId, path, merged);
      } else {
        await this.vfs.writeFile(tenantId, path, content);
      }
    },

    deleteFile: async (tenantId: string, path: string): Promise<void> => {
      const stat = await this.vfs.stat(tenantId, path);
      if (!stat) throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
      if (stat.type === "directory") throw new Error(`EISDIR: illegal operation on a directory, unlink '${path}'`);
      await this.executor.run(
        rewrite(
          "DELETE FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND path = $3",
          this.dialect,
        ),
        [this.agentId, tenantId, path],
      );
    },

    deleteDir: async (
      tenantId: string,
      path: string,
      recursive?: boolean,
    ): Promise<void> => {
      if (recursive) {
        // Delete all entries under this path
        await this.executor.run(
          rewrite(
            "DELETE FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND (path = $3 OR path LIKE $4)",
            this.dialect,
          ),
          [this.agentId, tenantId, path, `${path}/%`],
        );
      } else {
        // Check if directory is empty
        const children = await this.vfs.readdir(tenantId, path);
        if (children.length > 0) {
          throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
        }
        await this.executor.run(
          rewrite(
            "DELETE FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND path = $3",
            this.dialect,
          ),
          [this.agentId, tenantId, path],
        );
      }
    },

    stat: async (tenantId: string, path: string): Promise<VfsStat | undefined> => {
      if (path === "/") {
        return {
          type: "directory",
          size: 0,
          mode: 0o755,
          createdAt: 0,
          updatedAt: 0,
        };
      }
      const row = await this.executor.get<{
        type: string;
        size: number;
        mode: number;
        mime_type: string | null;
        symlink_target: string | null;
        created_at: string;
        updated_at: string;
      }>(
        rewrite(
          "SELECT type, size, mode, mime_type, symlink_target, created_at, updated_at FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND path = $3",
          this.dialect,
        ),
        [this.agentId, tenantId, path],
      );
      if (!row) return undefined;
      return {
        type: row.type as VfsStat["type"],
        size: row.size,
        mode: row.mode,
        mimeType: row.mime_type ?? undefined,
        symlinkTarget: row.symlink_target ?? undefined,
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime(),
      };
    },

    readdir: async (tenantId: string, path: string): Promise<VfsDirEntry[]> => {
      const normalizedPath = path === "/" ? "/" : path;
      const rows = await this.executor.all<{ path: string; type: string }>(
        rewrite(
          "SELECT path, type FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND parent_path = $3",
          this.dialect,
        ),
        [this.agentId, tenantId, normalizedPath],
      );
      return rows.map((r) => ({
        name: r.path.slice(r.path.lastIndexOf("/") + 1),
        type: r.type as VfsDirEntry["type"],
      }));
    },

    mkdir: async (
      tenantId: string,
      path: string,
      recursive?: boolean,
    ): Promise<void> => {
      if (recursive) {
        const parts = path.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
          current += `/${part}`;
          await this.mkdirSingle(tenantId, current);
        }
      } else {
        // Check parent exists
        const pp = parentOf(path);
        if (pp !== "/") {
          const parentStat = await this.vfs.stat(tenantId, pp);
          if (!parentStat) {
            throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
          }
        }
        await this.mkdirSingle(tenantId, path);
      }
    },

    rename: async (
      tenantId: string,
      oldPath: string,
      newPath: string,
    ): Promise<void> => {
      await this.ensureParentDirs(tenantId, newPath);
      const newParent = parentOf(newPath);
      // Rename the entry itself
      await this.executor.run(
        rewrite(
          "UPDATE vfs_entries SET path = $1, parent_path = $2, updated_at = $3 WHERE agent_id = $4 AND tenant_id = $5 AND path = $6",
          this.dialect,
        ),
        [newPath, newParent, new Date().toISOString(), this.agentId, tenantId, oldPath],
      );
      // Rename children (for directories)
      const prefix = `${oldPath}/`;
      const rows = await this.executor.all<{ path: string }>(
        rewrite(
          "SELECT path FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND path LIKE $3",
          this.dialect,
        ),
        [this.agentId, tenantId, `${prefix}%`],
      );
      for (const row of rows) {
        const childNewPath = newPath + row.path.slice(oldPath.length);
        const childNewParent = parentOf(childNewPath);
        await this.executor.run(
          rewrite(
            "UPDATE vfs_entries SET path = $1, parent_path = $2 WHERE agent_id = $3 AND tenant_id = $4 AND path = $5",
            this.dialect,
          ),
          [childNewPath, childNewParent, this.agentId, tenantId, row.path],
        );
      }
    },

    chmod: async (tenantId: string, path: string, mode: number): Promise<void> => {
      await this.executor.run(
        rewrite(
          "UPDATE vfs_entries SET mode = $1, updated_at = $2 WHERE agent_id = $3 AND tenant_id = $4 AND path = $5",
          this.dialect,
        ),
        [mode, new Date().toISOString(), this.agentId, tenantId, path],
      );
    },

    utimes: async (tenantId: string, path: string, mtime: Date): Promise<void> => {
      await this.executor.run(
        rewrite(
          "UPDATE vfs_entries SET updated_at = $1 WHERE agent_id = $2 AND tenant_id = $3 AND path = $4",
          this.dialect,
        ),
        [mtime.toISOString(), this.agentId, tenantId, path],
      );
    },

    symlink: async (tenantId: string, target: string, linkPath: string): Promise<void> => {
      await this.ensureParentDirs(tenantId, linkPath);
      const pp = parentOf(linkPath);
      const now = new Date().toISOString();
      await this.executor.run(
        rewrite(
          `INSERT INTO vfs_entries (agent_id, tenant_id, path, parent_path, type, symlink_target, size, mode, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'symlink', $5, 0, 511, $6, $7)`,
          this.dialect,
        ),
        [this.agentId, tenantId, linkPath, pp, target, now, now],
      );
    },

    readlink: async (tenantId: string, path: string): Promise<string> => {
      const row = await this.executor.get<{ symlink_target: string | null; type: string }>(
        rewrite(
          "SELECT symlink_target, type FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND path = $3",
          this.dialect,
        ),
        [this.agentId, tenantId, path],
      );
      if (!row || row.type !== "symlink" || !row.symlink_target) {
        throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
      }
      return row.symlink_target;
    },

    lstat: async (tenantId: string, path: string): Promise<VfsStat | undefined> => {
      // Same as stat but doesn't follow symlinks
      if (path === "/") {
        return { type: "directory", size: 0, mode: 0o755, createdAt: 0, updatedAt: 0 };
      }
      const row = await this.executor.get<{
        type: string;
        size: number;
        mode: number;
        mime_type: string | null;
        symlink_target: string | null;
        created_at: string;
        updated_at: string;
      }>(
        rewrite(
          "SELECT type, size, mode, mime_type, symlink_target, created_at, updated_at FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND path = $3",
          this.dialect,
        ),
        [this.agentId, tenantId, path],
      );
      if (!row) return undefined;
      return {
        type: row.type as VfsStat["type"],
        size: row.size,
        mode: row.mode,
        mimeType: row.mime_type ?? undefined,
        symlinkTarget: row.symlink_target ?? undefined,
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime(),
      };
    },

    listAllPaths: (_tenantId: string): string[] => {
      // Default: return empty. Overridden by SQLite (sync query) and PostgreSQL (cache).
      return [];
    },

    getUsage: async (
      tenantId: string,
    ): Promise<{ fileCount: number; totalBytes: number }> => {
      const row = await this.executor.get<{ cnt: number; total: number }>(
        rewrite(
          "SELECT COUNT(*) as cnt, COALESCE(SUM(size), 0) as total FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND type = 'file'",
          this.dialect,
        ),
        [this.agentId, tenantId],
      );
      return { fileCount: Number(row?.cnt ?? 0), totalBytes: Number(row?.total ?? 0) };
    },
  };

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private parseConversation(data: unknown): Conversation {
    if (typeof data === "string") return JSON.parse(data);
    return data as Conversation;
  }

  private rowToSummary(row: QueryRow): ConversationSummary {
    const tid = row.tenant_id as string;
    const rawChannelMeta = row.channel_meta;
    return {
      conversationId: row.id as string,
      title: row.title as string,
      updatedAt: new Date(row.updated_at as string).getTime(),
      createdAt: row.created_at ? new Date(row.created_at as string).getTime() : undefined,
      ownerId: row.owner_id as string,
      tenantId: tid === DEFAULT_TENANT ? null : tid,
      messageCount: row.message_count as number,
      hasPendingApprovals: !!(row.has_pending_approvals),
      parentConversationId: (row.parent_conversation_id as string) || undefined,
      channelMeta: rawChannelMeta
        ? (typeof rawChannelMeta === "string" ? JSON.parse(rawChannelMeta) : rawChannelMeta)
        : undefined,
    };
  }

  private rowToReminder(row: QueryRow): Reminder {
    const tid = row.tenant_id as string;
    let recurrence: Reminder["recurrence"] = null;
    if (row.recurrence) {
      try {
        recurrence = typeof row.recurrence === "string"
          ? JSON.parse(row.recurrence)
          : row.recurrence;
      } catch {
        recurrence = null;
      }
    }
    return {
      id: row.id as string,
      task: row.task as string,
      scheduledAt: row.scheduled_at as number,
      timezone: (row.timezone as string) ?? undefined,
      status: row.status as Reminder["status"],
      createdAt: new Date(row.created_at as string).getTime(),
      conversationId: row.conversation_id as string,
      ownerId: (row.owner_id as string) ?? undefined,
      tenantId: tid === DEFAULT_TENANT ? null : tid,
      recurrence,
      occurrenceCount: (row.occurrence_count as number) ?? 0,
    };
  }

  protected toUint8Array(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (value instanceof Buffer) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof value === "string") return new TextEncoder().encode(value);
    return new Uint8Array();
  }

  private async ensureParentDirs(tenantId: string, path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    // Don't create the file/dir itself, only parents
    parts.pop();
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      const exists = await this.vfs.stat(tenantId, current);
      if (!exists) {
        await this.mkdirSingle(tenantId, current);
      }
    }
  }

  private async mkdirSingle(tenantId: string, path: string): Promise<void> {
    const pp = parentOf(path);
    const now = new Date().toISOString();
    await this.executor.run(
      rewrite(
        `INSERT INTO vfs_entries (agent_id, tenant_id, path, parent_path, type, size, mode, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'directory', 0, 493, $5, $6)
         ${this.dialect.upsert(["agent_id", "tenant_id", "path"])}
         updated_at = excluded.updated_at`,
        this.dialect,
      ),
      [this.agentId, tenantId, path, pp, now, now],
    );
  }

  private async resolveSymlink(
    tenantId: string,
    path: string,
    depth = 0,
  ): Promise<string> {
    if (depth > 20) throw new Error(`ELOOP: too many levels of symbolic links, open '${path}'`);
    const row = await this.executor.get<{ symlink_target: string | null; type: string }>(
      rewrite(
        "SELECT symlink_target, type FROM vfs_entries WHERE agent_id = $1 AND tenant_id = $2 AND path = $3",
        this.dialect,
      ),
      [this.agentId, tenantId, path],
    );
    if (!row || row.type !== "symlink" || !row.symlink_target) return path;
    const target = row.symlink_target.startsWith("/")
      ? row.symlink_target
      : `${parentOf(path)}/${row.symlink_target}`;
    return this.resolveSymlink(tenantId, target, depth + 1);
  }
}
