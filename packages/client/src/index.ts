import type { AgentEvent, RunInput, RunResult } from "@poncho-ai/sdk";

export interface AgentClientOptions {
  url: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface SyncRunResponse {
  runId: string;
  status: RunResult["status"];
  result: RunResult;
}

export interface ContinueInput {
  runId: string;
  message: string;
  parameters?: Record<string, unknown>;
}

export interface ConversationSummary {
  conversationId: string;
  title: string;
  runtimeRunId?: string;
  ownerId: string;
  tenantId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ConversationRecord extends Omit<ConversationSummary, "messageCount"> {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export class AgentClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentClientOptions) {
    this.baseUrl = trimTrailingSlash(options.url);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private async parseSse(response: Response): Promise<AgentEvent[]> {
    if (!response.body) {
      throw new Error("Missing response body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: AgentEvent[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const lines = frame
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const dataLine = lines.find((line) => line.startsWith("data:"));
        if (!dataLine) {
          continue;
        }
        const payload = JSON.parse(dataLine.slice("data:".length).trim()) as AgentEvent;
        events.push(payload);
      }
    }
    return events;
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/conversations`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(`List conversations failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { conversations: ConversationSummary[] };
    return payload.conversations;
  }

  async createConversation(input?: { title?: string }): Promise<ConversationRecord> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/conversations`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input ?? {}),
    });
    if (!response.ok) {
      throw new Error(`Create conversation failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { conversation: ConversationRecord };
    return payload.conversation;
  }

  async getConversation(conversationId: string): Promise<ConversationRecord> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`,
      {
        method: "GET",
        headers: this.headers(),
      },
    );
    if (!response.ok) {
      throw new Error(`Get conversation failed: HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { conversation: ConversationRecord };
    return payload.conversation;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`,
      {
        method: "DELETE",
        headers: this.headers(),
      },
    );
    if (!response.ok) {
      throw new Error(`Delete conversation failed: HTTP ${response.status}`);
    }
  }

  async sendMessage(
    conversationId: string,
    message: string,
    parameters?: Record<string, unknown>,
  ): Promise<SyncRunResponse> {
    let currentMessage = message;
    let totalSteps = 0;
    let stepBudget = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalDuration = 0;
    let latestRunId = "";

    while (true) {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ message: currentMessage, parameters }),
        },
      );
      if (!response.ok) {
        throw new Error(`Send message failed: HTTP ${response.status}`);
      }
      const events = await this.parseSse(response);
      const runStarted = events.find(
        (event): event is Extract<AgentEvent, { type: "run:started" }> =>
          event.type === "run:started",
      );
      if (runStarted) {
        latestRunId = runStarted.runId;
      }
      const completed = events.find(
        (event): event is Extract<AgentEvent, { type: "run:completed" }> =>
          event.type === "run:completed",
      );
      if (completed) {
        totalSteps += completed.result.steps;
        totalInputTokens += completed.result.tokens.input;
        totalOutputTokens += completed.result.tokens.output;
        totalDuration += completed.result.duration;
        if (typeof completed.result.maxSteps === "number") stepBudget = completed.result.maxSteps;

        if (completed.result.continuation && (stepBudget <= 0 || totalSteps < stepBudget)) {
          currentMessage = "Continue";
          continue;
        }
        return {
          runId: latestRunId || completed.runId,
          status: completed.result.status,
          result: {
            ...completed.result,
            steps: totalSteps,
            tokens: { input: totalInputTokens, output: totalOutputTokens, cached: 0 },
            duration: totalDuration,
          },
        };
      }
      const cancelled = events.find(
        (event): event is Extract<AgentEvent, { type: "run:cancelled" }> =>
          event.type === "run:cancelled",
      );
      if (cancelled) {
        return {
          runId: latestRunId || cancelled.runId,
          status: "cancelled",
          result: {
            status: "cancelled",
            steps: totalSteps,
            tokens: { input: totalInputTokens, output: totalOutputTokens, cached: 0 },
            duration: totalDuration,
          },
        };
      }
      throw new Error("Send message failed: missing run:completed or run:cancelled event");
    }
  }

  async run(input: RunInput): Promise<SyncRunResponse> {
    if ((input.messages?.length ?? 0) > 0) {
      throw new Error(
        "run() with pre-seeded messages is no longer supported. Use createConversation/sendMessage.",
      );
    }
    const conversation = await this.createConversation({
      title: input.task,
    });
    return await this.sendMessage(conversation.conversationId, input.task, input.parameters);
  }

  async continue(input: ContinueInput): Promise<SyncRunResponse> {
    return await this.sendMessage(input.runId, input.message, input.parameters);
  }

  conversation(initialRunId?: string): {
    send: (message: string, parameters?: Record<string, unknown>) => Promise<SyncRunResponse>;
  } {
    let runId = initialRunId;
    return {
      send: async (message: string, parameters?: Record<string, unknown>) => {
        if (!runId) {
          const initialConversation = await this.createConversation({ title: message });
          const initial = await this.sendMessage(
            initialConversation.conversationId,
            message,
            parameters,
          );
          runId = initialConversation.conversationId;
          return initial;
        }
        const next = await this.continue({ runId, message, parameters });
        return next;
      },
    };
  }

  async *stream(input: RunInput): AsyncGenerator<AgentEvent> {
    if ((input.messages?.length ?? 0) > 0) {
      throw new Error(
        "stream() with pre-seeded messages is no longer supported. Use conversation APIs directly.",
      );
    }
    const conversation = await this.createConversation({ title: input.task });
    let currentMessage = input.task;
    let totalSteps = 0;
    let stepBudget = 0;

    while (true) {
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ message: currentMessage, parameters: input.parameters }),
        },
      );

      if (!response.ok || !response.body) {
        throw new Error(`Streaming request failed: HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let shouldContinue = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const lines = frame
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);

          const eventType = lines.find((line) => line.startsWith("event:"));
          const dataLine = lines.find((line) => line.startsWith("data:"));
          if (!eventType || !dataLine) {
            continue;
          }

          const payload = JSON.parse(dataLine.slice("data:".length).trim()) as AgentEvent;
          if (payload.type === "run:completed") {
            totalSteps += payload.result.steps;
            if (typeof payload.result.maxSteps === "number") stepBudget = payload.result.maxSteps;
            if (payload.result.continuation && (stepBudget <= 0 || totalSteps < stepBudget)) {
              shouldContinue = true;
            }
          }
          yield payload;
        }
      }

      if (!shouldContinue) break;
      currentMessage = "Continue";
    }
  }
}
