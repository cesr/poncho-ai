import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { StateConfig } from "./state.js";
import {
  ensureAgentIdentity,
  getAgentStoreDirectory,
  slugifyStorageComponent,
  STORAGE_SCHEMA_VERSION,
} from "./agent-identity.js";
import { createRawKVStore, type RawKVStore } from "./kv-store.js";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  createdAt: number;
  updatedAt: number;
}

export interface TodoStore {
  get(conversationId: string): Promise<TodoItem[]>;
  set(conversationId: string, todos: TodoItem[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];
const VALID_PRIORITIES: TodoPriority[] = ["high", "medium", "low"];
const TODOS_DIRECTORY = "todos";

const writeJsonAtomic = async (filePath: string, payload: unknown): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmpPath, filePath);
};

const parseTodoList = (raw: unknown): TodoItem[] => {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is TodoItem =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).id === "string" &&
      typeof (item as Record<string, unknown>).content === "string",
  );
};

const generateId = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 8);

// ---------------------------------------------------------------------------
// InMemoryTodoStore
// ---------------------------------------------------------------------------

class InMemoryTodoStore implements TodoStore {
  private readonly store = new Map<string, TodoItem[]>();

  async get(conversationId: string): Promise<TodoItem[]> {
    return this.store.get(conversationId) ?? [];
  }

  async set(conversationId: string, todos: TodoItem[]): Promise<void> {
    this.store.set(conversationId, todos);
  }
}

// ---------------------------------------------------------------------------
// FileTodoStore — one JSON file per conversation
// ---------------------------------------------------------------------------

class FileTodoStore implements TodoStore {
  private readonly workingDir: string;
  private todosDir = "";

  constructor(workingDir: string) {
    this.workingDir = workingDir;
  }

  private async ensureTodosDir(): Promise<string> {
    if (this.todosDir) return this.todosDir;
    const identity = await ensureAgentIdentity(this.workingDir);
    this.todosDir = resolve(getAgentStoreDirectory(identity), TODOS_DIRECTORY);
    await mkdir(this.todosDir, { recursive: true });
    return this.todosDir;
  }

  private async filePath(conversationId: string): Promise<string> {
    const dir = await this.ensureTodosDir();
    return resolve(dir, `${slugifyStorageComponent(conversationId)}.json`);
  }

  async get(conversationId: string): Promise<TodoItem[]> {
    try {
      const fp = await this.filePath(conversationId);
      const raw = await readFile(fp, "utf8");
      return parseTodoList(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  async set(conversationId: string, todos: TodoItem[]): Promise<void> {
    const fp = await this.filePath(conversationId);
    await writeJsonAtomic(fp, todos);
  }
}

// ---------------------------------------------------------------------------
// KVBackedTodoStore — wraps any RawKVStore (Upstash, Redis, DynamoDB)
// ---------------------------------------------------------------------------

class KVBackedTodoStore implements TodoStore {
  private readonly kv: RawKVStore;
  private readonly baseKey: string;
  private readonly ttl?: number;
  private readonly memoryFallback = new InMemoryTodoStore();

  constructor(kv: RawKVStore, baseKey: string, ttl?: number) {
    this.kv = kv;
    this.baseKey = baseKey;
    this.ttl = ttl;
  }

  private keyFor(conversationId: string): string {
    return `${this.baseKey}:${slugifyStorageComponent(conversationId)}`;
  }

  async get(conversationId: string): Promise<TodoItem[]> {
    try {
      const raw = await this.kv.get(this.keyFor(conversationId));
      if (!raw) return [];
      return parseTodoList(JSON.parse(raw));
    } catch {
      return this.memoryFallback.get(conversationId);
    }
  }

  async set(conversationId: string, todos: TodoItem[]): Promise<void> {
    try {
      const serialized = JSON.stringify(todos);
      const key = this.keyFor(conversationId);
      if (typeof this.ttl === "number") {
        await this.kv.setWithTtl(key, serialized, Math.max(1, this.ttl));
      } else {
        await this.kv.set(key, serialized);
      }
    } catch {
      await this.memoryFallback.set(conversationId, todos);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createTodoStore = (
  agentId: string,
  config?: StateConfig,
  options?: { workingDir?: string },
): TodoStore => {
  const provider = config?.provider ?? "local";
  const ttl = config?.ttl;
  const workingDir = options?.workingDir ?? process.cwd();

  if (provider === "local") {
    return new FileTodoStore(workingDir);
  }
  if (provider === "memory") {
    return new InMemoryTodoStore();
  }

  const kv = createRawKVStore(config);
  if (kv) {
    const baseKey = `poncho:${STORAGE_SCHEMA_VERSION}:${slugifyStorageComponent(agentId)}:todos`;
    return new KVBackedTodoStore(kv, baseKey, ttl);
  }
  return new InMemoryTodoStore();
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const createTodoTools = (store: TodoStore): ToolDefinition[] => {
  const resolveKey = (context: { conversationId?: string; runId: string }): string =>
    context.conversationId || context.runId;

  return [
    defineTool({
      name: "todo_list",
      description:
        "List all todo items for the current conversation. " +
        "Use this to check progress and plan next steps.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: VALID_STATUSES,
            description: "Filter by status (omit to list all)",
          },
        },
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const key = resolveKey(context);
        let todos = await store.get(key);
        const status = typeof input.status === "string" ? input.status : undefined;
        if (status && VALID_STATUSES.includes(status as TodoStatus)) {
          todos = todos.filter((t) => t.status === status);
        }
        return { todos, count: todos.length };
      },
    }),

    defineTool({
      name: "todo_add",
      description:
        "Add a new todo item for the current conversation. " +
        "Use proactively for complex multi-step tasks (3+ steps).",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Description of the task",
          },
          status: {
            type: "string",
            enum: VALID_STATUSES,
            description: "Initial status (default: pending)",
          },
          priority: {
            type: "string",
            enum: VALID_PRIORITIES,
            description: "Priority level (default: medium)",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const content = typeof input.content === "string" ? input.content.trim() : "";
        if (!content) throw new Error("content is required");
        const status: TodoStatus =
          typeof input.status === "string" && VALID_STATUSES.includes(input.status as TodoStatus)
            ? (input.status as TodoStatus)
            : "pending";
        const priority: TodoPriority =
          typeof input.priority === "string" && VALID_PRIORITIES.includes(input.priority as TodoPriority)
            ? (input.priority as TodoPriority)
            : "medium";
        const now = Date.now();
        const todo: TodoItem = {
          id: generateId(),
          content,
          status,
          priority,
          createdAt: now,
          updatedAt: now,
        };
        const key = resolveKey(context);
        const todos = await store.get(key);
        todos.push(todo);
        await store.set(key, todos);
        return { todo, todos };
      },
    }),

    defineTool({
      name: "todo_update",
      description:
        "Update an existing todo item's status, content, or priority. " +
        "Mark tasks in_progress when starting and completed when done.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "ID of the todo to update",
          },
          status: {
            type: "string",
            enum: VALID_STATUSES,
            description: "New status",
          },
          content: {
            type: "string",
            description: "New content/description",
          },
          priority: {
            type: "string",
            enum: VALID_PRIORITIES,
            description: "New priority level",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const id = typeof input.id === "string" ? input.id : "";
        if (!id) throw new Error("id is required");
        const key = resolveKey(context);
        const todos = await store.get(key);
        const todo = todos.find((t) => t.id === id);
        if (!todo) throw new Error(`Todo with id "${id}" not found`);

        if (typeof input.status === "string" && VALID_STATUSES.includes(input.status as TodoStatus)) {
          todo.status = input.status as TodoStatus;
        }
        if (typeof input.content === "string" && input.content.trim()) {
          todo.content = input.content.trim();
        }
        if (typeof input.priority === "string" && VALID_PRIORITIES.includes(input.priority as TodoPriority)) {
          todo.priority = input.priority as TodoPriority;
        }
        todo.updatedAt = Date.now();
        await store.set(key, todos);
        return { todo, todos };
      },
    }),

    defineTool({
      name: "todo_remove",
      description: "Remove a todo item by ID.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "ID of the todo to remove",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const id = typeof input.id === "string" ? input.id : "";
        if (!id) throw new Error("id is required");
        const key = resolveKey(context);
        const todos = await store.get(key);
        const index = todos.findIndex((t) => t.id === id);
        if (index === -1) throw new Error(`Todo with id "${id}" not found`);
        const [removed] = todos.splice(index, 1);
        await store.set(key, todos);
        return { removed, todos };
      },
    }),
  ];
};
