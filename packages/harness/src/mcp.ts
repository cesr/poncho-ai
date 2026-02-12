import type { ToolDefinition } from "@agentl/sdk";
import { WebSocket } from "ws";

export interface RemoteMcpServerConfig {
  name?: string;
  url: string;
  env?: string[];
  timeoutMs?: number;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
}

export interface McpConfig {
  mcp?: RemoteMcpServerConfig[];
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpRpcClient {
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

class WebSocketMcpRpcClient implements McpRpcClient {
  private ws?: WebSocket;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly reconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private idCounter = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private opened = false;

  constructor(
    url: string,
    timeoutMs = 10_000,
    reconnectAttempts = 3,
    reconnectDelayMs = 500,
  ) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.reconnectAttempts = reconnectAttempts;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  private attachHandlers(ws: WebSocket): void {
    ws.on("open", () => {
      this.opened = true;
    });
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(String(data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof message.id !== "number") {
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message ?? "MCP RPC error"));
        } else {
          pending.resolve(message.result);
        }
      } catch {
        // Ignore invalid messages.
      }
    });
    ws.on("close", () => {
      this.opened = false;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("MCP websocket closed"));
      }
      this.pending.clear();
    });
  }

  private async openSocket(): Promise<void> {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.attachHandlers(ws);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        rejectPromise(new Error("MCP websocket open timeout"));
      }, this.timeoutMs);
      ws.once("open", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
      ws.once("error", (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      });
    });
  }

  private async waitUntilOpen(): Promise<void> {
    if (this.opened && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.reconnectAttempts; attempt += 1) {
      try {
        await this.openSocket();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, this.reconnectDelayMs * attempt),
        );
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Unable to connect to remote MCP websocket");
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.waitUntilOpen();
    const id = this.idCounter++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    });
    const resultPromise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`MCP websocket timeout for method ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    });
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("MCP websocket is not connected");
    }
    socket.send(payload);
    return await resultPromise;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request("tools/list")) as { tools?: McpToolDescriptor[] } | unknown;
    const value = (result as { tools?: McpToolDescriptor[] })?.tools;
    return Array.isArray(value) ? value : [];
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const result = (await this.request("tools/call", { name, arguments: input })) as {
      content?: unknown;
      result?: unknown;
    };
    return result?.result ?? result?.content ?? result;
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.ws = undefined;
    this.opened = false;
  }
}

export class LocalMcpBridge {
  private readonly remoteServers: RemoteMcpServerConfig[];
  private readonly rpcClients = new Map<string, McpRpcClient>();

  constructor(config: McpConfig | undefined) {
    this.remoteServers = (config?.mcp ?? []).filter((entry): entry is RemoteMcpServerConfig =>
      typeof entry.url === "string",
    );
  }

  async loadTools(): Promise<ToolDefinition[]> {
    const tools: ToolDefinition[] = [];
    for (const remoteServer of this.remoteServers) {
      const name = remoteServer.name ?? remoteServer.url;
      const client = this.rpcClients.get(name);
      if (!client) {
        continue;
      }
      try {
        const discovered = await client.listTools();
        tools.push(...this.toToolDefinitions(name, discovered, client));
      } catch {
        // Ignore server discovery failures and continue boot.
      }
    }
    return tools;
  }

  async startLocalServers(): Promise<void> {
    for (const server of this.remoteServers) {
      const name = server.name ?? server.url;
      this.rpcClients.set(
        name,
        new WebSocketMcpRpcClient(
          server.url,
          server.timeoutMs ?? 10_000,
          server.reconnectAttempts ?? 3,
          server.reconnectDelayMs ?? 500,
        ),
      );
    }
  }

  async stopLocalServers(): Promise<void> {
    for (const [, client] of this.rpcClients) {
      await client.close();
    }
    this.rpcClients.clear();
  }

  listServers(): RemoteMcpServerConfig[] {
    return [...this.remoteServers];
  }

  listRemoteServers(): RemoteMcpServerConfig[] {
    return this.remoteServers;
  }

  async checkRemoteConnectivity(): Promise<
    Array<{ url: string; ok: boolean; error?: string }>
  > {
    const checks: Array<{ url: string; ok: boolean; error?: string }> = [];
    for (const remote of this.remoteServers) {
      try {
        if (remote.url.startsWith("http://") || remote.url.startsWith("https://")) {
          const response = await fetch(remote.url, { method: "HEAD" });
          checks.push({ url: remote.url, ok: response.ok });
        } else {
          checks.push({ url: remote.url, ok: true });
        }
      } catch (error) {
        checks.push({
          url: remote.url,
          ok: false,
          error: error instanceof Error ? error.message : "Unknown connectivity error",
        });
      }
    }
    return checks;
  }

  toSerializableConfig(): McpConfig {
    return { mcp: [...this.remoteServers] };
  }

  getLocalServers(): never[] {
    return [];
  }

  private toToolDefinitions(
    serverName: string,
    tools: McpToolDescriptor[],
    client: McpRpcClient,
  ): ToolDefinition[] {
    return tools.map((tool) => ({
      name: `${serverName}:${tool.name}`,
      description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
      inputSchema:
        (tool.inputSchema as ToolDefinition["inputSchema"]) ?? {
          type: "object",
          properties: {},
        },
      handler: async (input) => await client.callTool(tool.name, input),
    }));
  }
}
