import type { ToolDefinition } from "@poncho-ai/sdk";
import {
  applyToolPolicy,
  matchesSlashPattern,
  mergePolicyForEnvironment,
  type RuntimeEnvironment,
  type ToolPatternPolicy,
  validateMcpPattern,
  validateMcpToolPattern,
} from "./tool-policy.js";

export interface RemoteMcpServerConfig {
  name?: string;
  url: string;
  env?: string[];
  auth?: {
    type: "bearer";
    tokenEnv?: string;
  };
  tools?: ToolPatternPolicy;
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

class McpHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class StreamableHttpMcpRpcClient implements McpRpcClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly bearerToken?: string;
  private idCounter = 1;
  private initialized = false;
  private sessionId?: string;

  constructor(endpoint: string, timeoutMs = 10_000, bearerToken?: string) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.bearerToken = bearerToken;
  }

  private buildHeaders(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: accept,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    if (this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
    }
    return headers;
  }

  private captureSessionId(response: Response): void {
    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId && sessionId.trim().length > 0) {
      this.sessionId = sessionId;
    }
  }

  private async postMessage(message: unknown): Promise<unknown[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.buildHeaders("application/json, text/event-stream"),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      this.captureSessionId(response);
      if (response.status === 401) {
        throw new McpHttpError(401, "MCP server unauthorized");
      }
      if (response.status === 403) {
        throw new McpHttpError(403, "MCP server forbidden");
      }
      if (!response.ok) {
        throw new Error(`MCP HTTP request failed with status ${response.status}`);
      }
      if (response.status === 202) {
        return [];
      }
      const contentType = response.headers.get("content-type") ?? "";
      const contentLength = response.headers.get("content-length");
      if (contentLength === "0") {
        return [];
      }
      if (contentType.includes("text/event-stream")) {
        return await this.parseSseMessages(response);
      }
      if (!contentType.includes("application/json")) {
        const body = await response.text();
        if (body.trim().length === 0) {
          return [];
        }
      }
      const payload = (await response.json()) as unknown;
      if (Array.isArray(payload)) {
        return payload;
      }
      return [payload];
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseSseMessages(response: Response): Promise<unknown[]> {
    const text = await response.text();
    const lines = text.split(/\r?\n/);
    const payloads: unknown[] = [];
    let eventData: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        eventData.push(line.slice(5).trim());
        continue;
      }
      if (line.trim() !== "") {
        continue;
      }
      if (eventData.length === 0) {
        continue;
      }
      const joined = eventData.join("\n");
      eventData = [];
      try {
        payloads.push(JSON.parse(joined) as unknown);
      } catch {
        // Ignore malformed data chunks.
      }
    }
    if (eventData.length > 0) {
      const joined = eventData.join("\n");
      try {
        payloads.push(JSON.parse(joined) as unknown);
      } catch {
        // Ignore trailing malformed chunk.
      }
    }
    return payloads;
  }

  private extractResult(
    payloads: unknown[],
    id: number,
  ): { result?: unknown; error?: { message?: string } } {
    for (const payload of payloads) {
      if (!payload || typeof payload !== "object") {
        continue;
      }
      const obj = payload as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };
      if (obj.id === id) {
        return { result: obj.result, error: obj.error };
      }
    }
    throw new Error(`MCP response missing JSON-RPC payload for id ${id}`);
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const id = this.idCounter++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };
    const payloads = await this.postMessage(payload);
    const result = this.extractResult(payloads, id);
    if (result.error) {
      throw new Error(result.error.message ?? `MCP error on ${method}`);
    }
    return result.result;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const id = this.idCounter++;
    const payloads = await this.postMessage({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: "poncho", version: "0.1.0" },
      },
    });
    const result = this.extractResult(payloads, id);
    if (result.error) {
      throw new Error(result.error.message ?? "MCP initialize failed");
    }
    await this.postMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    this.initialized = true;
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
    if (!this.sessionId) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await fetch(this.endpoint, {
        method: "DELETE",
        headers: this.buildHeaders("application/json"),
        signal: controller.signal,
      });
    } catch {
      // Best-effort session cleanup.
    } finally {
      clearTimeout(timer);
      this.sessionId = undefined;
      this.initialized = false;
    }
  }
}

export class LocalMcpBridge {
  private readonly remoteServers: RemoteMcpServerConfig[];
  private readonly rpcClients = new Map<string, McpRpcClient>();
  private readonly toolCatalog = new Map<string, McpToolDescriptor[]>();
  private readonly unavailableServers = new Map<string, string>();
  private readonly authFailedServers = new Set<string>();

  constructor(config: McpConfig | undefined) {
    this.remoteServers = (config?.mcp ?? []).filter((entry): entry is RemoteMcpServerConfig =>
      typeof entry.url === "string",
    );
    const seen = new Set<string>();
    for (const server of this.remoteServers) {
      const name = this.getServerName(server);
      if (seen.has(name)) {
        throw new Error(`Duplicate MCP server name: "${name}"`);
      }
      seen.add(name);
      if (server.url.startsWith("ws://") || server.url.startsWith("wss://")) {
        throw new Error(
          `Unsupported MCP URL for "${name}": ${server.url}. Use http:// or https:// endpoints.`,
        );
      }
      if (!server.url.startsWith("http://") && !server.url.startsWith("https://")) {
        throw new Error(
          `Invalid MCP URL for "${name}": ${server.url}. Expected http:// or https://.`,
        );
      }
      if (server.auth?.type === "bearer" && (!server.auth.tokenEnv || !server.auth.tokenEnv.trim())) {
        throw new Error(
          `Invalid MCP auth config for "${name}": auth.type "bearer" requires auth.tokenEnv.`,
        );
      }
      this.validatePolicy(server, name);
    }
  }

  private validatePolicy(server: RemoteMcpServerConfig, serverName: string): void {
    const policy = server.tools;
    const validateList = (values: string[] | undefined, path: string): void => {
      for (const [index, value] of (values ?? []).entries()) {
        validateMcpToolPattern(value, `${path}[${index}]`);
      }
    };
    validateList(policy?.include, `mcp.${serverName}.tools.include`);
    validateList(policy?.exclude, `mcp.${serverName}.tools.exclude`);
    validateList(
      policy?.byEnvironment?.development?.include,
      `mcp.${serverName}.tools.byEnvironment.development.include`,
    );
    validateList(
      policy?.byEnvironment?.development?.exclude,
      `mcp.${serverName}.tools.byEnvironment.development.exclude`,
    );
    validateList(
      policy?.byEnvironment?.staging?.include,
      `mcp.${serverName}.tools.byEnvironment.staging.include`,
    );
    validateList(
      policy?.byEnvironment?.staging?.exclude,
      `mcp.${serverName}.tools.byEnvironment.staging.exclude`,
    );
    validateList(
      policy?.byEnvironment?.production?.include,
      `mcp.${serverName}.tools.byEnvironment.production.include`,
    );
    validateList(
      policy?.byEnvironment?.production?.exclude,
      `mcp.${serverName}.tools.byEnvironment.production.exclude`,
    );
  }

  private getServerName(server: RemoteMcpServerConfig): string {
    return server.name ?? server.url;
  }

  private log(level: "info" | "warn", event: string, payload: Record<string, unknown>): void {
    const line = JSON.stringify({ event, ...payload });
    if (level === "warn") {
      console.warn(`[poncho][mcp] ${line}`);
      return;
    }
    console.info(`[poncho][mcp] ${line}`);
  }

  async discoverTools(): Promise<void> {
    this.toolCatalog.clear();
    for (const remoteServer of this.remoteServers) {
      const name = this.getServerName(remoteServer);
      if (this.unavailableServers.has(name)) {
        continue;
      }
      const client = this.rpcClients.get(name);
      if (!client) {
        continue;
      }
      try {
        const discovered = await client.listTools();
        this.toolCatalog.set(name, discovered);
        this.authFailedServers.delete(name);
        this.log("info", "catalog.loaded", {
          server: name,
          discoveredCount: discovered.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof McpHttpError && error.status === 401) {
          this.authFailedServers.add(name);
          this.log("warn", "auth.failed", {
            server: name,
            status: error.status,
            message,
          });
          continue;
        }
        this.log("warn", "catalog.failed", { server: name, error: message });
      }
    }
  }

  async startLocalServers(): Promise<void> {
    this.unavailableServers.clear();
    for (const server of this.remoteServers) {
      const name = this.getServerName(server);
      const tokenEnv = server.auth?.tokenEnv;
      if (tokenEnv) {
        const token = process.env[tokenEnv];
        if (!token || token.trim().length === 0) {
          this.unavailableServers.set(
            name,
            `Missing bearer token value from env var ${tokenEnv}`,
          );
          this.log("warn", "auth.token_missing", {
            server: name,
            tokenEnv,
          });
          continue;
        }
      }
      this.rpcClients.set(
        name,
        new StreamableHttpMcpRpcClient(
          server.url,
          server.timeoutMs ?? 10_000,
          server.auth?.tokenEnv ? process.env[server.auth.tokenEnv] : undefined,
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

  listDiscoveredTools(serverName?: string): string[] {
    if (serverName) {
      return (this.toolCatalog.get(serverName) ?? []).map(
        (tool) => `${serverName}/${tool.name}`,
      );
    }
    const output: string[] = [];
    for (const [name, descriptors] of this.toolCatalog) {
      output.push(...descriptors.map((tool) => `${name}/${tool.name}`));
    }
    return output.sort();
  }

  async loadTools(
    requestedPatterns: string[],
    environment: RuntimeEnvironment = "development",
  ): Promise<ToolDefinition[]> {
    for (const [index, pattern] of requestedPatterns.entries()) {
      validateMcpPattern(pattern, `requestedPatterns[${index}]`);
    }
    const tools: ToolDefinition[] = [];
    if (requestedPatterns.length === 0) {
      return tools;
    }
    const filteredByPolicy: string[] = [];
    const filteredByIntent: string[] = [];
    for (const server of this.remoteServers) {
      const serverName = this.getServerName(server);
      const client = this.rpcClients.get(serverName);
      if (!client) {
        continue;
      }
      const discovered = this.toolCatalog.get(serverName) ?? [];
      const fullNames = discovered.map((tool) => `${serverName}/${tool.name}`);
      const effectivePolicy = mergePolicyForEnvironment(server.tools, environment);
      // Prepend server name to patterns for matching
      const fullPatternPolicy = effectivePolicy ? {
        ...effectivePolicy,
        include: effectivePolicy.include?.map((p) => `${serverName}/${p}`),
        exclude: effectivePolicy.exclude?.map((p) => `${serverName}/${p}`),
      } : effectivePolicy;
      const policyDecision = applyToolPolicy(fullNames, fullPatternPolicy);
      filteredByPolicy.push(...policyDecision.filteredOut);
      const selectedFullNames = policyDecision.allowed.filter((toolName) =>
        requestedPatterns.some((pattern) => matchesSlashPattern(toolName, pattern)),
      );
      for (const allowedTool of policyDecision.allowed) {
        if (!selectedFullNames.includes(allowedTool)) {
          filteredByIntent.push(allowedTool);
        }
      }
      const selectedRawNames = new Set(
        selectedFullNames.map((fullName) => fullName.slice(serverName.length + 1)),
      );
      const selectedDescriptors = discovered.filter((descriptor) =>
        selectedRawNames.has(descriptor.name),
      );
      tools.push(...this.toToolDefinitions(serverName, selectedDescriptors, client));
    }
    this.log("info", "tools.selected", {
      requestedPatternCount: requestedPatterns.length,
      registeredCount: tools.length,
      filteredByPolicyCount: filteredByPolicy.length,
      filteredByIntentCount: filteredByIntent.length,
    });
    return tools;
  }

  private toToolDefinitions(
    serverName: string,
    tools: McpToolDescriptor[],
    client: McpRpcClient,
  ): ToolDefinition[] {
    return tools.map((tool) => ({
      name: `${serverName}/${tool.name}`,
      description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
      inputSchema:
        (tool.inputSchema as ToolDefinition["inputSchema"]) ?? {
          type: "object",
          properties: {},
        },
      handler: async (input) => {
        try {
          return await client.callTool(tool.name, input);
        } catch (error) {
          if (error instanceof McpHttpError && error.status === 401) {
            this.authFailedServers.add(serverName);
            this.log("warn", "auth.failed", {
              server: serverName,
              status: error.status,
              tool: tool.name,
            });
            throw new Error(
              `MCP authentication failed for "${serverName}". Verify bearer token configuration and environment values.`,
            );
          }
          if (error instanceof McpHttpError && error.status === 403) {
            throw new Error(
              `MCP permission denied for "${serverName}/${tool.name}". Verify token scopes/permissions.`,
            );
          }
          throw error instanceof Error ? error : new Error(String(error));
        }
      },
    }));
  }
}
