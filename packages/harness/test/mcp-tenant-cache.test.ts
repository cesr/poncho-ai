import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "@poncho-ai/sdk";
import { LocalMcpBridge } from "../src/mcp.js";

interface ServerHandle {
  port: number;
  initializeCount: number;
  shutdown: () => Promise<void>;
  observedAuthHeaders: string[];
}

async function startMockMcpServer(): Promise<ServerHandle> {
  const observedAuthHeaders: string[] = [];
  let initializeCount = 0;
  let sessionCounter = 0;
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") {
      res.statusCode = 200;
      res.end();
      return;
    }
    const auth = req.headers.authorization;
    if (auth) observedAuthHeaders.push(auth);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const payload = body.trim().length > 0 ? (JSON.parse(body) as any) : {};
    if (payload.method === "initialize") {
      initializeCount += 1;
      sessionCounter += 1;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Mcp-Session-Id", `s_${sessionCounter}`);
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "remote", version: "1.0.0" },
          },
        }),
      );
      return;
    }
    if (payload.method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (payload.method === "tools/list") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            tools: [
              {
                name: "ping",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                },
              },
            ],
          },
        }),
      );
      return;
    }
    if (payload.method === "tools/call") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { result: { echoed: payload.params?.arguments?.value ?? "" } },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    get initializeCount() {
      return initializeCount;
    },
    observedAuthHeaders,
    shutdown: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const stubContext = (tenantId: string): ToolContext => ({
  agentId: "agent",
  runId: "run",
  step: 1,
  workingDir: process.cwd(),
  parameters: {},
  tenantId,
});

describe("LocalMcpBridge per-tenant client cache (PR 3)", () => {
  it("reuses the same StreamableHttpMcpRpcClient across calls from the same tenant", async () => {
    process.env.LINEAR_TOKEN = "default-token";
    const server = await startMockMcpServer();
    try {
      const bridge = new LocalMcpBridge({
        mcp: [
          {
            name: "remote",
            url: `http://127.0.0.1:${server.port}/mcp`,
            auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
          },
        ],
      });
      bridge.setEnvResolver(async (tenantId, envName) => {
        if (envName !== "LINEAR_TOKEN") return undefined;
        return tenantId === "tenant-A" ? "token-A" : undefined;
      });
      await bridge.startLocalServers();
      await bridge.discoverTools();
      const tools = await bridge.loadTools(["remote/ping"]);
      const tool = tools.find((t) => t.name === "remote/ping")!;

      const constructionsBefore = bridge.tenantClientConstructions;
      await tool.handler({ value: "1" }, stubContext("tenant-A"));
      await tool.handler({ value: "2" }, stubContext("tenant-A"));
      await tool.handler({ value: "3" }, stubContext("tenant-A"));

      // One construction for tenant-A; subsequent calls reuse it.
      expect(bridge.tenantClientConstructions - constructionsBefore).toBe(1);
      // The mock server saw a single initialize for the per-tenant client
      // (in addition to the initial discovery initialize).
      const tenantInits = server.observedAuthHeaders.filter(
        (h) => h === "Bearer token-A",
      ).length;
      // initialize + notifications/initialized + 3x tools/call = 5 requests
      // with token-A; only one initialize.
      expect(tenantInits).toBeGreaterThanOrEqual(4);

      await bridge.stopLocalServers();
    } finally {
      await server.shutdown();
    }
  });

  it("uses different cached clients for different tenants", async () => {
    process.env.LINEAR_TOKEN = "default-token";
    const server = await startMockMcpServer();
    try {
      const bridge = new LocalMcpBridge({
        mcp: [
          {
            name: "remote",
            url: `http://127.0.0.1:${server.port}/mcp`,
            auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
          },
        ],
      });
      bridge.setEnvResolver(async (tenantId, envName) => {
        if (envName !== "LINEAR_TOKEN") return undefined;
        if (tenantId === "tenant-A") return "token-A";
        if (tenantId === "tenant-B") return "token-B";
        return undefined;
      });
      await bridge.startLocalServers();
      await bridge.discoverTools();
      const tools = await bridge.loadTools(["remote/ping"]);
      const tool = tools.find((t) => t.name === "remote/ping")!;

      const constructionsBefore = bridge.tenantClientConstructions;
      await tool.handler({ value: "a1" }, stubContext("tenant-A"));
      await tool.handler({ value: "b1" }, stubContext("tenant-B"));
      await tool.handler({ value: "a2" }, stubContext("tenant-A"));
      await tool.handler({ value: "b2" }, stubContext("tenant-B"));

      // One construction per tenant, then reuse.
      expect(bridge.tenantClientConstructions - constructionsBefore).toBe(2);

      await bridge.stopLocalServers();
    } finally {
      await server.shutdown();
    }
  });

  it("rebuilds the cached client when the tenant's token changes", async () => {
    process.env.LINEAR_TOKEN = "default-token";
    const server = await startMockMcpServer();
    try {
      const bridge = new LocalMcpBridge({
        mcp: [
          {
            name: "remote",
            url: `http://127.0.0.1:${server.port}/mcp`,
            auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
          },
        ],
      });
      let currentToken = "token-v1";
      bridge.setEnvResolver(async (tenantId, envName) => {
        if (envName !== "LINEAR_TOKEN" || tenantId !== "tenant-A") return undefined;
        return currentToken;
      });
      await bridge.startLocalServers();
      await bridge.discoverTools();
      const tools = await bridge.loadTools(["remote/ping"]);
      const tool = tools.find((t) => t.name === "remote/ping")!;

      const constructionsBefore = bridge.tenantClientConstructions;
      await tool.handler({ value: "1" }, stubContext("tenant-A"));
      // Rotate the user's token — next call should rebuild the client.
      currentToken = "token-v2";
      await tool.handler({ value: "2" }, stubContext("tenant-A"));
      await tool.handler({ value: "3" }, stubContext("tenant-A"));

      // 1 build for v1, 1 build for v2; the v2 build is reused for the 3rd call.
      expect(bridge.tenantClientConstructions - constructionsBefore).toBe(2);

      await bridge.stopLocalServers();
    } finally {
      await server.shutdown();
    }
  });

  it("evicts cached clients after the configured idle TTL", async () => {
    process.env.LINEAR_TOKEN = "default-token";
    const server = await startMockMcpServer();
    try {
      const bridge = new LocalMcpBridge(
        {
          mcp: [
            {
              name: "remote",
              url: `http://127.0.0.1:${server.port}/mcp`,
              auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
            },
          ],
        },
        { tenantClientTtlMs: 10 }, // very short TTL for the test
      );
      bridge.setEnvResolver(async (tenantId, envName) => {
        if (envName !== "LINEAR_TOKEN") return undefined;
        return tenantId === "tenant-A" ? "token-A" : undefined;
      });
      await bridge.startLocalServers();
      await bridge.discoverTools();
      const tools = await bridge.loadTools(["remote/ping"]);
      const tool = tools.find((t) => t.name === "remote/ping")!;

      const constructionsBefore = bridge.tenantClientConstructions;
      await tool.handler({ value: "1" }, stubContext("tenant-A"));
      // Sleep beyond TTL, then call again — should evict + rebuild.
      await new Promise((r) => setTimeout(r, 30));
      await tool.handler({ value: "2" }, stubContext("tenant-A"));
      expect(bridge.tenantClientConstructions - constructionsBefore).toBe(2);

      await bridge.stopLocalServers();
    } finally {
      await server.shutdown();
    }
  });

  it("closes cached tenant clients on stopLocalServers()", async () => {
    process.env.LINEAR_TOKEN = "default-token";
    const server = await startMockMcpServer();
    try {
      const bridge = new LocalMcpBridge({
        mcp: [
          {
            name: "remote",
            url: `http://127.0.0.1:${server.port}/mcp`,
            auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
          },
        ],
      });
      bridge.setEnvResolver(async (tenantId, envName) => {
        if (envName !== "LINEAR_TOKEN") return undefined;
        return tenantId === "tenant-A" ? "token-A" : undefined;
      });
      await bridge.startLocalServers();
      await bridge.discoverTools();
      const tools = await bridge.loadTools(["remote/ping"]);
      const tool = tools.find((t) => t.name === "remote/ping")!;
      await tool.handler({ value: "1" }, stubContext("tenant-A"));

      // Before stop: cache has one entry.
      // After stop: should be empty (and a subsequent call would rebuild).
      await bridge.stopLocalServers();

      // Re-run discovery to bring servers back up — verify cache rebuilds.
      await bridge.startLocalServers();
      await bridge.discoverTools();
      const tools2 = await bridge.loadTools(["remote/ping"]);
      const tool2 = tools2.find((t) => t.name === "remote/ping")!;
      const constructionsBefore = bridge.tenantClientConstructions;
      await tool2.handler({ value: "post-stop" }, stubContext("tenant-A"));
      expect(bridge.tenantClientConstructions - constructionsBefore).toBe(1);

      await bridge.stopLocalServers();
    } finally {
      await server.shutdown();
    }
  });
});
