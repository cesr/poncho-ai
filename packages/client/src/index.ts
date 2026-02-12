import type { AgentEvent, RunInput, RunResult } from "@agentl/sdk";

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

  async run(input: RunInput): Promise<SyncRunResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/run/sync`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new Error(`Agent request failed: HTTP ${response.status}`);
    }

    return (await response.json()) as SyncRunResponse;
  }

  async continue(input: ContinueInput): Promise<SyncRunResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/continue`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new Error(`Continue request failed: HTTP ${response.status}`);
    }

    return (await response.json()) as SyncRunResponse;
  }

  conversation(initialRunId?: string): {
    send: (message: string, parameters?: Record<string, unknown>) => Promise<SyncRunResponse>;
  } {
    let runId = initialRunId;
    return {
      send: async (message: string, parameters?: Record<string, unknown>) => {
        if (!runId) {
          const initial = await this.run({ task: message, parameters });
          runId = initial.runId;
          return initial;
        }
        const next = await this.continue({ runId, message, parameters });
        runId = next.runId;
        return next;
      },
    };
  }

  async *stream(input: RunInput): AsyncGenerator<AgentEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}/run`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Streaming request failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
        yield payload;
      }
    }
  }
}
