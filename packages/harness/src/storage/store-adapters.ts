// ---------------------------------------------------------------------------
// Thin adapters that wrap StorageEngine namespaces into the existing
// ConversationStore / MemoryStore / TodoStore / ReminderStore interfaces.
// This keeps backward compatibility while routing through the new engine.
// ---------------------------------------------------------------------------

import type {
  Conversation,
  ConversationCreateInit,
  ConversationStore,
  ConversationSummary,
  PendingSubagentResult,
} from "../state.js";
import type { MainMemory, MemoryStore } from "../memory.js";
import type { TodoItem, TodoStore } from "../todo-tools.js";
import type { Reminder, ReminderCreateInput, ReminderStatus, ReminderStore } from "../reminder-store.js";
import type { StorageEngine } from "./engine.js";

// ---------------------------------------------------------------------------
// ConversationStore adapter
// ---------------------------------------------------------------------------

export function createConversationStoreFromEngine(
  engine: StorageEngine,
): ConversationStore {
  return {
    list: (ownerId?: string, tenantId?: string | null) =>
      engine.conversations.list(ownerId, tenantId).then((summaries) => {
        // list() returns full Conversation[] in the old interface.
        // For backward compat, fetch full conversations.
        return Promise.all(
          summaries.map((s) => engine.conversations.get(s.conversationId)),
        ).then((convs) => convs.filter(Boolean) as Conversation[]);
      }),
    listSummaries: (ownerId?: string, tenantId?: string | null) =>
      engine.conversations.list(ownerId, tenantId),
    get: (conversationId: string) =>
      engine.conversations.get(conversationId),
    getWithArchive: (conversationId: string) =>
      engine.conversations.getWithArchive(conversationId),
    getStatusSnapshot: (conversationId: string) =>
      engine.conversations.getStatusSnapshot(conversationId),
    create: (
      ownerId?: string,
      title?: string,
      tenantId?: string | null,
      init?: ConversationCreateInit,
    ) => engine.conversations.create(ownerId, title, tenantId, init),
    update: (conversation: Conversation) =>
      engine.conversations.update(conversation),
    rename: (conversationId: string, title: string) =>
      engine.conversations.rename(conversationId, title),
    delete: (conversationId: string) =>
      engine.conversations.delete(conversationId),
    appendSubagentResult: (conversationId: string, result: PendingSubagentResult) =>
      engine.conversations.appendSubagentResult(conversationId, result),
    clearCallbackLock: (conversationId: string) =>
      engine.conversations.clearCallbackLock(conversationId),
  };
}

// ---------------------------------------------------------------------------
// MemoryStore adapter
// ---------------------------------------------------------------------------

export function createMemoryStoreFromEngine(
  engine: StorageEngine,
  tenantId?: string | null,
): MemoryStore {
  return {
    getMainMemory: () => engine.memory.get(tenantId),
    updateMainMemory: (input: { content: string }) =>
      engine.memory.update(input.content, tenantId),
  };
}

// ---------------------------------------------------------------------------
// TodoStore adapter
// ---------------------------------------------------------------------------

export function createTodoStoreFromEngine(engine: StorageEngine): TodoStore {
  return {
    get: (conversationId: string) => engine.todos.get(conversationId),
    set: (conversationId: string, todos: TodoItem[]) =>
      engine.todos.set(conversationId, todos),
  };
}

// ---------------------------------------------------------------------------
// ReminderStore adapter
// ---------------------------------------------------------------------------

export function createReminderStoreFromEngine(
  engine: StorageEngine,
): ReminderStore {
  return {
    list: () => engine.reminders.list(),
    create: (input: ReminderCreateInput) => engine.reminders.create(input),
    update: (id: string, fields: { scheduledAt?: number; occurrenceCount?: number; status?: ReminderStatus }) =>
      engine.reminders.update(id, fields),
    cancel: (id: string) => engine.reminders.cancel(id),
    delete: (id: string) => engine.reminders.delete(id),
  };
}
