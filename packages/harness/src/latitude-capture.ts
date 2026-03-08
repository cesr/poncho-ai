export interface LatitudeCaptureConfig {
  apiKeyEnv?: string;
  projectIdEnv?: string;
  path?: string;
  defaultPath?: string;
}

/**
 * Reads and validates Latitude telemetry configuration from environment
 * variables. The actual telemetry capture is handled by LatitudeTelemetry
 * from @latitude-data/telemetry in harness.ts (via runWithTelemetry).
 */
export class LatitudeCapture {
  private readonly apiKey?: string;
  private readonly projectId?: number;
  private readonly path?: string;

  constructor(config?: LatitudeCaptureConfig) {
    const apiKeyEnv = config?.apiKeyEnv ?? "LATITUDE_API_KEY";
    this.apiKey = process.env[apiKeyEnv];

    const projectIdEnv = config?.projectIdEnv ?? "LATITUDE_PROJECT_ID";
    const rawProjectId = process.env[projectIdEnv];
    const projectIdNumber = rawProjectId
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
