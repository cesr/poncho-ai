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

  it("routes continuations to /continue endpoint", async () => {
    const urls: string[] = [];
    let call = 0;
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              conversation: {
                conversationId: "conv_cont",
                title: "test",
                ownerId: "local-owner",
                tenantId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: [],
              },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (call === 2) {
          // First run returns continuation=true
          return new Response(
            `event: run:started\ndata: {"type":"run:started","runId":"run_1","agentId":"test"}\n\n` +
            `event: run:completed\ndata: {"type":"run:completed","runId":"run_1","result":{"status":"completed","response":"partial","steps":2,"tokens":{"input":10,"output":5,"cached":0},"duration":100,"continuation":true}}\n\n`,
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        }
        // Continuation run completes without continuation
        return new Response(
          `event: run:started\ndata: {"type":"run:started","runId":"run_2","agentId":"test"}\n\n` +
          `event: run:completed\ndata: {"type":"run:completed","runId":"run_2","result":{"status":"completed","response":"done","steps":1,"tokens":{"input":5,"output":3,"cached":0},"duration":50}}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });

    const result = await client.run({ task: "hello" });
    expect(result.result.steps).toBe(3);
    expect(result.result.tokens.input).toBe(15);
    // Call 1: createConversation, call 2: /messages, call 3: /continue
    expect(urls[1]).toContain("/messages");
    expect(urls[2]).toContain("/continue");
    expect(urls[2]).not.toContain("/messages");
  });

  it("stream() routes continuations to /continue endpoint", async () => {
    const urls: string[] = [];
    let call = 0;
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              conversation: {
                conversationId: "conv_stream",
                title: "test",
                ownerId: "local-owner",
                tenantId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: [],
              },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (call === 2) {
          return new Response(
            `event: run:started\ndata: {"type":"run:started","runId":"run_1","agentId":"test"}\n\n` +
            `event: run:completed\ndata: {"type":"run:completed","runId":"run_1","result":{"status":"completed","response":"partial","steps":2,"tokens":{"input":10,"output":5,"cached":0},"duration":100,"continuation":true}}\n\n`,
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return new Response(
          `event: run:started\ndata: {"type":"run:started","runId":"run_2","agentId":"test"}\n\n` +
          `event: run:completed\ndata: {"type":"run:completed","runId":"run_2","result":{"status":"completed","response":"done","steps":1,"tokens":{"input":5,"output":3,"cached":0},"duration":50}}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });

    const events = [];
    for await (const event of client.stream({ task: "hello" })) {
      events.push(event);
    }
    // 2 run:started + 2 run:completed = 4 events
    expect(events.length).toBe(4);
    expect(urls[1]).toContain("/messages");
    expect(urls[2]).toContain("/continue");
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
