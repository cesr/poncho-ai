// ---------------------------------------------------------------------------
// InMemoryEngine – Map-based storage for testing and ephemeral use.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type {
  Conversation,
  ConversationCreateInit,
  ConversationSummary,
  PendingSubagentResult,
} from "../state.js";
import type { MainMemory } from "../memory.js";
import type { TodoItem } from "../todo-tools.js";
import type { Reminder } from "../reminder-store.js";
import type { StorageEngine, VfsDirEntry, VfsStat } from "./engine.js";

// ---------------------------------------------------------------------------
// Internal VFS entry type
// ---------------------------------------------------------------------------

interface VfsEntry {
  type: "file" | "directory" | "symlink";
  content: Uint8Array | null;
  symlinkTarget: string | null;
  mimeType: string | null;
  size: number;
  mode: number;
  createdAt: number;
  updatedAt: number;
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

const vfsKey = (tenantId: string, path: string) => `${tenantId}\0${path}`;

// ---------------------------------------------------------------------------
// InMemoryEngine
// ---------------------------------------------------------------------------

export class InMemoryEngine implements StorageEngine {
  private readonly agentId: string;

  // Conversation data
  private convs = new Map<string, Conversation>();
  // Memory data
  private mem = new Map<string, MainMemory>();
  // Todos data
  private todoData = new Map<string, TodoItem[]>();
  // Reminders data
  private reminderData = new Map<string, Reminder>();
  // VFS data
  private vfsData = new Map<string, VfsEntry>();

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  // -----------------------------------------------------------------------
  // Conversations
  // -----------------------------------------------------------------------

  conversations = {
    list: async (
      ownerId?: string,
      tenantId?: string | null,
    ): Promise<ConversationSummary[]> => {
      const tid = normalizeTenant(tenantId);
      const filterTenant = tenantId !== undefined;
      const results: ConversationSummary[] = [];
      for (const c of this.convs.values()) {
        if (filterTenant) {
          const cTid = normalizeTenant(c.tenantId);
          if (cTid !== tid) continue;
        }
        if (ownerId && c.ownerId !== ownerId) continue;
        results.push(this.toSummary(c));
      }
      results.sort((a, b) => b.updatedAt - a.updatedAt);
      return results;
    },

    get: async (conversationId: string): Promise<Conversation | undefined> => {
      return this.convs.get(conversationId);
    },

    create: async (
      ownerId?: string,
      title?: string,
      tenantId?: string | null,
      init?: ConversationCreateInit,
    ): Promise<Conversation> => {
      const now = Date.now();
      const conv: Conversation = {
        conversationId: randomUUID(),
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
      this.convs.set(conv.conversationId, conv);
      return conv;
    },

    update: async (conversation: Conversation): Promise<void> => {
      conversation.updatedAt = Date.now();
      this.convs.set(conversation.conversationId, conversation);
    },

    rename: async (
      conversationId: string,
      title: string,
    ): Promise<Conversation | undefined> => {
      const conv = this.convs.get(conversationId);
      if (!conv) return undefined;
      conv.title = normalizeTitle(title);
      conv.updatedAt = Date.now();
      return conv;
    },

    delete: async (conversationId: string): Promise<boolean> => {
      return this.convs.delete(conversationId);
    },

    search: async (
      query: string,
      tenantId?: string | null,
    ): Promise<ConversationSummary[]> => {
      const tid = normalizeTenant(tenantId);
      const filterTenant = tenantId !== undefined;
      const lq = query.toLowerCase();
      const results: ConversationSummary[] = [];
      for (const c of this.convs.values()) {
        if (filterTenant) {
          const cTid = normalizeTenant(c.tenantId);
          if (cTid !== tid) continue;
        }
        const blob = JSON.stringify(c).toLowerCase();
        if (c.title.toLowerCase().includes(lq) || blob.includes(lq)) {
          results.push(this.toSummary(c));
        }
      }
      results.sort((a, b) => b.updatedAt - a.updatedAt);
      return results;
    },

    appendSubagentResult: async (
      conversationId: string,
      result: PendingSubagentResult,
    ): Promise<void> => {
      const conv = this.convs.get(conversationId);
      if (!conv) return;
      conv.pendingSubagentResults = [...(conv.pendingSubagentResults ?? []), result];
      conv.updatedAt = Date.now();
    },

    clearCallbackLock: async (
      conversationId: string,
    ): Promise<Conversation | undefined> => {
      const conv = this.convs.get(conversationId);
      if (!conv) return undefined;
      conv.runningCallbackSince = undefined;
      return conv;
    },
  };

  // -----------------------------------------------------------------------
  // Memory
  // -----------------------------------------------------------------------

  memory = {
    get: async (tenantId?: string | null): Promise<MainMemory> => {
      const tid = normalizeTenant(tenantId);
      return this.mem.get(tid) ?? { content: "", updatedAt: 0 };
    },

    update: async (
      content: string,
      tenantId?: string | null,
    ): Promise<MainMemory> => {
      const tid = normalizeTenant(tenantId);
      const m: MainMemory = { content, updatedAt: Date.now() };
      this.mem.set(tid, m);
      return m;
    },
  };

  // -----------------------------------------------------------------------
  // Todos
  // -----------------------------------------------------------------------

  todos = {
    get: async (conversationId: string): Promise<TodoItem[]> => {
      return this.todoData.get(conversationId) ?? [];
    },

    set: async (conversationId: string, todos: TodoItem[]): Promise<void> => {
      this.todoData.set(conversationId, todos);
    },
  };

  // -----------------------------------------------------------------------
  // Reminders
  // -----------------------------------------------------------------------

  reminders = {
    list: async (tenantId?: string | null): Promise<Reminder[]> => {
      const tid = normalizeTenant(tenantId);
      const filterTenant = tenantId !== undefined;
      const results: Reminder[] = [];
      for (const r of this.reminderData.values()) {
        if (filterTenant) {
          const rTid = normalizeTenant(r.tenantId);
          if (rTid !== tid) continue;
        }
        results.push(r);
      }
      results.sort((a, b) => a.scheduledAt - b.scheduledAt);
      return results;
    },

    create: async (input: {
      task: string;
      scheduledAt: number;
      timezone?: string;
      conversationId: string;
      ownerId?: string;
      tenantId?: string | null;
    }): Promise<Reminder> => {
      const r: Reminder = {
        id: randomUUID(),
        task: input.task,
        scheduledAt: input.scheduledAt,
        timezone: input.timezone,
        status: "pending",
        createdAt: Date.now(),
        conversationId: input.conversationId,
        ownerId: input.ownerId,
        tenantId: input.tenantId,
      };
      this.reminderData.set(r.id, r);
      return r;
    },

    cancel: async (id: string): Promise<Reminder> => {
      const r = this.reminderData.get(id);
      if (!r) throw new Error(`Reminder ${id} not found`);
      r.status = "cancelled";
      return r;
    },

    delete: async (id: string): Promise<void> => {
      this.reminderData.delete(id);
    },
  };

  // -----------------------------------------------------------------------
  // VFS
  // -----------------------------------------------------------------------

  vfs = {
    readFile: async (tenantId: string, path: string): Promise<Uint8Array> => {
      const entry = this.vfsData.get(vfsKey(tenantId, path));
      if (!entry) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      if (entry.type === "directory") throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
      if (entry.type === "symlink") {
        const target = this.resolveSymlink(tenantId, path);
        return this.vfs.readFile(tenantId, target);
      }
      return entry.content ?? new Uint8Array();
    },

    writeFile: async (
      tenantId: string,
      path: string,
      content: Uint8Array,
      mimeType?: string,
    ): Promise<void> => {
      this.ensureParentDirs(tenantId, path);
      const now = Date.now();
      const existing = this.vfsData.get(vfsKey(tenantId, path));
      this.vfsData.set(vfsKey(tenantId, path), {
        type: "file",
        content,
        symlinkTarget: null,
        mimeType: mimeType ?? null,
        size: content.byteLength,
        mode: 0o666,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    },

    appendFile: async (
      tenantId: string,
      path: string,
      content: Uint8Array,
    ): Promise<void> => {
      const existing = this.vfsData.get(vfsKey(tenantId, path));
      if (existing && existing.type === "file" && existing.content) {
        const merged = new Uint8Array(existing.content.byteLength + content.byteLength);
        merged.set(existing.content);
        merged.set(content, existing.content.byteLength);
        await this.vfs.writeFile(tenantId, path, merged);
      } else {
        await this.vfs.writeFile(tenantId, path, content);
      }
    },

    deleteFile: async (tenantId: string, path: string): Promise<void> => {
      const entry = this.vfsData.get(vfsKey(tenantId, path));
      if (!entry) throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
      if (entry.type === "directory") throw new Error(`EISDIR: illegal operation on a directory, unlink '${path}'`);
      this.vfsData.delete(vfsKey(tenantId, path));
    },

    deleteDir: async (
      tenantId: string,
      path: string,
      recursive?: boolean,
    ): Promise<void> => {
      if (recursive) {
        const prefix = vfsKey(tenantId, path);
        for (const key of [...this.vfsData.keys()]) {
          if (key === prefix || key.startsWith(`${prefix}/`.replace(`${tenantId}\0`, `${tenantId}\0`))) {
            // Check actual path prefix
            const entryPath = key.slice(key.indexOf("\0") + 1);
            if (entryPath === path || entryPath.startsWith(`${path}/`)) {
              this.vfsData.delete(key);
            }
          }
        }
      } else {
        const children = await this.vfs.readdir(tenantId, path);
        if (children.length > 0) {
          throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
        }
        this.vfsData.delete(vfsKey(tenantId, path));
      }
    },

    stat: async (tenantId: string, path: string): Promise<VfsStat | undefined> => {
      if (path === "/") {
        return { type: "directory", size: 0, mode: 0o755, createdAt: 0, updatedAt: 0 };
      }
      const entry = this.vfsData.get(vfsKey(tenantId, path));
      if (!entry) return undefined;
      return {
        type: entry.type,
        size: entry.size,
        mode: entry.mode,
        mimeType: entry.mimeType ?? undefined,
        symlinkTarget: entry.symlinkTarget ?? undefined,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    },

    readdir: async (tenantId: string, path: string): Promise<VfsDirEntry[]> => {
      const prefix = path === "/" ? "/" : path;
      const results: VfsDirEntry[] = [];
      for (const [key, entry] of this.vfsData) {
        const entryTenant = key.slice(0, key.indexOf("\0"));
        if (entryTenant !== tenantId) continue;
        const entryPath = key.slice(key.indexOf("\0") + 1);
        const entryParent = parentOf(entryPath);
        if (entryParent === prefix) {
          results.push({
            name: entryPath.slice(entryPath.lastIndexOf("/") + 1),
            type: entry.type,
          });
        }
      }
      return results;
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
          this.mkdirSingle(tenantId, current);
        }
      } else {
        const pp = parentOf(path);
        if (pp !== "/") {
          const parentEntry = this.vfsData.get(vfsKey(tenantId, pp));
          if (!parentEntry) {
            throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
          }
        }
        this.mkdirSingle(tenantId, path);
      }
    },

    rename: async (
      tenantId: string,
      oldPath: string,
      newPath: string,
    ): Promise<void> => {
      this.ensureParentDirs(tenantId, newPath);
      const entry = this.vfsData.get(vfsKey(tenantId, oldPath));
      if (!entry) throw new Error(`ENOENT: no such file or directory, rename '${oldPath}'`);

      // Move the entry
      this.vfsData.delete(vfsKey(tenantId, oldPath));
      this.vfsData.set(vfsKey(tenantId, newPath), { ...entry, updatedAt: Date.now() });

      // Move children (for directories)
      if (entry.type === "directory") {
        const prefix = `${oldPath}/`;
        for (const [key, childEntry] of [...this.vfsData]) {
          const entryTenant = key.slice(0, key.indexOf("\0"));
          if (entryTenant !== tenantId) continue;
          const entryPath = key.slice(key.indexOf("\0") + 1);
          if (entryPath.startsWith(prefix)) {
            const childNewPath = newPath + entryPath.slice(oldPath.length);
            this.vfsData.delete(key);
            this.vfsData.set(vfsKey(tenantId, childNewPath), childEntry);
          }
        }
      }
    },

    chmod: async (tenantId: string, path: string, mode: number): Promise<void> => {
      const entry = this.vfsData.get(vfsKey(tenantId, path));
      if (!entry) throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
      entry.mode = mode;
      entry.updatedAt = Date.now();
    },

    utimes: async (tenantId: string, path: string, mtime: Date): Promise<void> => {
      const entry = this.vfsData.get(vfsKey(tenantId, path));
      if (!entry) throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
      entry.updatedAt = mtime.getTime();
    },

    symlink: async (
      tenantId: string,
      target: string,
      linkPath: string,
    ): Promise<void> => {
      this.ensureParentDirs(tenantId, linkPath);
      const now = Date.now();
      this.vfsData.set(vfsKey(tenantId, linkPath), {
        type: "symlink",
        content: null,
        symlinkTarget: target,
        mimeType: null,
        size: 0,
        mode: 0o777,
        createdAt: now,
        updatedAt: now,
      });
    },

    readlink: async (tenantId: string, path: string): Promise<string> => {
      const entry = this.vfsData.get(vfsKey(tenantId, path));
      if (!entry || entry.type !== "symlink" || !entry.symlinkTarget) {
        throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
      }
      return entry.symlinkTarget;
    },

    lstat: async (tenantId: string, path: string): Promise<VfsStat | undefined> => {
      if (path === "/") {
        return { type: "directory", size: 0, mode: 0o755, createdAt: 0, updatedAt: 0 };
      }
      const entry = this.vfsData.get(vfsKey(tenantId, path));
      if (!entry) return undefined;
      return {
        type: entry.type,
        size: entry.size,
        mode: entry.mode,
        mimeType: entry.mimeType ?? undefined,
        symlinkTarget: entry.symlinkTarget ?? undefined,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
    },

    listAllPaths: (tenantId: string): string[] => {
      const paths: string[] = [];
      for (const key of this.vfsData.keys()) {
        const entryTenant = key.slice(0, key.indexOf("\0"));
        if (entryTenant !== tenantId) continue;
        paths.push(key.slice(key.indexOf("\0") + 1));
      }
      return paths;
    },

    getUsage: async (
      tenantId: string,
    ): Promise<{ fileCount: number; totalBytes: number }> => {
      let fileCount = 0;
      let totalBytes = 0;
      for (const [key, entry] of this.vfsData) {
        const entryTenant = key.slice(0, key.indexOf("\0"));
        if (entryTenant !== tenantId) continue;
        if (entry.type === "file") {
          fileCount++;
          totalBytes += entry.size;
        }
      }
      return { fileCount, totalBytes };
    },
  };

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private toSummary(c: Conversation): ConversationSummary {
    return {
      conversationId: c.conversationId,
      title: c.title,
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
      ownerId: c.ownerId,
      tenantId: c.tenantId,
      messageCount: c.messages.length,
      hasPendingApprovals: (c.pendingApprovals?.length ?? 0) > 0,
      parentConversationId: c.parentConversationId,
      channelMeta: c.channelMeta,
    };
  }

  private ensureParentDirs(tenantId: string, path: string): void {
    const parts = path.split("/").filter(Boolean);
    parts.pop(); // don't create the target itself
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      if (!this.vfsData.has(vfsKey(tenantId, current))) {
        this.mkdirSingle(tenantId, current);
      }
    }
  }

  private mkdirSingle(tenantId: string, path: string): void {
    const key = vfsKey(tenantId, path);
    if (this.vfsData.has(key)) return; // already exists
    const now = Date.now();
    this.vfsData.set(key, {
      type: "directory",
      content: null,
      symlinkTarget: null,
      mimeType: null,
      size: 0,
      mode: 0o755,
      createdAt: now,
      updatedAt: now,
    });
  }

  private resolveSymlink(tenantId: string, path: string, depth = 0): string {
    if (depth > 20) throw new Error(`ELOOP: too many levels of symbolic links, open '${path}'`);
    const entry = this.vfsData.get(vfsKey(tenantId, path));
    if (!entry || entry.type !== "symlink" || !entry.symlinkTarget) return path;
    const target = entry.symlinkTarget.startsWith("/")
      ? entry.symlinkTarget
      : `${parentOf(path)}/${entry.symlinkTarget}`;
    return this.resolveSymlink(tenantId, target, depth + 1);
  }
}
