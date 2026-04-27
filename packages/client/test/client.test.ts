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

  const jsonResponse = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("runs a message through conversation APIs", async () => {
    let call = 0;
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse({
            conversation: {
              conversationId: "conv_1",
              title: "hello",
              ownerId: "local-owner",
              tenantId: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: [],
            },
          });
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
          return jsonResponse({
            conversation: {
              conversationId: "conv_cont",
              title: "test",
              ownerId: "local-owner",
              tenantId: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: [],
            },
          });
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
          return jsonResponse({
            conversation: {
              conversationId: "conv_stream",
              title: "test",
              ownerId: "local-owner",
              tenantId: null,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: [],
            },
          });
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
        jsonResponse({
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
    });

    const results = await client.listConversations();
    expect(results).toHaveLength(1);
    expect(results[0]?.conversationId).toBe("conv_1");
  });

  // --- Conversation management ---

  it("renames a conversation", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        if (init?.body) bodies.push(JSON.parse(init.body as string));
        return jsonResponse({
          conversation: {
            conversationId: "conv_1",
            title: "New Title",
            ownerId: "local-owner",
            tenantId: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
          },
        });
      },
    });

    const result = await client.renameConversation("conv_1", "New Title");
    expect(result.title).toBe("New Title");
    expect(urls[0]).toContain("/api/conversations/conv_1");
    expect(bodies[0]).toEqual({ title: "New Title" });
  });

  it("stops a run", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        jsonResponse({ ok: true, stopped: true, runId: "run_1" }),
    });

    const result = await client.stopRun("conv_1", "run_1");
    expect(result.ok).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.runId).toBe("run_1");
  });

  it("compacts a conversation", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        jsonResponse({
          compacted: true,
          messagesBefore: 20,
          messagesAfter: 5,
        }),
    });

    const result = await client.compactConversation("conv_1", "Focus on errors");
    expect(result.compacted).toBe(true);
    expect(result.messagesBefore).toBe(20);
    expect(result.messagesAfter).toBe(5);
  });

  it("lists todos", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        jsonResponse({ todos: ["Fix bug", "Write tests"] }),
    });

    const result = await client.listTodos("conv_1");
    expect(result).toEqual(["Fix bug", "Write tests"]);
  });

  it("subscribes to events", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        new Response(
          `event: run:started\ndata: {"type":"run:started","runId":"run_1","agentId":"test"}\n\n` +
          `event: model:chunk\ndata: {"type":"model:chunk","content":"hello"}\n\n` +
          `event: run:completed\ndata: {"type":"run:completed","runId":"run_1","result":{"status":"completed","response":"hello","steps":1,"tokens":{"input":1,"output":1,"cached":0},"duration":1}}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    });

    const events = [];
    for await (const event of client.subscribeToEvents("conv_1")) {
      events.push(event);
    }
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("run:started");
    expect(events[1]!.type).toBe("model:chunk");
    expect(events[2]!.type).toBe("run:completed");
  });

  it("subscribes to events with liveOnly option", async () => {
    const urls: string[] = [];
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        return new Response(
          `event: run:started\ndata: {"type":"run:started","runId":"run_1","agentId":"test"}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });

    const events = [];
    for await (const event of client.subscribeToEvents("conv_1", { liveOnly: true })) {
      events.push(event);
    }
    expect(urls[0]).toContain("live_only=true");
  });

  // --- Approvals ---

  it("submits an approval", async () => {
    const bodies: unknown[] = [];
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.body) bodies.push(JSON.parse(init.body as string));
        return jsonResponse({
          ok: true,
          approvalId: "apr_1",
          approved: true,
          batchComplete: true,
        });
      },
    });

    const result = await client.submitApproval("apr_1", true, "conv_1");
    expect(result.ok).toBe(true);
    expect(result.approved).toBe(true);
    expect(result.batchComplete).toBe(true);
    expect(bodies[0]).toEqual({ approved: true, conversationId: "conv_1" });
  });

  it("handles approval not found error", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ code: "APPROVAL_NOT_FOUND", message: "Approval request not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
    });

    await expect(client.submitApproval("apr_missing", true)).rejects.toThrow(
      "Approval request not found",
    );
  });

  // --- Subagents ---

  it("lists subagents", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        jsonResponse({
          subagents: [
            {
              conversationId: "sub_1",
              title: "Research task",
              task: "Search for docs",
              status: "running",
              messageCount: 5,
              hasPendingApprovals: false,
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-01T00:01:00Z",
            },
          ],
        }),
    });

    const result = await client.listSubagents("conv_1");
    expect(result).toHaveLength(1);
    expect(result[0]!.conversationId).toBe("sub_1");
    expect(result[0]!.status).toBe("running");
  });

  // --- Secrets ---

  it("lists secrets", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        jsonResponse({
          secrets: [
            { name: "API_KEY", label: "API Key", isSet: true },
            { name: "DB_URL", label: "Database URL", isSet: false },
          ],
        }),
    });

    const result = await client.listSecrets();
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("API_KEY");
    expect(result[0]!.isSet).toBe(true);
  });

  it("lists secrets with tenant parameter", async () => {
    const urls: string[] = [];
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        return jsonResponse({ secrets: [] });
      },
    });

    await client.listSecrets("tenant_abc");
    expect(urls[0]).toContain("tenant=tenant_abc");
  });

  it("sets a secret", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        if (init?.body) bodies.push(JSON.parse(init.body as string));
        return jsonResponse({ ok: true });
      },
    });

    await client.setSecret("API_KEY", "sk-123");
    expect(urls[0]).toContain("/api/secrets/API_KEY");
    expect(bodies[0]).toEqual({ value: "sk-123" });
  });

  it("sets a secret with tenant parameter", async () => {
    const urls: string[] = [];
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        return jsonResponse({ ok: true });
      },
    });

    await client.setSecret("API_KEY", "sk-123", "tenant_abc");
    expect(urls[0]).toContain("tenant=tenant_abc");
  });

  it("deletes a secret", async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        methods.push(init?.method ?? "GET");
        return jsonResponse({ ok: true });
      },
    });

    await client.deleteSecret("API_KEY");
    expect(urls[0]).toContain("/api/secrets/API_KEY");
    expect(methods[0]).toBe("DELETE");
  });

  // --- Slash commands ---

  it("lists slash commands", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        jsonResponse({
          commands: [
            { command: "/compact", description: "Compact context", type: "command" },
            { command: "/search", description: "Search docs", type: "skill" },
          ],
        }),
    });

    const result = await client.listSlashCommands();
    expect(result).toHaveLength(2);
    expect(result[0]!.command).toBe("/compact");
    expect(result[0]!.type).toBe("command");
    expect(result[1]!.type).toBe("skill");
  });

  // --- VFS ---

  it("reads a file from VFS", async () => {
    const urls: string[] = [];
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        return new Response("file contents", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      },
    });

    const response = await client.readFile("/data/test.txt");
    const text = await response.text();
    expect(text).toBe("file contents");
    expect(urls[0]).toContain("/api/vfs/data/test.txt");
  });

  it("normalizes VFS paths without leading slash", async () => {
    const urls: string[] = [];
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
        return new Response("ok", { status: 200 });
      },
    });

    await client.readFile("data/test.txt");
    expect(urls[0]).toContain("/api/vfs/data/test.txt");
  });

  it("throws on VFS read failure", async () => {
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ code: "NOT_FOUND", message: "File not found in VFS" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
    });

    await expect(client.readFile("/missing.txt")).rejects.toThrow("VFS read failed");
  });

  it("listThreads GETs /threads and returns the array", async () => {
    let calledUrl: string | undefined;
    let calledMethod: string | undefined;
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input, init) => {
        calledUrl = typeof input === "string" ? input : (input as URL).href;
        calledMethod = (init?.method ?? "GET").toUpperCase();
        return jsonResponse({
          threads: [
            {
              conversationId: "thread_1",
              parentConversationId: "conv_1",
              parentMessageId: "msg_a",
              title: "Thread 1",
              messageCount: 3,
              replyCount: 1,
              snapshotLength: 2,
              createdAt: 1,
              updatedAt: 2,
              lastReplyAt: 2,
            },
          ],
        });
      },
    });

    const threads = await client.listThreads("conv_1");
    expect(calledUrl).toContain("/api/conversations/conv_1/threads");
    expect(calledMethod).toBe("GET");
    expect(threads).toHaveLength(1);
    expect(threads[0].parentMessageId).toBe("msg_a");
  });

  it("createThread POSTs to /threads with parentMessageId in the body", async () => {
    let calledUrl: string | undefined;
    let calledMethod: string | undefined;
    let calledBody: string | undefined;
    const client = new AgentClient({
      url: "http://localhost:3000",
      fetchImpl: async (input, init) => {
        calledUrl = typeof input === "string" ? input : (input as URL).href;
        calledMethod = (init?.method ?? "GET").toUpperCase();
        calledBody = init?.body as string | undefined;
        return jsonResponse(
          {
            thread: {
              conversationId: "thread_new",
              parentConversationId: "conv_1",
              parentMessageId: "msg_a",
              title: "Thread: hi",
              messageCount: 1,
              replyCount: 0,
              snapshotLength: 1,
              createdAt: 1,
              updatedAt: 1,
              lastReplyAt: 1,
            },
            conversationId: "thread_new",
          },
          201,
        );
      },
    });

    const resp = await client.createThread("conv_1", "msg_a", "Custom title");
    expect(calledUrl).toContain("/api/conversations/conv_1/threads");
    expect(calledMethod).toBe("POST");
    expect(calledBody && JSON.parse(calledBody)).toEqual({
      parentMessageId: "msg_a",
      title: "Custom title",
    });
    expect(resp.conversationId).toBe("thread_new");
    expect(resp.thread.parentMessageId).toBe("msg_a");
  });
});
