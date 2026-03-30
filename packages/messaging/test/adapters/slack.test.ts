import { createHmac } from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { verifySlackSignature } from "../../src/adapters/slack/verify.js";
import { splitMessage, stripMention } from "../../src/adapters/slack/utils.js";
import { SlackAdapter } from "../../src/adapters/slack/index.js";
import type { IncomingMessage as PonchoIncomingMessage } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

describe("verifySlackSignature", () => {
  const secret = "test-signing-secret";

  const sign = (body: string, timestamp: number): string => {
    const basestring = `v0:${timestamp}:${body}`;
    return `v0=${createHmac("sha256", secret).update(basestring).digest("hex")}`;
  };

  it("accepts a valid signature", () => {
    const ts = Math.floor(Date.now() / 1000);
    const body = '{"type":"event_callback"}';
    const sig = sign(body, ts);

    expect(
      verifySlackSignature(secret, { signature: sig, timestamp: String(ts) }, body),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign("original", ts);

    expect(
      verifySlackSignature(secret, { signature: sig, timestamp: String(ts) }, "tampered"),
    ).toBe(false);
  });

  it("rejects when timestamp is too old", () => {
    const ts = Math.floor(Date.now() / 1000) - 600;
    const body = "body";
    const sig = sign(body, ts);

    expect(
      verifySlackSignature(secret, { signature: sig, timestamp: String(ts) }, body),
    ).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(
      verifySlackSignature(secret, { signature: undefined, timestamp: undefined }, "body"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe("stripMention", () => {
  it("removes a leading bot mention", () => {
    expect(stripMention("<@U12345> what is the weather?")).toBe("what is the weather?");
  });

  it("handles multiple mentions (only strips leading)", () => {
    expect(stripMention("<@U12345> ping <@U99999>")).toBe("ping <@U99999>");
  });

  it("returns the text unchanged when no mention", () => {
    expect(stripMention("hello world")).toBe("hello world");
  });

  it("handles whitespace around the mention", () => {
    expect(stripMention("  <@UABC>  hello  ")).toBe("hello");
  });
});

describe("splitMessage", () => {
  it("returns a single chunk for short messages", () => {
    expect(splitMessage("short")).toEqual(["short"]);
  });

  it("splits long messages at newlines", () => {
    const line = "x".repeat(3000);
    const text = `${line}\n${"y".repeat(2000)}`;
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(line);
    expect(chunks[1]).toBe("y".repeat(2000));
  });

  it("hard-cuts when there are no newlines", () => {
    const text = "a".repeat(5000);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(4000);
    expect(chunks[1]!.length).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// SlackAdapter
// ---------------------------------------------------------------------------

describe("SlackAdapter", () => {
  const secret = "test-secret";
  const token = "xoxb-test-token";

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = token;
    process.env.SLACK_SIGNING_SECRET = secret;
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    vi.restoreAllMocks();
  });

  const makeReqRes = (
    body: string,
    headers: Record<string, string> = {},
  ): { req: any; res: any; resBody: () => string; resStatus: () => number } => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

    let _resBody = "";
    let _resStatus = 0;
    const dataListeners: Array<(chunk: Buffer) => void> = [];
    const endListeners: Array<() => void> = [];
    const errorListeners: Array<(err: Error) => void> = [];

    const req = {
      method: "POST",
      url: "/api/messaging/slack",
      headers: {
        "x-slack-signature": sig,
        "x-slack-request-timestamp": ts,
        ...headers,
      },
      on(event: string, cb: (...args: any[]) => void) {
        if (event === "data") {
          dataListeners.push(cb as any);
        } else if (event === "end") {
          endListeners.push(cb as any);
        } else if (event === "error") {
          errorListeners.push(cb as any);
        }
        // Fire body data on next tick after both data+end listeners are registered
        if (dataListeners.length > 0 && endListeners.length > 0) {
          queueMicrotask(() => {
            for (const fn of dataListeners) fn(Buffer.from(body));
            for (const fn of endListeners) fn();
          });
        }
        return req;
      },
    };

    const res = {
      writeHead(status: number, _headers?: Record<string, string>) {
        _resStatus = status;
      },
      end(data?: string) {
        _resBody = data ?? "";
      },
    };

    return {
      req,
      res,
      resBody: () => _resBody,
      resStatus: () => _resStatus,
    };
  };

  it("initializes successfully with valid env vars", async () => {
    const adapter = new SlackAdapter();
    await expect(adapter.initialize()).resolves.not.toThrow();
  });

  it("throws on missing SLACK_BOT_TOKEN", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const adapter = new SlackAdapter();
    await expect(adapter.initialize()).rejects.toThrow("SLACK_BOT_TOKEN");
  });

  it("throws on missing SLACK_SIGNING_SECRET", async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const adapter = new SlackAdapter();
    await expect(adapter.initialize()).rejects.toThrow("SLACK_SIGNING_SECRET");
  });

  it("registers a POST route at /api/messaging/slack", () => {
    const adapter = new SlackAdapter();
    const routes: Array<{ method: string; path: string }> = [];
    adapter.registerRoutes((method, path) => {
      routes.push({ method, path });
    });
    expect(routes).toEqual([{ method: "POST", path: "/api/messaging/slack" }]);
  });

  it("handles url_verification challenge", async () => {
    const adapter = new SlackAdapter();
    await adapter.initialize();

    let handler: any;
    adapter.registerRoutes((_m, _p, h) => { handler = h; });

    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const { req, res, resBody } = makeReqRes(body);

    await handler(req, res);

    const parsed = JSON.parse(resBody());
    expect(parsed.challenge).toBe("abc123");
  });

  it("skips retry requests", async () => {
    const adapter = new SlackAdapter();
    await adapter.initialize();
    const received: PonchoIncomingMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    let handler: any;
    adapter.registerRoutes((_m, _p, h) => { handler = h; });

    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention", text: "<@U1> hi", ts: "1", channel: "C1", user: "U2" },
    });
    const { req, res, resStatus } = makeReqRes(body, { "x-slack-retry-num": "1" });

    await handler(req, res);

    // Give time for any async handler to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(0);
    expect(resStatus()).toBe(200);
  });

  it("includes thread context when mention is in a thread reply", async () => {
    const adapter = new SlackAdapter();
    await adapter.initialize();
    const received: PonchoIncomingMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    // Mock fetch to intercept conversations.replies
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("conversations.replies")) {
        return {
          json: async () => ({
            ok: true,
            messages: [
              { user: "U_PARENT", text: "What are the limitations of self-hosted?", ts: "100.0" },
              { user: "U2", text: "<@U1> can you help?", ts: "100.1" },
            ],
          }),
        };
      }
      // Pass through for other Slack API calls (reactions)
      return { json: async () => ({ ok: true }) };
    }));

    let handler: any;
    adapter.registerRoutes((_m, _p, h) => { handler = h; });

    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "app_mention",
        text: "<@U1> can you help?",
        ts: "100.1",
        thread_ts: "100.0",
        channel: "C1",
        user: "U2",
      },
    });
    const { req, res } = makeReqRes(body);
    await handler(req, res);

    // Wait for async handler
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toContain("[Thread context]");
    expect(received[0]!.text).toContain("What are the limitations of self-hosted?");
    expect(received[0]!.text).toContain("[New message]");
    expect(received[0]!.text).toContain("can you help?");

    vi.stubGlobal("fetch", originalFetch);
  });

  it("does not fetch thread context for top-level mentions", async () => {
    const adapter = new SlackAdapter();
    await adapter.initialize();
    const received: PonchoIncomingMessage[] = [];
    adapter.onMessage(async (msg) => { received.push(msg); });

    const fetchSpy = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchSpy);

    let handler: any;
    adapter.registerRoutes((_m, _p, h) => { handler = h; });

    // No thread_ts → top-level message
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "app_mention",
        text: "<@U1> hello",
        ts: "200.0",
        channel: "C1",
        user: "U2",
      },
    });
    const { req, res } = makeReqRes(body);
    await handler(req, res);

    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("hello");
    // conversations.replies should NOT have been called
    const repliesCalls = fetchSpy.mock.calls.filter(
      ([url]: any) => typeof url === "string" && url.includes("conversations.replies"),
    );
    expect(repliesCalls).toHaveLength(0);

    vi.restoreAllMocks();
  });
});
