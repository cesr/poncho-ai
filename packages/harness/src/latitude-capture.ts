export interface LatitudeCaptureConfig {
  apiKey?: string;
  projectId?: string | number;
  path?: string;
  defaultPath?: string;
}

const sanitizePath = (value: string): string =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9\-_/\.]/g, "-")
    .replace(/-+/g, "-");

export class LatitudeCapture {
  private readonly apiKey?: string;
  private telemetryPromise?: Promise<
    | {
        capture: <T>(
          context: { projectId: number; path: string },
          fn: () => Promise<T>,
        ) => Promise<T>;
      }
    | undefined
  >;
  private readonly projectId?: number;
  private readonly path?: string;

  constructor(config?: LatitudeCaptureConfig) {
    this.apiKey = config?.apiKey ?? process.env.LATITUDE_API_KEY;
    if (!this.apiKey) {
      return;
    }

    const rawProjectId = config?.projectId ?? process.env.LATITUDE_PROJECT_ID;
    const projectIdNumber =
      typeof rawProjectId === "number"
        ? rawProjectId
        : rawProjectId
          ? Number.parseInt(rawProjectId, 10)
          : Number.NaN;
    this.projectId = Number.isFinite(projectIdNumber) ? projectIdNumber : undefined;
    const rawPath =
      config?.path ??
      process.env.LATITUDE_PATH ??
      process.env.LATITUDE_DOCUMENT_PATH ??
      config?.defaultPath;
    this.path = rawPath ? sanitizePath(rawPath) : undefined;
  }

  private async initializeTelemetry(): Promise<
    | {
        capture: <T>(
          context: { projectId: number; path: string },
          fn: () => Promise<T>,
        ) => Promise<T>;
      }
    | undefined
  > {
    if (!this.apiKey) {
      return undefined;
    }
    try {
      const [{ LatitudeTelemetry }, AnthropicSdk, { default: OpenAI }] = await Promise.all([
        import("@latitude-data/telemetry"),
        import("@anthropic-ai/sdk"),
        import("openai"),
      ]);
      const disableAnthropicInstrumentation =
        process.env.LATITUDE_DISABLE_ANTHROPIC_INSTRUMENTATION === "true";
      return new LatitudeTelemetry(this.apiKey, {
        instrumentations: {
          ...(disableAnthropicInstrumentation
            ? {}
            : { anthropic: AnthropicSdk as unknown }),
          openai: OpenAI as unknown,
        },
      });
    } catch {
      // If instrumentation setup fails, skip Latitude capture and run normally.
      return undefined;
    }
  }

  async capture<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.apiKey || !this.projectId || !this.path) {
      return await fn();
    }
    if (!this.telemetryPromise) {
      this.telemetryPromise = this.initializeTelemetry();
    }
    const telemetry = await this.telemetryPromise;
    if (!telemetry) {
      return await fn();
    }
    try {
      return await telemetry.capture(
        {
          projectId: this.projectId,
          path: this.path,
        },
        fn,
      );
    } catch {
      // Telemetry must never break runtime model calls.
      return await fn();
    }
  }
}
