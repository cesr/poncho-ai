import type { AgentEvent } from "@poncho-ai/sdk";

const MAX_FIELD_LENGTH = 200;

function sanitizeEventForLog(event: AgentEvent): string {
  return JSON.stringify(event, (_key, value) => {
    if (typeof value === "string" && value.length > MAX_FIELD_LENGTH) {
      return `${value.slice(0, 80)}...[${value.length} chars]`;
    }
    return value;
  });
}

export interface OtlpConfig {
  url: string;
  headers?: Record<string, string>;
}

export type OtlpOption = string | OtlpConfig;

const TRACES_PATH = "/v1/traces";

/**
 * Ensures the OTLP URL points to the trace-ingest endpoint.
 *
 * Users typically configure the *base* OTLP endpoint (e.g.
 * `https://gateway.example.com/api/v1/otlp`) but `OTLPTraceExporter` uses
 * the `url` constructor option as-is — it only appends `/v1/traces`
 * automatically when reading from the `OTEL_EXPORTER_OTLP_ENDPOINT` env var.
 * Without this fixup traces are POSTed to the wrong path and silently lost.
 */
function ensureTracesPath(url: string): string {
  if (url.endsWith(TRACES_PATH)) return url;
  return url.replace(/\/+$/, "") + TRACES_PATH;
}

export function normalizeOtlp(opt: OtlpOption | undefined): OtlpConfig | undefined {
  if (!opt) return undefined;
  if (typeof opt === "string") return opt ? { url: ensureTracesPath(opt) } : undefined;
  return opt.url ? { ...opt, url: ensureTracesPath(opt.url) } : undefined;
}

export interface TelemetryConfig {
  enabled?: boolean;
  otlp?: OtlpOption;
  handler?: (event: AgentEvent) => Promise<void> | void;
}

export class TelemetryEmitter {
  private readonly config: TelemetryConfig | undefined;

  constructor(config?: TelemetryConfig) {
    this.config = config;
  }

  async emit(event: AgentEvent): Promise<void> {
    if (this.config?.enabled === false) {
      return;
    }
    if (this.config?.handler) {
      await this.config.handler(event);
      return;
    }
    const otlp = normalizeOtlp(this.config?.otlp);
    if (otlp) {
      await this.sendOtlp(event, otlp);
    }
    // Default behavior in local dev: print concise structured logs.
    // Skip per-token stream logs to keep console output readable.
    if (event.type === "model:chunk") {
      return;
    }
    // Strip large binary payloads (e.g. base64 images) to keep logs readable.
    process.stdout.write(`[event] ${event.type} ${sanitizeEventForLog(event)}\n`);
  }

  private async sendOtlp(event: AgentEvent, otlp: OtlpConfig): Promise<void> {
    try {
      await fetch(otlp.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...otlp.headers },
        body: JSON.stringify({
          resourceLogs: [
            {
              scopeLogs: [
                {
                  logRecords: [
                    {
                      timeUnixNano: String(Date.now() * 1_000_000),
                      severityText: "INFO",
                      body: { stringValue: event.type },
                      attributes: [
                        {
                          key: "event.payload",
                          value: { stringValue: JSON.stringify(event) },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
    } catch (err) {
      console.warn(
        `[poncho][telemetry] OTLP log delivery failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

}
