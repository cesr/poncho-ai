// ---------------------------------------------------------------------------
// Schema definitions and migrations for SQLite / PostgreSQL engines.
// ---------------------------------------------------------------------------

export interface Migration {
  version: number;
  name: string;
  up: (d: DialectTag) => string[];
}

/** Tag used by migrations to branch on backend. */
export type DialectTag = "sqlite" | "postgresql";

// ---------------------------------------------------------------------------
// Migration list
// ---------------------------------------------------------------------------

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (d) => {
      const jsonType = d === "sqlite" ? "TEXT" : "JSONB";
      const blobType = d === "sqlite" ? "BLOB" : "BYTEA";
      const tsDefault = d === "sqlite" ? "datetime('now')" : "NOW()";
      const autoTs = `DEFAULT (${tsDefault})`;

      return [
        // _migrations (self-bootstrap — created by runner, but listed for clarity)
        `CREATE TABLE IF NOT EXISTS _migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMP ${autoTs}
        )`,

        // conversations
        `CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '__default__',
          owner_id TEXT NOT NULL DEFAULT 'local-owner',
          title TEXT NOT NULL DEFAULT 'New conversation',
          data ${jsonType} NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP ${autoTs},
          updated_at TIMESTAMP ${autoTs}
        )`,
        `CREATE INDEX IF NOT EXISTS idx_conversations_lookup
          ON conversations (agent_id, tenant_id, owner_id, updated_at DESC)`,

        // memory
        `CREATE TABLE IF NOT EXISTS memory (
          agent_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '__default__',
          content TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMP ${autoTs},
          PRIMARY KEY (agent_id, tenant_id)
        )`,

        // todos
        `CREATE TABLE IF NOT EXISTS todos (
          agent_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          data ${jsonType} NOT NULL,
          PRIMARY KEY (agent_id, conversation_id)
        )`,

        // reminders
        `CREATE TABLE IF NOT EXISTS reminders (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '__default__',
          owner_id TEXT,
          conversation_id TEXT NOT NULL,
          task TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          scheduled_at REAL NOT NULL,
          timezone TEXT,
          created_at TIMESTAMP ${autoTs}
        )`,
        `CREATE INDEX IF NOT EXISTS idx_reminders_lookup
          ON reminders (agent_id, tenant_id, status, scheduled_at)`,

        // vfs_entries
        `CREATE TABLE IF NOT EXISTS vfs_entries (
          agent_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT '__default__',
          path TEXT NOT NULL,
          parent_path TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'file',
          content ${blobType},
          symlink_target TEXT,
          mime_type TEXT,
          size INTEGER NOT NULL DEFAULT 0,
          mode INTEGER NOT NULL DEFAULT 438,
          created_at TIMESTAMP ${autoTs},
          updated_at TIMESTAMP ${autoTs},
          PRIMARY KEY (agent_id, tenant_id, path)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_vfs_parent
          ON vfs_entries (agent_id, tenant_id, parent_path)`,
      ];
    },
  },
  {
    version: 2,
    name: "separate_tool_result_archive",
    up: (d) => {
      const jsonType = d === "sqlite" ? "TEXT" : "JSONB";
      return [
        `ALTER TABLE conversations ADD COLUMN tool_result_archive ${jsonType}`,
      ];
    },
  },
  {
    version: 3,
    name: "extract_heavy_fields_from_data_blob",
    up: (d) => {
      const jsonType = d === "sqlite" ? "TEXT" : "JSONB";
      return [
        `ALTER TABLE conversations ADD COLUMN harness_messages ${jsonType}`,
        `ALTER TABLE conversations ADD COLUMN continuation_messages ${jsonType}`,
        ...(d === "sqlite"
          ? [
              `UPDATE conversations SET
                tool_result_archive = json_extract(data, '$._toolResultArchive'),
                harness_messages = json_extract(data, '$._harnessMessages'),
                continuation_messages = json_extract(data, '$._continuationMessages')
              WHERE json_extract(data, '$._toolResultArchive') IS NOT NULL
                 OR json_extract(data, '$._harnessMessages') IS NOT NULL`,
              `UPDATE conversations SET data = json_remove(data, '$._toolResultArchive', '$._harnessMessages', '$._continuationMessages')`,
            ]
          : [
              `UPDATE conversations SET
                tool_result_archive = data->'_toolResultArchive',
                harness_messages = data->'_harnessMessages',
                continuation_messages = data->'_continuationMessages'
              WHERE data->'_toolResultArchive' IS NOT NULL
                 OR data->'_harnessMessages' IS NOT NULL`,
              `UPDATE conversations SET data = data - '_toolResultArchive' - '_harnessMessages' - '_continuationMessages'`,
            ]),
      ];
    },
  },
];
