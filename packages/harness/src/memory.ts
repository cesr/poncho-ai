import { defineTool, type ToolContext, type ToolDefinition } from "@poncho-ai/sdk";
import type { StateProviderName } from "./state.js";

export interface MainMemory {
  content: string;
  updatedAt: number;
}

export interface MemoryConfig {
  enabled?: boolean;
  provider?: StateProviderName;
  urlEnv?: string;
  tokenEnv?: string;
  table?: string;
  region?: string;
  ttl?: number;
  maxRecallConversations?: number;
}

export interface MemoryStore {
  getMainMemory(): Promise<MainMemory>;
  updateMainMemory(input: { content: string }): Promise<MainMemory>;
}

type RecallItem = {
  conversationId: string;
  title: string;
  updatedAt: number;
  content: string;
};

type ConversationListItem = {
  conversationId: string;
  title: string;
  createdAt?: number;
  updatedAt: number;
  messageCount?: number;
};

type ConversationDetail = {
  conversationId: string;
  title: string;
  createdAt?: number;
  updatedAt: number;
  messages: Array<{ role: string; content: string }>;
};


const DEFAULT_MAIN_MEMORY: MainMemory = {
  content: "",
  updatedAt: 0,
};

const scoreText = (text: string, query: string): number => {
  const normalized = query.trim().toLowerCase();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return 0;
  }
  const haystack = text.toLowerCase();
  let score = haystack.includes(normalized) ? 5 : 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
};

class InMemoryMemoryStore implements MemoryStore {
  private mainMemory: MainMemory = { ...DEFAULT_MAIN_MEMORY };
  private readonly ttlMs?: number;

  constructor(ttlSeconds?: number) {
    this.ttlMs = typeof ttlSeconds === "number" ? ttlSeconds * 1000 : undefined;
  }

  private isExpired(updatedAt: number): boolean {
    return typeof this.ttlMs === "number" && Date.now() - updatedAt > this.ttlMs;
  }

  async getMainMemory(): Promise<MainMemory> {
    if (this.mainMemory.updatedAt > 0 && this.isExpired(this.mainMemory.updatedAt)) {
      this.mainMemory = { ...DEFAULT_MAIN_MEMORY };
    }
    return this.mainMemory;
  }

  async updateMainMemory(input: { content: string }): Promise<MainMemory> {
    this.mainMemory = {
      content: input.content.trim(),
      updatedAt: Date.now(),
    };
    return this.mainMemory;
  }
}

export const createMemoryStore = (
  agentId: string,
  config?: MemoryConfig,
  options?: { workingDir?: string; tenantId?: string },
): MemoryStore => {
  const ttl = config?.ttl;
  return new InMemoryMemoryStore(ttl);
};

const asRecallCorpus = (raw: unknown): RecallItem[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const record = item as Record<string, unknown>;
      const conversationId =
        typeof record.conversationId === "string" ? record.conversationId : "";
      const title = typeof record.title === "string" ? record.title : "Conversation";
      const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
      const content = typeof record.content === "string" ? record.content : "";
      if (!conversationId || !content) {
        return undefined;
      }
      return { conversationId, title, updatedAt, content } satisfies RecallItem;
    })
    .filter((item): item is RecallItem => Boolean(item));
};

const buildRecallSnippet = (content: string, query: string, maxChars = 360): string => {
  const normalized = query.trim().toLowerCase();
  const index = content.toLowerCase().indexOf(normalized);
  if (index === -1) {
    return content.slice(0, maxChars);
  }
  const start = Math.max(0, index - 120);
  const end = Math.min(content.length, index + normalized.length + 180);
  return content.slice(start, end);
};

export const createMemoryTools = (
  store: MemoryStore | ((context: ToolContext) => MemoryStore),
  options?: { maxRecallConversations?: number },
): ToolDefinition[] => {
  const resolveStore = typeof store === "function"
    ? store
    : () => store;
  const maxRecallConversations = Math.max(1, options?.maxRecallConversations ?? 20);
  return [
    defineTool({
      name: "memory_main_get",
      description: "Get the current persistent main memory document.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async (_input, context) => {
        const memory = await resolveStore(context).getMainMemory();
        return { memory };
      },
    }),
    defineTool({
      name: "memory_main_write",
      description:
        "Overwrite the entire persistent main memory document. " +
        "Use for initial writes or full rewrites. " +
        "Prefer memory_main_edit for targeted changes to existing memory.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The full memory content to write",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const content = typeof input.content === "string" ? input.content.trim() : "";
        if (!content) {
          throw new Error("content is required");
        }
        const memory = await resolveStore(context).updateMainMemory({ content });
        return { ok: true, memory };
      },
    }),
    defineTool({
      name: "memory_main_edit",
      description:
        "Edit persistent main memory by replacing an exact string match with new content. " +
        "The old_str must match exactly one location in memory. " +
        "Use an empty new_str to delete matched content. " +
        "Proactively evaluate every turn whether memory should be updated.",
      inputSchema: {
        type: "object",
        properties: {
          old_str: {
            type: "string",
            description:
              "The exact text to find and replace (must be unique in memory). " +
              "Include surrounding context if needed to ensure uniqueness.",
          },
          new_str: {
            type: "string",
            description: "The replacement text (use empty string to delete the matched content)",
          },
        },
        required: ["old_str", "new_str"],
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const oldStr = typeof input.old_str === "string" ? input.old_str : "";
        const newStr = typeof input.new_str === "string" ? input.new_str : "";
        if (!oldStr) {
          throw new Error("old_str must not be empty.");
        }
        const current = await resolveStore(context).getMainMemory();
        const content = current.content;
        const first = content.indexOf(oldStr);
        if (first === -1) {
          throw new Error(
            "old_str not found in memory. Make sure it matches exactly, including whitespace and line breaks.",
          );
        }
        const last = content.lastIndexOf(oldStr);
        if (first !== last) {
          throw new Error(
            "old_str appears multiple times in memory. Please provide more context to ensure a unique match.",
          );
        }
        const newContent = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
        const memory = await resolveStore(context).updateMainMemory({ content: newContent });
        return { ok: true, memory };
      },
    }),
    defineTool({
      name: "conversation_recall",
      description:
        "Recall past conversations. Three modes:\n" +
        "- Search: provide 'query' to keyword-search past conversations for relevant snippets.\n" +
        "- List: provide 'after' and/or 'before' dates to browse conversations by date range.\n" +
        "- Fetch: provide 'conversationId' to load the full message history of a specific conversation.\n" +
        "Modes can be combined (e.g. query + date range to search within a time window).",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword search query for past conversations",
          },
          after: {
            type: "string",
            description:
              "ISO 8601 date string. Only return conversations updated after this date (e.g. '2025-03-01').",
          },
          before: {
            type: "string",
            description:
              "ISO 8601 date string. Only return conversations updated before this date.",
          },
          conversationId: {
            type: "string",
            description: "Fetch the full message history of a specific conversation by ID",
          },
          lastN: {
            type: "number",
            description: "When fetching a conversation, only return the last N messages (max 50)",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default 20 for list, 3 for search, max 50)",
          },
        },
        additionalProperties: false,
      },
      handler: async (input, context) => {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        const after = typeof input.after === "string" ? input.after : "";
        const before = typeof input.before === "string" ? input.before : "";
        const fetchId = typeof input.conversationId === "string" ? input.conversationId.trim() : "";
        const hasDateFilter = after !== "" || before !== "";

        // Determine mode
        const mode = fetchId ? "fetch" : (query && !hasDateFilter) ? "search" : "list";

        // --- Fetch mode: load full conversation by ID ---
        if (mode === "fetch") {
          const rawFetchFn = context.parameters.__conversationFetchFn;
          if (typeof rawFetchFn !== "function") {
            throw new Error("Conversation fetching is not available in this environment.");
          }
          const conversation = (await (rawFetchFn as (id: string) => Promise<unknown>)(fetchId)) as
            | ConversationDetail
            | undefined;
          if (!conversation) {
            throw new Error(`Conversation '${fetchId}' not found.`);
          }
          const lastN = typeof input.lastN === "number" ? Math.max(1, Math.min(50, input.lastN)) : undefined;
          const messages = lastN
            ? conversation.messages.slice(-lastN)
            : conversation.messages.slice(-50);
          return {
            mode: "fetch",
            conversationId: conversation.conversationId,
            title: conversation.title,
            createdAt: conversation.createdAt
              ? new Date(conversation.createdAt).toISOString()
              : undefined,
            updatedAt: new Date(conversation.updatedAt).toISOString(),
            messageCount: conversation.messages.length,
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content.slice(0, 4000),
            })),
          };
        }

        // --- List mode: browse by date, optionally with keyword filtering ---
        if (mode === "list") {
          const rawListFn = context.parameters.__conversationListFn;
          if (typeof rawListFn !== "function") {
            throw new Error("Conversation listing is not available in this environment.");
          }
          const allConversations = (await (rawListFn as () => Promise<unknown>)()) as ConversationListItem[];
          const limit = Math.max(1, Math.min(50, typeof input.limit === "number" ? input.limit : 20));
          const afterMs = after ? new Date(after).getTime() : 0;
          const beforeMs = before ? new Date(before).getTime() : Infinity;

          let filtered = allConversations.filter((item) => {
            const ts = item.updatedAt;
            return ts >= afterMs && ts <= beforeMs;
          });

          // If query is also provided, score and rank by relevance
          if (query) {
            filtered = filtered
              .map((item) => ({
                ...item,
                _score: scoreText(item.title, query),
              }))
              .filter((item) => item._score > 0)
              .sort((a, b) => {
                if (b._score === a._score) return b.updatedAt - a.updatedAt;
                return b._score - a._score;
              });
          }

          return {
            mode: "list",
            conversations: filtered.slice(0, limit).map((item) => ({
              conversationId: item.conversationId,
              title: item.title,
              createdAt: item.createdAt
                ? new Date(item.createdAt).toISOString()
                : undefined,
              updatedAt: new Date(item.updatedAt).toISOString(),
              messageCount: item.messageCount,
            })),
          };
        }

        // --- Search mode: keyword search across conversation content ---
        const limit = Math.max(
          1,
          Math.min(10, typeof input.limit === "number" ? input.limit : 3),
        );
        const rawCorpus = context.parameters.__conversationRecallCorpus;
        const resolvedCorpus =
          typeof rawCorpus === "function" ? await (rawCorpus as () => Promise<unknown>)() : rawCorpus;
        const corpus = asRecallCorpus(resolvedCorpus).slice(0, maxRecallConversations);
        const results = corpus
          .map((item) => ({
            ...item,
            score: scoreText(`${item.title}\n${item.content}`, query),
          }))
          .filter((item) => item.score > 0)
          .sort((a, b) => {
            if (b.score === a.score) return b.updatedAt - a.updatedAt;
            return b.score - a.score;
          })
          .slice(0, limit)
          .map((item) => ({
            conversationId: item.conversationId,
            title: item.title,
            updatedAt: item.updatedAt,
            snippet: buildRecallSnippet(item.content, query),
          }));
        return { mode: "search", results };
      },
    }),
  ];
};
