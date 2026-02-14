import type { AgentEvent } from "@poncho-ai/sdk";

export interface TelemetryConfig {
  enabled?: boolean;
  otlp?: string;
  latitude?: {
    apiKey?: string;
    projectId?: string | number;
    path?: string;
    documentPath?: string;
  };
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
    if (this.config?.otlp) {
      await this.sendOtlp(event);
    }
    if (this.config?.latitude?.apiKey) {
      await this.sendLatitude(event);
    }
    // Default behavior in local dev: print concise structured logs.
    process.stdout.write(`[event] ${event.type} ${JSON.stringify(event)}\n`);
  }

  private async sendOtlp(event: AgentEvent): Promise<void> {
    const endpoint = this.config?.otlp;
    if (!endpoint) {
      return;
    }
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    } catch {
      // Ignore telemetry delivery failures.
    }
  }

  private async sendLatitude(event: AgentEvent): Promise<void> {
    const apiKey = this.config?.latitude?.apiKey;
    if (!apiKey) {
      return;
    }
    const projectId =
      this.config?.latitude?.projectId ?? process.env.LATITUDE_PROJECT_ID;
    const path = this.config?.latitude?.path ?? process.env.LATITUDE_PATH;
    const documentPath =
      this.config?.latitude?.documentPath ?? process.env.LATITUDE_DOCUMENT_PATH;
    try {
      await fetch("https://api.latitude.so/v1/telemetry/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          type: event.type,
          payload: event,
          timestamp: Date.now(),
          projectId,
          path,
          documentPath,
        }),
      });
    } catch {
      // Ignore telemetry delivery failures.
    }
  }
}
