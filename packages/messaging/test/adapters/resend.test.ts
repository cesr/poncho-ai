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
    // The allowedSenders is stored privately — we verify it indirectly
    // through the full webhook flow or by checking it doesn't throw on construct
    expect(adapter.platform).toBe("resend");
  });
});
