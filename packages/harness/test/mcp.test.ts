import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { LocalMcpBridge } from "../src/mcp.js";

describe("mcp bridge protocol transports", () => {
  it("discovers and calls tools over streamable HTTP", async () => {
    process.env.LINEAR_TOKEN = "token-123";
    const requests: string[] = [];
    let authHeader = "";
    let deleteSeen = false;
    const session = "session_test";
    const server = createServer(async (req, res) => {
      if (req.method === "DELETE") {
        deleteSeen = true;
        res.statusCode = 200;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = body.trim().length > 0 ? (JSON.parse(body) as any) : {};
      authHeader = req.headers.authorization ?? "";
      if (payload.method) {
        requests.push(payload.method);
      }
      if (payload.method === "initialize") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Mcp-Session-Id", session);
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
        expect(req.headers["mcp-session-id"]).toBe(session);
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              tools: [
                {
                  name: "remotePing",
                  description: "Remote ping",
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
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { result: { echoed: payload.params?.arguments?.value ?? "" } },
          })}\n\n`,
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveOpen) => server.listen(0, () => resolveOpen()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected server address");
    }

    const bridge = new LocalMcpBridge({
      mcp: [
        {
          name: "remote",
          url: `http://127.0.0.1:${address.port}/mcp`,
          auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
        },
      ],
    });

    await bridge.startLocalServers();
    await bridge.discoverTools();
    const tools = await bridge.loadTools(["remote/remotePing"]);
    const tool = tools.find((entry) => entry.name === "remote/remotePing");
    expect(tool).toBeDefined();
    const output = await tool?.handler(
      { value: "http" },
      {
        agentId: "agent",
        runId: "run",
        step: 1,
        workingDir: process.cwd(),
        parameters: {},
      },
    );
    expect(output).toEqual({ echoed: "http" });
    expect(authHeader).toBe("Bearer token-123");
    expect(requests).toContain("initialize");
    expect(requests).toContain("tools/list");
    expect(requests).toContain("tools/call");

    await bridge.stopLocalServers();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    expect(deleteSeen).toBe(true);
  });

  it("fails fast on duplicate server names", () => {
    expect(
      () =>
        new LocalMcpBridge({
          mcp: [
            { name: "dup", url: "https://example.com/a" },
            { name: "dup", url: "https://example.com/b" },
          ],
        }),
    ).toThrow(/Duplicate MCP server name/);
  });

  it("applies allowlist and denylist policy filters", async () => {
    process.env.LINEAR_TOKEN = "token-123";
    const server = createServer(async (req, res) => {
      if (req.method === "DELETE") {
        res.statusCode = 200;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = body.trim().length > 0 ? (JSON.parse(body) as any) : {};
      if (payload.method === "initialize") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Mcp-Session-Id", "s");
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
                { name: "a", inputSchema: { type: "object", properties: {} } },
                { name: "b", inputSchema: { type: "object", properties: {} } },
              ],
            },
          }),
        );
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: {} }));
    });
    await new Promise<void>((resolveOpen) => server.listen(0, () => resolveOpen()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected server address");
    }
    const allowBridge = new LocalMcpBridge({
      mcp: [
        {
          name: "remote",
          url: `http://127.0.0.1:${address.port}/mcp`,
          auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
          tools: { mode: "allowlist", include: ["remote/a"] },
        },
      ],
    });
    await allowBridge.startLocalServers();
    await allowBridge.discoverTools();
    const allowTools = await allowBridge.loadTools(["remote/*"]);
    expect(allowTools.map((tool) => tool.name)).toEqual(["remote/a"]);
    await allowBridge.stopLocalServers();

    const denyBridge = new LocalMcpBridge({
      mcp: [
        {
          name: "remote",
          url: `http://127.0.0.1:${address.port}/mcp`,
          auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
          tools: { mode: "denylist", exclude: ["remote/b"] },
        },
      ],
    });
    await denyBridge.startLocalServers();
    await denyBridge.discoverTools();
    const denyTools = await denyBridge.loadTools(["remote/*"]);
    expect(denyTools.map((tool) => tool.name).sort()).toEqual(["remote/a"]);
    await denyBridge.stopLocalServers();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("skips discovery when bearer token env value is missing", async () => {
    delete process.env.MISSING_TOKEN_ENV;
    const bridge = new LocalMcpBridge({
      mcp: [
        {
          name: "remote",
          url: "https://example.com/mcp",
          auth: { type: "bearer", tokenEnv: "MISSING_TOKEN_ENV" },
        },
      ],
    });
    await bridge.startLocalServers();
    await bridge.discoverTools();
    const tools = await bridge.loadTools(["remote/*"]);
    expect(tools).toEqual([]);
  });

  it("reports auth failures during discovery and call execution", async () => {
    process.env.LINEAR_TOKEN = "token-123";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const server = createServer(async (req, res) => {
      if (req.method === "DELETE") {
        res.statusCode = 200;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = body.trim().length > 0 ? (JSON.parse(body) as any) : {};
      if (payload.method === "initialize") {
        res.statusCode = 401;
        res.end("unauthorized");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveOpen) => server.listen(0, () => resolveOpen()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unexpected address");
    const bridge = new LocalMcpBridge({
      mcp: [
        {
          name: "remote",
          url: `http://127.0.0.1:${address.port}/mcp`,
          auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
        },
      ],
    });
    await bridge.startLocalServers();
    await bridge.discoverTools();
    expect(bridge.listDiscoveredTools()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"auth.failed"'));
    await bridge.stopLocalServers();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    warnSpy.mockRestore();
  });

  it("returns actionable errors for 403 permission failures", async () => {
    process.env.LINEAR_TOKEN = "token-123";
    const server = createServer(async (req, res) => {
      if (req.method === "DELETE") {
        res.statusCode = 200;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = body.trim().length > 0 ? (JSON.parse(body) as any) : {};
      if (payload.method === "initialize") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Mcp-Session-Id", "sess");
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
              tools: [{ name: "restricted", inputSchema: { type: "object", properties: {} } }],
            },
          }),
        );
        return;
      }
      if (payload.method === "tools/call") {
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveOpen) => server.listen(0, () => resolveOpen()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unexpected address");
    const bridge = new LocalMcpBridge({
      mcp: [
        {
          name: "remote",
          url: `http://127.0.0.1:${address.port}/mcp`,
          auth: { type: "bearer", tokenEnv: "LINEAR_TOKEN" },
        },
      ],
    });
    await bridge.startLocalServers();
    await bridge.discoverTools();
    const tools = await bridge.loadTools(["remote/*"]);
    const restricted = tools.find((tool) => tool.name === "remote/restricted");
    expect(restricted).toBeDefined();
    await expect(
      restricted!.handler(
        {},
        {
          agentId: "agent",
          runId: "run",
          step: 1,
          workingDir: process.cwd(),
          parameters: {},
        },
      ),
    ).rejects.toThrow(/permission denied/i);
    await bridge.stopLocalServers();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });
});
