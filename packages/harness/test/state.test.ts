import { describe, expect, it } from "vitest";
import { createStateStore } from "../src/state.js";

describe("state store factory", () => {
  it("uses memory provider when explicitly requested", async () => {
    const store = createStateStore({ provider: "memory", ttl: 60 });
    await store.set({
      runId: "run_memory",
      messages: [{ role: "user", content: "hello" }],
      updatedAt: Date.now(),
    });
    const value = await store.get("run_memory");
    expect(value?.runId).toBe("run_memory");
  });

  it("falls back gracefully when external provider is not configured", async () => {
    const store = createStateStore({ provider: "upstash", ttl: 60 });
    await store.set({
      runId: "run_fallback",
      messages: [{ role: "user", content: "hello" }],
      updatedAt: Date.now(),
    });
    const value = await store.get("run_fallback");
    expect(value?.runId).toBe("run_fallback");
  });
});
