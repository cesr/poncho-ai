import { describe, expect, it } from "vitest";
import { AgentClient } from "../src/index.js";

describe("AgentClient", () => {
  const sseResponse = (): Response =>
    new Response(
      `event: run:started\n` +
        `data: {"type":"run:started","runId":"run_1","agentId":"test-agent"}\n\n` +
        `event: run:completed\n` +
        `data: {"type":"run:completed","runId":"run_1","result":{"status":"completed","response":"ok","steps":1,"tokens":{"input":1,"output":1,"cached":0},"duration":1}}\n\n`,
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      },
    );

  it("runs a message through conversation APIs", async () => {
    let call = 0;
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              conversation: {
                conversationId: "conv_1",
                title: "hello",
                ownerId: "local-owner",
                tenantId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: [],
              },
            }),
            {
              status: 201,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return sseResponse();
      },
    });

    const result = await client.run({ task: "hello" });
    expect(result.runId).toBe("run_1");
    expect(result.result.response).toBe("ok");
  });

  it("supports continue() via conversation message route", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () => sseResponse(),
    });

    const result = await client.continue({ runId: "conv_1", message: "next" });
    expect(result.runId).toBe("run_1");
    expect(result.result.response).toBe("ok");
  });

  it("lists conversations", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            conversations: [
              {
                conversationId: "conv_1",
                title: "Example",
                runtimeRunId: "run_1",
                ownerId: "local-owner",
                tenantId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messageCount: 2,
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    });

    const results = await client.listConversations();
    expect(results).toHaveLength(1);
    expect(results[0]?.conversationId).toBe("conv_1");
  });
});
