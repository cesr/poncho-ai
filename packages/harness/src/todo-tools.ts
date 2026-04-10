import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";

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
// Factory
// ---------------------------------------------------------------------------

export const createTodoStore = (): TodoStore => {
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
