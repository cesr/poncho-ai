import type { AgentEvent, ContentPart, RunInput, RunResult } from "@poncho-ai/sdk";

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

export interface FileAttachment {
  /** base64-encoded file data or a URL */
  data: string;
  mediaType: string;
  filename?: string;
}

export interface ConversationRecord extends Omit<ConversationSummary, "messageCount"> {
  messages: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>;
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
    optionsOrParameters?: {
      parameters?: Record<string, unknown>;
      files?: FileAttachment[];
    } | Record<string, unknown>,
  ): Promise<SyncRunResponse> {
    let currentMessage = message;
    // Backward compat: third arg can be plain parameters Record or new options object
    let parameters: Record<string, unknown> | undefined;
    let files: FileAttachment[] | undefined;
    if (optionsOrParameters && ("parameters" in optionsOrParameters || "files" in optionsOrParameters)) {
      const opts = optionsOrParameters as { parameters?: Record<string, unknown>; files?: FileAttachment[] };
      parameters = opts.parameters;
      files = opts.files;
    } else if (optionsOrParameters) {
      parameters = optionsOrParameters as Record<string, unknown>;
    }
    let totalSteps = 0;
    let stepBudget = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalDuration = 0;
    let latestRunId = "";
    let isFirstRequest = true;

    while (true) {
      const bodyPayload: Record<string, unknown> = { message: currentMessage };
      if (parameters) bodyPayload.parameters = parameters;
      if (files && files.length > 0 && isFirstRequest) bodyPayload.files = files;
      isFirstRequest = false;

      const response = await this.fetchImpl(
        `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(bodyPayload),
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

  async run(input: RunInput & { files?: FileAttachment[] }): Promise<SyncRunResponse> {
    if ((input.messages?.length ?? 0) > 0) {
      throw new Error(
        "run() with pre-seeded messages is no longer supported. Use createConversation/sendMessage.",
      );
    }
    const conversation = await this.createConversation({
      title: input.task,
    });
    return await this.sendMessage(conversation.conversationId, input.task, {
      parameters: input.parameters,
      files: input.files,
    });
  }

  async continue(input: ContinueInput & { files?: FileAttachment[] }): Promise<SyncRunResponse> {
    return await this.sendMessage(input.runId, input.message, {
      parameters: input.parameters,
      files: input.files,
    });
  }

  conversation(initialRunId?: string): {
    send: (
      message: string,
      options?: { parameters?: Record<string, unknown>; files?: FileAttachment[] },
    ) => Promise<SyncRunResponse>;
  } {
    let runId = initialRunId;
    return {
      send: async (
        message: string,
        options?: { parameters?: Record<string, unknown>; files?: FileAttachment[] },
      ) => {
        if (!runId) {
          const initialConversation = await this.createConversation({ title: message });
          const initial = await this.sendMessage(
            initialConversation.conversationId,
            message,
            options,
          );
          runId = initialConversation.conversationId;
          return initial;
        }
        const next = await this.continue({ runId, message, ...options });
        return next;
      },
    };
  }

  async *stream(input: RunInput & { files?: FileAttachment[] }): AsyncGenerator<AgentEvent> {
    if ((input.messages?.length ?? 0) > 0) {
      throw new Error(
        "stream() with pre-seeded messages is no longer supported. Use conversation APIs directly.",
      );
    }
    const conversation = await this.createConversation({ title: input.task });
    let currentMessage = input.task;
    let totalSteps = 0;
    let stepBudget = 0;
    let isFirstRequest = true;

    while (true) {
      const bodyPayload: Record<string, unknown> = {
        message: currentMessage,
        parameters: input.parameters,
      };
      if (input.files && input.files.length > 0 && isFirstRequest) {
        bodyPayload.files = input.files;
      }
      isFirstRequest = false;

      const response = await this.fetchImpl(
        `${this.baseUrl}/api/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(bodyPayload),
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
