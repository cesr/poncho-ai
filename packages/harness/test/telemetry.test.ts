import { describe, expect, it, vi } from "vitest";
import { TelemetryEmitter, normalizeOtlp } from "../src/telemetry.js";

describe("normalizeOtlp", () => {
  it("appends /v1/traces to a base URL string", () => {
    expect(normalizeOtlp("https://gateway.example.com/api/v1/otlp")).toEqual({
      url: "https://gateway.example.com/api/v1/otlp/v1/traces",
    });
  });

  it("does not double-append when URL already ends with /v1/traces", () => {
    expect(normalizeOtlp("https://api.honeycomb.io/v1/traces")).toEqual({
      url: "https://api.honeycomb.io/v1/traces",
    });
  });

  it("strips trailing slashes before appending", () => {
    expect(normalizeOtlp("https://gateway.example.com/")).toEqual({
      url: "https://gateway.example.com/v1/traces",
    });
  });

  it("appends /v1/traces to object config", () => {
    expect(
      normalizeOtlp({
        url: "https://gateway.example.com/otlp",
        headers: { Authorization: "Bearer tok" },
      }),
    ).toEqual({
      url: "https://gateway.example.com/otlp/v1/traces",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns undefined for falsy input", () => {
    expect(normalizeOtlp(undefined)).toBeUndefined();
    expect(normalizeOtlp("")).toBeUndefined();
  });
});

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
      otlp: "https://otel.example.com/v1/traces",
    });

    await expect(
      emitter.emit({ type: "step:completed", step: 1, duration: 1 }),
    ).resolves.toBeUndefined();

    global.fetch = originalFetch;
  });
});
