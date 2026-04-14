import type { AgentEvent } from "@poncho-ai/sdk";

export interface AgentClientOptions {
  url: string;
  /** Raw API key (PONCHO_AUTH_TOKEN) for builder/admin access. Mutually exclusive with `token`. */
  apiKey?: string;
  /** Tenant JWT for scoped access. Mutually exclusive with `apiKey`. */
  token?: string;
  fetchImpl?: typeof fetch;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "");

export class BaseClient {
  /** @internal */ readonly baseUrl: string;
  private readonly bearerToken?: string;
  /** @internal */ readonly fetchImpl: typeof fetch;

  constructor(options: AgentClientOptions) {
    if (options.apiKey && options.token) {
      throw new Error("AgentClientOptions: apiKey and token are mutually exclusive");
    }
    this.baseUrl = trimTrailingSlash(options.url);
    this.bearerToken = options.apiKey ?? options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** @internal */
  headers(): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
    }
    return headers;
  }

  /** @internal Make a JSON request and parse the response. */
  async json<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...this.headers(), ...options?.headers },
    });
    if (!response.ok) {
      let payload: Record<string, unknown> = {};
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch {}
      const error = new Error(
        (payload.message as string) ?? `Request failed: HTTP ${response.status}`,
      ) as Error & { status: number; payload: Record<string, unknown> };
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    return (await response.text()) as unknown as T;
  }

  /** @internal Build a URL path with optional query parameters. */
  buildUrl(path: string, params?: Record<string, string | undefined>): string {
    if (!params) return path;
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        searchParams.set(key, value);
      }
    }
    const qs = searchParams.toString();
    return qs ? `${path}?${qs}` : path;
  }

  /** @internal Parse an SSE response body into an array of AgentEvents. */
  async parseSse(response: Response): Promise<AgentEvent[]> {
    if (!response.body) {
      throw new Error("Missing response body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: AgentEvent[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const lines = frame
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const dataLine = lines.find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const payload = JSON.parse(dataLine.slice("data:".length).trim()) as AgentEvent;
        events.push(payload);
      }
    }
    return events;
  }

  /** @internal Read an SSE response body as an async generator of AgentEvents. */
  async *readSseStream(response: Response): AsyncGenerator<AgentEvent> {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

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
        if (!eventType || !dataLine) continue;

        const payload = JSON.parse(dataLine.slice("data:".length).trim()) as AgentEvent;
        yield payload;
      }
    }
  }
}
