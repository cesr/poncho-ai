import type {
  Conversation,
  ConversationSummary,
  PendingSubagentResult,
} from "../state.js";
import type { MainMemory } from "../memory.js";
import type { TodoItem } from "../todo-tools.js";
import type { Reminder } from "../reminder-store.js";

// ---------------------------------------------------------------------------
// VFS types
// ---------------------------------------------------------------------------

export interface VfsStat {
  type: "file" | "directory" | "symlink";
  size: number;
  mode: number;
  mimeType?: string;
  symlinkTarget?: string;
  createdAt: number;
  updatedAt: number;
}

export interface VfsDirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

// ---------------------------------------------------------------------------
// StorageEngine – single interface replacing all KV stores
// ---------------------------------------------------------------------------

export interface StorageEngine {
  /** Run migrations and prepare the storage backend. */
  initialize(): Promise<void>;
  /** Gracefully release resources. */
  close(): Promise<void>;

  // --- Conversations (replaces ConversationStore) ---
  conversations: {
    list(ownerId?: string, tenantId?: string | null): Promise<ConversationSummary[]>;
    get(conversationId: string): Promise<Conversation | undefined>;
    create(ownerId?: string, title?: string, tenantId?: string | null): Promise<Conversation>;
    update(conversation: Conversation): Promise<void>;
    rename(conversationId: string, title: string): Promise<Conversation | undefined>;
    delete(conversationId: string): Promise<boolean>;
    search(query: string, tenantId?: string | null): Promise<ConversationSummary[]>;
    appendSubagentResult(
      conversationId: string,
      result: PendingSubagentResult,
    ): Promise<void>;
    clearCallbackLock(conversationId: string): Promise<Conversation | undefined>;
  };

  // --- Memory (replaces MemoryStore) ---
  memory: {
    get(tenantId?: string | null): Promise<MainMemory>;
    update(content: string, tenantId?: string | null): Promise<MainMemory>;
  };

  // --- Todos (replaces TodoStore) ---
  todos: {
    get(conversationId: string): Promise<TodoItem[]>;
    set(conversationId: string, todos: TodoItem[]): Promise<void>;
  };

  // --- Reminders (replaces ReminderStore) ---
  reminders: {
    list(tenantId?: string | null): Promise<Reminder[]>;
    create(input: {
      task: string;
      scheduledAt: number;
      timezone?: string;
      conversationId: string;
      ownerId?: string;
      tenantId?: string | null;
    }): Promise<Reminder>;
    cancel(id: string): Promise<Reminder>;
    delete(id: string): Promise<void>;
  };

  // --- Virtual Filesystem (replaces UploadStore + new VFS) ---
  vfs: {
    readFile(tenantId: string, path: string): Promise<Uint8Array>;
    writeFile(
      tenantId: string,
      path: string,
      content: Uint8Array,
      mimeType?: string,
    ): Promise<void>;
    appendFile(tenantId: string, path: string, content: Uint8Array): Promise<void>;
    deleteFile(tenantId: string, path: string): Promise<void>;
    deleteDir(tenantId: string, path: string, recursive?: boolean): Promise<void>;
    stat(tenantId: string, path: string): Promise<VfsStat | undefined>;
    readdir(tenantId: string, path: string): Promise<VfsDirEntry[]>;
    mkdir(tenantId: string, path: string, recursive?: boolean): Promise<void>;
    rename(tenantId: string, oldPath: string, newPath: string): Promise<void>;
    chmod(tenantId: string, path: string, mode: number): Promise<void>;
    utimes(tenantId: string, path: string, mtime: Date): Promise<void>;
    symlink(tenantId: string, target: string, linkPath: string): Promise<void>;
    readlink(tenantId: string, path: string): Promise<string>;
    lstat(tenantId: string, path: string): Promise<VfsStat | undefined>;
    listAllPaths(tenantId: string): string[];
    getUsage(tenantId: string): Promise<{ fileCount: number; totalBytes: number }>;
  };
}
