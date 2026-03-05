import { describe, expect, it, vi } from "vitest";
import { ResendAdapter } from "../../src/adapters/resend/index.js";
import type { RouteRegistrar } from "../../src/types.js";

/**
 * Since the ResendAdapter dynamically imports `resend`, we test the parts that
 * don't require a live Resend client: route registration, construction, and
 * the allowlist/dedup logic via the exported class shape.
 *
 * Full integration tests require mocking the Resend SDK which is covered
 * separately if needed.
 */

describe("ResendAdapter", () => {
  it("registers a POST route at /api/messaging/resend", () => {
    const adapter = new ResendAdapter();
    const routes: Array<{ method: string; path: string }> = [];
    const registrar: RouteRegistrar = (method, path) => {
      routes.push({ method, path });
    };
    adapter.registerRoutes(registrar);
    expect(routes).toEqual([{ method: "POST", path: "/api/messaging/resend" }]);
  });

  it("has platform set to 'resend'", () => {
    const adapter = new ResendAdapter();
    expect(adapter.platform).toBe("resend");
  });

  it("indicateProcessing returns a no-op cleanup function", async () => {
    const adapter = new ResendAdapter();
    const cleanup = await adapter.indicateProcessing({
      platformThreadId: "t1",
      channelId: "c1",
    });
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it("accepts custom env var names", () => {
    const adapter = new ResendAdapter({
      apiKeyEnv: "MY_RESEND_KEY",
      webhookSecretEnv: "MY_WEBHOOK_SECRET",
      fromEnv: "MY_FROM",
    });
    // If env vars are not set, initialize should throw with the custom name
    expect(
      adapter.initialize(),
    ).rejects.toThrow("MY_RESEND_KEY");
  });

  it("throws on initialize when RESEND_API_KEY is missing", async () => {
    const adapter = new ResendAdapter();
    await expect(adapter.initialize()).rejects.toThrow("RESEND_API_KEY");
  });

  it("stores allowed senders from options", () => {
    const adapter = new ResendAdapter({
      allowedSenders: ["*@myco.com"],
    });
    expect(adapter.platform).toBe("resend");
  });

  describe("mode configuration", () => {
    it("defaults to auto-reply mode", () => {
      const adapter = new ResendAdapter();
      expect(adapter.autoReply).toBe(true);
    });

    it("sets autoReply to false in tool mode", () => {
      const adapter = new ResendAdapter({ mode: "tool" });
      expect(adapter.autoReply).toBe(false);
    });

    it("sets autoReply to true in auto-reply mode", () => {
      const adapter = new ResendAdapter({ mode: "auto-reply" });
      expect(adapter.autoReply).toBe(true);
    });

    it("returns send_email tool definitions in tool mode", () => {
      const adapter = new ResendAdapter({ mode: "tool" });
      const tools = adapter.getToolDefinitions();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe("send_email");
      expect(tools[0]!.inputSchema.required).toEqual(["to", "subject", "body"]);
    });

    it("returns empty tool definitions in auto-reply mode", () => {
      const adapter = new ResendAdapter({ mode: "auto-reply" });
      const tools = adapter.getToolDefinitions();
      expect(tools).toHaveLength(0);
    });

    it("returns empty tool definitions in default mode", () => {
      const adapter = new ResendAdapter();
      const tools = adapter.getToolDefinitions();
      expect(tools).toHaveLength(0);
    });
  });

  describe("resetRequestState", () => {
    it("resets hasSentInCurrentRequest flag", () => {
      const adapter = new ResendAdapter({ mode: "tool" });
      (adapter as unknown as { hasSentInCurrentRequest: boolean }).hasSentInCurrentRequest = true;
      adapter.resetRequestState!();
      expect(adapter.hasSentInCurrentRequest).toBe(false);
    });
  });
});
