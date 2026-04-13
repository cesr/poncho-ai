#!/usr/bin/env node
/**
 * Migration script: Import data from Upstash/local JSON stores into the
 * new StorageEngine (SQLite or PostgreSQL).
 *
 * Usage:
 *   # Local (.poncho/ JSON files) → SQLite (default)
 *   node scripts/migrate-to-engine.mjs --source local --working-dir /path/to/project
 *
 *   # Local → PostgreSQL
 *   DATABASE_URL=postgres://... node scripts/migrate-to-engine.mjs --source local --target postgresql --working-dir /path/to/project
 *
 *   # Upstash → PostgreSQL
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... DATABASE_URL=postgres://... \
 *     node scripts/migrate-to-engine.mjs --source upstash --target postgresql --agent-id my-agent
 *
 *   # Upstash → SQLite
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
 *     node scripts/migrate-to-engine.mjs --source upstash --target sqlite --agent-id my-agent --working-dir /path/to/project
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    source: { type: "string", default: "local" },
    target: { type: "string", default: "sqlite" },
    "working-dir": { type: "string", default: process.cwd() },
    "agent-id": { type: "string" },
    "url-env": { type: "string", default: "DATABASE_URL" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  console.log(`
Usage: node scripts/migrate-to-engine.mjs [options]

Options:
  --source        Source backend: "local" or "upstash" (default: local)
  --target        Target engine: "sqlite" or "postgresql" (default: sqlite)
  --working-dir   Project working directory (default: cwd)
  --agent-id      Agent ID (required for upstash, auto-detected for local)
  --url-env       Env var name for PostgreSQL URL (default: DATABASE_URL)
  --dry-run       Print what would be imported without writing
  --help          Show this help
`);
  process.exit(0);
}

const SOURCE = args.source;
const TARGET = args.target;
const WORKING_DIR = args["working-dir"];
const AGENT_ID = args["agent-id"];
const URL_ENV = args["url-env"];
const DRY_RUN = args["dry-run"];

// ---------------------------------------------------------------------------
// Upstash reader
// ---------------------------------------------------------------------------

async function upstashGet(baseUrl, token, key) {
  const res = await fetch(`${baseUrl}/get/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) return undefined;
  const { result } = await res.json();
  return result ?? undefined;
}

async function upstashScan(baseUrl, token, pattern) {
  let cursor = "0";
  const keys = [];
  do {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SCAN", cursor, "MATCH", pattern, "COUNT", "5000"]),
    });
    const { result } = await res.json();
    cursor = result[0];
    keys.push(...result[1]);
    process.stdout.write(`\r  Scanning: ${keys.length} keys (cursor: ${cursor})`);
  } while (cursor !== "0" && cursor !== 0);
  console.log("");
  return keys;
}

// ---------------------------------------------------------------------------
// Local JSON reader
// ---------------------------------------------------------------------------

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

async function findAgentDirs(workingDir) {
  const ponchoDir = resolve(workingDir, ".poncho");
  const results = [];
  try {
    const entries = await readdir(ponchoDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) {
        results.push({ dir: resolve(ponchoDir, e.name), id: e.name });
      }
    }
  } catch { /* no .poncho dir */ }
  return results;
}

// ---------------------------------------------------------------------------
// Read from local
// ---------------------------------------------------------------------------

async function readLocalAgent(agent) {
  console.log(`  Reading agent: ${agent.id} at ${agent.dir}`);

  const data = { agentId: agent.id, conversations: [], memories: [], todos: [], reminders: [] };

  // Conversations: read index + individual files
  const indexPath = resolve(agent.dir, "conversations", "index.json");
  const index = await readJsonSafe(indexPath);
  if (index?.conversations) {
    for (const entry of index.conversations) {
      const convFile = resolve(agent.dir, entry.fileName);
      const conv = await readJsonSafe(convFile);
      if (conv) {
        data.conversations.push(conv);
      }
    }
  } else {
    // Try reading conversation files directly
    try {
      const files = await readdir(agent.dir);
      for (const f of files) {
        if (f.endsWith(".json") && f.includes("--")) {
          const conv = await readJsonSafe(resolve(agent.dir, f));
          if (conv?.conversationId) data.conversations.push(conv);
        }
      }
    } catch { /* no conversation files */ }
  }

  // Memory (default tenant)
  const memPath = resolve(agent.dir, "memory.json");
  const mem = await readJsonSafe(memPath);
  if (mem?.main?.content) {
    data.memories.push({ tenantId: null, content: mem.main });
  }

  // Todos
  const todosDir = resolve(agent.dir, "todos");
  try {
    const todoFiles = await readdir(todosDir);
    for (const f of todoFiles) {
      if (f.endsWith(".json")) {
        const todos = await readJsonSafe(resolve(todosDir, f));
        if (Array.isArray(todos)) {
          const conversationId = basename(f, ".json");
          data.todos.push({ conversationId, items: todos });
        }
      }
    }
  } catch { /* no todos dir */ }

  // Reminders
  const remPath = resolve(agent.dir, "reminders.json");
  const rems = await readJsonSafe(remPath);
  if (Array.isArray(rems)) {
    data.reminders = rems;
  }

  return data;
}

async function readLocal(workingDir) {
  const agents = await findAgentDirs(workingDir);
  if (agents.length === 0) {
    console.error("No .poncho agent directory found in", workingDir);
    process.exit(1);
  }

  // If --agent-id is specified, filter to that agent
  const filtered = AGENT_ID ? agents.filter((a) => a.id === AGENT_ID) : agents;
  if (filtered.length === 0) {
    console.error(`Agent "${AGENT_ID}" not found. Available agents: ${agents.map((a) => a.id).join(", ")}`);
    process.exit(1);
  }

  console.log(`Found ${filtered.length} agent(s) to migrate`);

  const results = [];
  for (const agent of filtered) {
    results.push(await readLocalAgent(agent));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Read from Upstash
// ---------------------------------------------------------------------------

async function readUpstash(agentId) {
  const baseUrl = (process.env.UPSTASH_REDIS_REST_URL ?? "").replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
  if (!baseUrl || !token) {
    console.error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
    process.exit(1);
  }
  if (!agentId) {
    console.error("--agent-id is required for upstash source");
    process.exit(1);
  }

  const prefix = `poncho:v1:${agentId}`;
  console.log(`Scanning Upstash keys with prefix: ${prefix}*`);

  const data = { agentId, conversations: [], memories: [], todos: [], reminders: [] };
  const convMetaMap = new Map();

  // Scan all keys
  const keys = await upstashScan(baseUrl, token, `${prefix}*`);
  console.log(`Found ${keys.length} keys`);

  // Batch fetch with MGET (small batches — large conversation payloads
  // can cause Upstash to truncate responses with big batches)
  const BATCH = 5;
  let processed = 0;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(["MGET", ...batch]),
    });
    const { result: values } = await res.json();

    for (let j = 0; j < batch.length; j++) {
      const key = batch[j];
      const raw = values?.[j];
      if (!raw) continue;

      try {
        const parsed = JSON.parse(raw);

        if (key.includes(":convmeta:")) {
          // Conversation summary/metadata (has channelMeta, title, etc.)
          // Skip timestamped variants like convmeta:id_1234567890
          if (parsed.conversationId && !key.match(/:convmeta:[^:]+_\d+$/)) {
            convMetaMap.set(parsed.conversationId, parsed);
          }
        } else if (key.includes(":conv:")) {
          if (parsed.conversationId) {
            data.conversations.push(parsed);
          } else {
            console.warn(`\n  Warning: conv key missing conversationId: ${key}`);
          }
        } else if (key.includes(":memory:main")) {
          // Extract tenant from key: ...:t:{tenantId}:memory:main or just ...:memory:main
          const tenantMatch = key.match(/:t:([^:]+):memory:main/);
          const tenantId = tenantMatch ? tenantMatch[1] : null;
          const content = parsed?.main ?? parsed;
          data.memories.push({ tenantId, content });
        } else if (key.includes(":todos:")) {
          const convId = key.split(":todos:")[1];
          if (Array.isArray(parsed)) {
            data.todos.push({ conversationId: convId, items: parsed });
          }
        } else if (key.includes(":reminders")) {
          if (Array.isArray(parsed)) {
            data.reminders = parsed;
          }
        }
      } catch (e) {
        if (key.includes(":conv:")) {
          console.warn(`\n  Warning: failed to parse conv key: ${key} — ${e.message}`);
        }
      }
    }

    processed += batch.length;
    process.stdout.write(`\r  Reading keys: ${processed}/${keys.length}`);
  }
  console.log(""); // newline after progress

  // Merge convmeta (channelMeta, etc.) into full conversation data
  let metaMerged = 0;
  for (const conv of data.conversations) {
    const meta = convMetaMap.get(conv.conversationId);
    if (meta) {
      if (meta.channelMeta && !conv.channelMeta) {
        conv.channelMeta = meta.channelMeta;
      }
      if (meta.title && (!conv.title || conv.title === "New conversation")) {
        conv.title = meta.title;
      }
      metaMerged++;
    }
  }

  // Add conversations that only exist in convmeta (no conv: key)
  const existingIds = new Set(data.conversations.map(c => c.conversationId));
  let metaOnly = 0;
  for (const [id, meta] of convMetaMap) {
    if (!existingIds.has(id)) {
      // convmeta-only conversation (no full data) — import as empty with metadata
      data.conversations.push({
        conversationId: id,
        title: meta.title ?? "New conversation",
        messages: [],
        ownerId: meta.ownerId ?? "local-owner",
        tenantId: meta.tenantId ?? null,
        channelMeta: meta.channelMeta,
        createdAt: meta.createdAt ?? Date.now(),
        updatedAt: meta.updatedAt ?? Date.now(),
      });
      metaOnly++;
    }
  }
  if (metaMerged > 0) console.log(`  Merged metadata into ${metaMerged} conversations`);
  if (metaOnly > 0) console.log(`  Added ${metaOnly} metadata-only conversations (no message data in Upstash)`);

  return data;
}

// ---------------------------------------------------------------------------
// Read from engine (sqlite or postgresql)
// ---------------------------------------------------------------------------

async function readFromEngine(sourceProvider, agentId) {
  if (!agentId) {
    // Try to detect from .poncho directory
    const agents = await findAgentDirs(WORKING_DIR);
    if (agents.length === 1) agentId = agents[0].id;
    else if (agents.length > 1) {
      console.error(`Multiple agents found: ${agents.map((a) => a.id).join(", ")}. Use --agent-id to specify one.`);
      process.exit(1);
    } else {
      console.error("--agent-id is required for engine source (or run from a project with .poncho/)");
      process.exit(1);
    }
  }

  const { createStorageEngine } = await import("../dist/index.js");
  const engine = createStorageEngine({
    provider: sourceProvider,
    workingDir: WORKING_DIR,
    agentId,
    urlEnv: SOURCE === "postgresql" ? (process.env.SOURCE_DATABASE_URL ? "SOURCE_DATABASE_URL" : URL_ENV) : undefined,
  });
  await engine.initialize();

  console.log(`Reading from ${sourceProvider} engine (agent: ${agentId})`);

  const data = { agentId, conversations: [], memories: [], todos: [], reminders: [] };

  // Conversations
  const summaries = await engine.conversations.list();
  let i = 0;
  for (const s of summaries) {
    const conv = await engine.conversations.get(s.conversationId);
    if (conv) data.conversations.push(conv);
    i++;
    if (i % 20 === 0) process.stdout.write(`\r  Reading conversations: ${i}/${summaries.length}`);
  }
  if (summaries.length > 0) console.log(`\r  Reading conversations: ${summaries.length}/${summaries.length}`);

  // Memory
  const mem = await engine.memory.get();
  if (mem.content) data.memories.push({ tenantId: null, content: mem });

  // Reminders
  data.reminders = await engine.reminders.list();

  // VFS files (read all paths and content)
  data.vfsFiles = [];
  const paths = engine.vfs.listAllPaths("__default__");
  for (const path of paths) {
    try {
      const stat = await engine.vfs.stat("__default__", path);
      if (stat?.type === "file") {
        const content = await engine.vfs.readFile("__default__", path);
        data.vfsFiles.push({ path, content, mimeType: stat.mimeType });
      }
    } catch { /* skip unreadable */ }
  }

  await engine.close();
  return data;
}

// ---------------------------------------------------------------------------
// Write to engine
// ---------------------------------------------------------------------------

async function writeToEngine(data) {
  // Dynamic import of the storage engine
  const { createStorageEngine } = await import("../dist/index.js");

  const engine = createStorageEngine({
    provider: TARGET,
    workingDir: WORKING_DIR,
    agentId: data.agentId,
    urlEnv: URL_ENV,
  });

  await engine.initialize();

  let convCount = 0;
  let todoCount = 0;
  let reminderCount = 0;
  let timestampFixups = null;

  // Import conversations
  for (const conv of data.conversations) {
    if (DRY_RUN) {
      convCount++;
      continue;
    }
    // Create with a new ID, then overwrite with original data (preserving timestamps)
    const created = await engine.conversations.create(
      conv.ownerId ?? "local-owner",
      conv.title,
      conv.tenantId,
    );
    // Temporarily set updatedAt so update() writes the original value
    const merged = {
      ...conv,
      conversationId: created.conversationId,
      updatedAt: conv.updatedAt || Date.now(),
      createdAt: conv.createdAt || Date.now(),
    };
    // update() will overwrite updatedAt with Date.now(), so we track what we want
    const wantedUpdatedAt = merged.updatedAt;
    await engine.conversations.update(merged);
    // Stash the desired timestamp for a post-import fixup
    if (!timestampFixups) timestampFixups = [];
    timestampFixups.push({ id: created.conversationId, updatedAt: wantedUpdatedAt, createdAt: merged.createdAt });
    convCount++;
  }

  // Import memories (per-tenant)
  let memoryCount = 0;
  for (const mem of (data.memories ?? [])) {
    const content = typeof mem.content === "string" ? mem.content : mem.content?.content;
    if (!content) continue;
    if (DRY_RUN) {
      console.log(`  [dry-run] Would import memory for tenant=${mem.tenantId ?? "(default)"} (${content.length} chars)`);
    } else {
      await engine.memory.update(content, mem.tenantId);
    }
    memoryCount++;
  }

  // Import todos
  for (const { conversationId, items } of data.todos) {
    if (DRY_RUN) {
      console.log(`  [dry-run] Would import ${items.length} todos for conversation ${conversationId}`);
      todoCount += items.length;
      continue;
    }
    await engine.todos.set(conversationId, items);
    todoCount += items.length;
  }

  // Import reminders
  for (const reminder of data.reminders) {
    if (DRY_RUN) {
      console.log(`  [dry-run] Would import reminder: ${reminder.id} "${reminder.task}"`);
      reminderCount++;
      continue;
    }
    await engine.reminders.create({
      task: reminder.task,
      scheduledAt: reminder.scheduledAt,
      timezone: reminder.timezone,
      conversationId: reminder.conversationId ?? "__default__",
      ownerId: reminder.ownerId,
      tenantId: reminder.tenantId,
    });
    reminderCount++;
  }

  // Import VFS files (from engine-to-engine migrations)
  let vfsCount = 0;
  if (data.vfsFiles?.length) {
    for (const file of data.vfsFiles) {
      if (DRY_RUN) {
        console.log(`  [dry-run] Would import VFS file: ${file.path} (${file.content.byteLength} bytes)`);
        vfsCount++;
        continue;
      }
      await engine.vfs.writeFile("__default__", file.path, file.content, file.mimeType);
      vfsCount++;
    }
  }

  // Fix conversation timestamps (update() always sets updatedAt = now)
  if (timestampFixups?.length && !DRY_RUN && TARGET === "sqlite") {
    const Database = (await import("better-sqlite3")).default;
    const { resolve: r } = await import("node:path");
    const dbPath = r(WORKING_DIR, ".poncho", "poncho.db");
    const db = new Database(dbPath);
    const stmt = db.prepare("UPDATE conversations SET updated_at = ?, created_at = ? WHERE id = ?");
    for (const fix of timestampFixups) {
      stmt.run(new Date(fix.updatedAt).toISOString(), new Date(fix.createdAt).toISOString(), fix.id);
    }
    db.close();
    console.log(`  Fixed timestamps for ${timestampFixups.length} conversations`);
  }

  await engine.close();

  return { convCount, todoCount, reminderCount, vfsCount, memoryCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nMigrating: ${SOURCE} → ${TARGET}`);
  console.log(`Working dir: ${WORKING_DIR}`);
  if (DRY_RUN) console.log("(dry run — no data will be written)\n");

  // Read source — local returns an array (one per agent), others return a single object
  let dataList;
  if (SOURCE === "local") {
    dataList = await readLocal(WORKING_DIR);
  } else if (SOURCE === "upstash") {
    dataList = [await readUpstash(AGENT_ID)];
  } else if (SOURCE === "sqlite" || SOURCE === "postgresql") {
    dataList = [await readFromEngine(SOURCE, AGENT_ID)];
  } else {
    console.error(`Unknown source: ${SOURCE}. Use "local", "upstash", "sqlite", or "postgresql".`);
    process.exit(1);
  }

  for (const data of dataList) {
    console.log(`\nAgent: ${data.agentId}`);
    console.log(`  Read from ${SOURCE}:`);
    console.log(`    Conversations: ${data.conversations.length}`);
    console.log(`    Memories: ${data.memories?.length ?? 0}`);
    console.log(`    Todo lists: ${data.todos.length}`);
    console.log(`    Reminders: ${data.reminders.length}`);
    if (data.vfsFiles?.length) console.log(`    VFS files: ${data.vfsFiles.length}`);

    if (data.conversations.length === 0 && !data.memories?.length && data.todos.length === 0 && data.reminders.length === 0 && !data.vfsFiles?.length) {
      console.log("  Nothing to migrate for this agent.");
      continue;
    }

    const result = await writeToEngine(data);

    console.log(`  ${DRY_RUN ? "Would import" : "Imported"} to ${TARGET}:`);
    console.log(`    Conversations: ${result.convCount}`);
    console.log(`    Memories: ${result.memoryCount}`);
    console.log(`    Todos: ${result.todoCount}`);
    console.log(`    Reminders: ${result.reminderCount}`);
    if (result.vfsCount) console.log(`    VFS files: ${result.vfsCount}`);
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("\nMigration failed:", err);
  process.exit(1);
});
