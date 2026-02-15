/**
 * Latitude telemetry integration for Vercel AI SDK
 *
 * TODO: Implement proper Vercel AI SDK telemetry integration using:
 * - LatitudeTelemetry.capture() wrapper around streamText()
 * - experimental_telemetry: { isEnabled: true } in streamText() options
 *
 * This requires @latitude-data/telemetry package which has official
 * Vercel AI SDK support.
 */

export interface LatitudeCaptureConfig {
  apiKey?: string;
  projectId?: string | number;
  path?: string;
  defaultPath?: string;
}

/**
 * Placeholder for Latitude telemetry integration
 * This will be properly implemented once Vercel AI SDK migration is complete
 */
export class LatitudeCapture {
  private readonly apiKey?: string;
  private readonly projectId?: number;
  private readonly path?: string;

  constructor(config?: LatitudeCaptureConfig) {
    this.apiKey = config?.apiKey ?? process.env.LATITUDE_API_KEY;

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
    this.path = rawPath;
  }

  isConfigured(): boolean {
    return !!(this.apiKey && this.projectId && this.path);
  }

  getConfig() {
    return {
      apiKey: this.apiKey,
      projectId: this.projectId,
      path: this.path,
    };
  }
}
