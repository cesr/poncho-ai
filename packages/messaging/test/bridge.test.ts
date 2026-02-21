import { describe, expect, it, vi } from "vitest";
import { AgentBridge } from "../src/bridge.js";
import type {
  AgentRunner,
  IncomingMessage,
  IncomingMessageHandler,
  MessagingAdapter,
  RouteRegistrar,
  ThreadRef,
} from "../src/types.js";

const makeAdapter = (): MessagingAdapter & {
  _handler: IncomingMessageHandler | undefined;
  _replies: Array<{ ref: ThreadRef; content: string }>;
  _processing: ThreadRef[];
} => ({
  platform: "test",
  _handler: undefined,
  _replies: [],
  _processing: [],
  registerRoutes(_router: RouteRegistrar) {},
  async initialize() {},
  onMessage(handler) {
    this._handler = handler;
  },
  async sendReply(ref, content) {
    this._replies.push({ ref, content });
  },
  async indicateProcessing(ref) {
    this._processing.push(ref);
    return async () => {
      const idx = this._processing.indexOf(ref);
      if (idx >= 0) this._processing.splice(idx, 1);
    };
  },
});

const makeRunner = (
  response = "Hello from agent",
): AgentRunner & {
  _conversations: Map<string, { messages: Array<{ role: string; content: string }> }>;
  _runs: Array<{ id: string; task: string }>;
} => {
  const conversations = new Map<string, { messages: Array<{ role: string; content: string }> }>();
  const runs: Array<{ id: string; task: string }> = [];
  return {
    _conversations: conversations,
    _runs: runs,
    async getOrCreateConversation(id, _meta) {
      if (!conversations.has(id)) {
        conversations.set(id, { messages: [] });
      }
      return conversations.get(id)!;
    },
    async run(id, input) {
      runs.push({ id, task: input.task });
      return { response };
    },
  };
};

const sampleMessage = (overrides?: Partial<IncomingMessage>): IncomingMessage => ({
  text: "What is 2+2?",
  threadRef: { platformThreadId: "ts_123", channelId: "C001" },
  sender: { id: "U123", name: "alice" },
  platform: "test",
  raw: {},
  ...overrides,
});

describe("AgentBridge", () => {
  it("derives deterministic conversation IDs from ThreadRef", async () => {
    const adapter = makeAdapter();
    const runner = makeRunner();
    const bridge = new AgentBridge({ adapter, runner });
    await bridge.start();

    await adapter._handler!(sampleMessage());

    expect(runner._runs).toHaveLength(1);
    expect(runner._runs[0]!.id).toBe("test:C001:ts_123");
  });

  it("sends the agent response back via the adapter", async () => {
    const adapter = makeAdapter();
    const runner = makeRunner("The answer is 4.");
    const bridge = new AgentBridge({ adapter, runner });
    await bridge.start();

    await adapter._handler!(sampleMessage());

    expect(adapter._replies).toHaveLength(1);
    expect(adapter._replies[0]!.content).toBe("The answer is 4.");
    expect(adapter._replies[0]!.ref.channelId).toBe("C001");
  });

  it("cleans up the processing indicator after success", async () => {
    const adapter = makeAdapter();
    const runner = makeRunner();
    const bridge = new AgentBridge({ adapter, runner });
    await bridge.start();

    await adapter._handler!(sampleMessage());

    expect(adapter._processing).toHaveLength(0);
  });

  it("posts an error message and cleans up on runner failure", async () => {
    const adapter = makeAdapter();
    const runner = makeRunner();
    runner.run = async () => {
      throw new Error("Model overloaded");
    };
    const bridge = new AgentBridge({ adapter, runner });
    await bridge.start();

    await adapter._handler!(sampleMessage());

    expect(adapter._replies).toHaveLength(1);
    expect(adapter._replies[0]!.content).toContain("Model overloaded");
    expect(adapter._processing).toHaveLength(0);
  });

  it("uses the same conversation ID for repeated messages in the same thread", async () => {
    const adapter = makeAdapter();
    const runner = makeRunner();
    const bridge = new AgentBridge({ adapter, runner });
    await bridge.start();

    await adapter._handler!(sampleMessage());
    await adapter._handler!(sampleMessage({ text: "followup" }));

    expect(runner._runs).toHaveLength(2);
    expect(runner._runs[0]!.id).toBe(runner._runs[1]!.id);
  });

  it("creates different conversation IDs for different threads", async () => {
    const adapter = makeAdapter();
    const runner = makeRunner();
    const bridge = new AgentBridge({ adapter, runner });
    await bridge.start();

    await adapter._handler!(sampleMessage());
    await adapter._handler!(
      sampleMessage({
        threadRef: { platformThreadId: "ts_456", channelId: "C002" },
      }),
    );

    expect(runner._runs[0]!.id).not.toBe(runner._runs[1]!.id);
  });

  it("calls waitUntil for each message processed via onMessage", async () => {
    const adapter = makeAdapter();
    const runner = makeRunner();
    const waitUntil = vi.fn();
    const bridge = new AgentBridge({ adapter, runner, waitUntil });
    await bridge.start();

    await adapter._handler!(sampleMessage());

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0]![0]).toBeInstanceOf(Promise);
  });
});
