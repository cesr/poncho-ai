import { describe, expect, it, vi } from "vitest";
import { TelemetryEmitter } from "../src/telemetry.js";

describe("telemetry emitter", () => {
  it("delegates to custom handler when configured", async () => {
    const handler = vi.fn();
    const emitter = new TelemetryEmitter({ handler });
    await emitter.emit({ type: "step:started", step: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not throw when exporters fail", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    const emitter = new TelemetryEmitter({
      otlp: "https://otel.example.com/v1/logs",
      latitude: { apiKey: "lat_test" },
    });

    await expect(
      emitter.emit({ type: "step:completed", step: 1, duration: 1 }),
    ).resolves.toBeUndefined();

    global.fetch = originalFetch;
  });

  it("does not send to latitude custom endpoint (handled by LatitudeTelemetry)", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    const emitter = new TelemetryEmitter({
      latitude: {
        apiKey: "lat_test",
        projectId: "proj_123",
        documentPath: "agents/support-agent/AGENT.md",
      },
    });

    await emitter.emit({ type: "step:started", step: 2 });

    expect(fetchMock).not.toHaveBeenCalled();

    global.fetch = originalFetch;
  });
});
