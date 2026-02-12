import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { LocalMcpBridge } from "../src/mcp.js";

describe("mcp bridge protocol transports", () => {
  it("discovers and calls tools over websocket json-rpc", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolveOpen) => {
      wss.once("listening", () => resolveOpen());
    });

    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(String(data)) as {
          id: number;
          method: string;
          params?: { arguments?: { value?: string } };
        };
        if (msg.method === "tools/list") {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
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
        } else if (msg.method === "tools/call") {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                result: { echoed: msg.params?.arguments?.value ?? "" },
              },
            }),
          );
        }
      });
    });

    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("Unexpected websocket address");
    }

    const bridge = new LocalMcpBridge({
      mcp: [{ name: "remote", url: `ws://127.0.0.1:${address.port}` }],
    });

    await bridge.startLocalServers();
    const tools = await bridge.loadTools();
    const tool = tools.find((entry) => entry.name === "remote:remotePing");
    expect(tool).toBeDefined();
    const output = await tool?.handler(
      { value: "ws" },
      {
        agentId: "agent",
        runId: "run",
        step: 1,
        workingDir: process.cwd(),
        parameters: {},
      },
    );
    expect(output).toEqual({ echoed: "ws" });

    await bridge.stopLocalServers();
    await new Promise<void>((resolveClose) => {
      wss.close(() => resolveClose());
    });
  });
});
