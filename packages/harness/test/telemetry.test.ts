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
    });

    await expect(
      emitter.emit({ type: "step:completed", step: 1, duration: 1 }),
    ).resolves.toBeUndefined();

    global.fetch = originalFetch;
  });
});
