import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import Busboy from "busboy";
import type { FileInput } from "@poncho-ai/sdk";
import type { AgentEvent } from "@poncho-ai/sdk";

export const writeJson = (response: ServerResponse, statusCode: number, payload: unknown) => {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
};

export const writeHtml = (response: ServerResponse, statusCode: number, payload: string) => {
  response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  response.end(payload);
};

export const EXT_MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", txt: "text/plain",
  json: "application/json", csv: "text/csv", html: "text/html",
};
export const extToMime = (ext: string): string => EXT_MIME_MAP[ext] ?? "application/octet-stream";

export const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body.length > 0 ? (JSON.parse(body) as unknown) : {};
};

export const parseTelegramMessageThreadIdFromPlatformThreadId = (
  platformThreadId: string | undefined,
  chatId: string | undefined,
): number | undefined => {
  if (!platformThreadId || !chatId) return undefined;
  const parts = platformThreadId.split(":");
  if (parts.length !== 3 || parts[0] !== chatId) return undefined;
  const threadId = Number(parts[1]);
  return Number.isInteger(threadId) ? threadId : undefined;
};

export const MAX_UPLOAD_SIZE = 25 * 1024 * 1024; // 25MB per file

export interface ParsedMultipart {
  message: string;
  parameters?: Record<string, unknown>;
  files: FileInput[];
}

export const parseMultipartRequest = (request: IncomingMessage): Promise<ParsedMultipart> =>
  new Promise((resolve, reject) => {
    const result: ParsedMultipart = { message: "", files: [] };
    const bb = Busboy({
      headers: request.headers,
      limits: { fileSize: MAX_UPLOAD_SIZE },
    });

    bb.on("field", (name: string, value: string) => {
      if (name === "message") result.message = value;
      if (name === "parameters") {
        try {
          result.parameters = JSON.parse(value) as Record<string, unknown>;
        } catch { /* ignore malformed parameters */ }
      }
    });

    bb.on("file", (_name: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const buf = Buffer.concat(chunks);
        result.files.push({
          data: buf.toString("base64"),
          mediaType: info.mimeType,
          filename: info.filename,
        });
      });
    });

    bb.on("finish", () => resolve(result));
    bb.on("error", (err: Error) => reject(err));
    request.pipe(bb);
  });

/**
 * Detects the runtime environment from platform-specific or standard environment variables.
 * Priority: PONCHO_ENV > platform detection (Vercel, Railway, etc.) > NODE_ENV > "development"
 */
export const resolveHarnessEnvironment = (): "development" | "staging" | "production" => {
  // Check explicit Poncho environment variable first
  if (process.env.PONCHO_ENV) {
    const value = process.env.PONCHO_ENV.toLowerCase();
    if (value === "production" || value === "staging") {
      return value;
    }
    return "development";
  }

  // Detect platform-specific environment variables
  // Vercel
  if (process.env.VERCEL_ENV) {
    const vercelEnv = process.env.VERCEL_ENV.toLowerCase();
    if (vercelEnv === "production") return "production";
    if (vercelEnv === "preview") return "staging";
    return "development";
  }

  // Railway
  if (process.env.RAILWAY_ENVIRONMENT) {
    const railwayEnv = process.env.RAILWAY_ENVIRONMENT.toLowerCase();
    if (railwayEnv === "production") return "production";
    return "staging";
  }

  // Render
  if (process.env.RENDER) {
    // Render sets IS_PULL_REQUEST for preview deploys
    if (process.env.IS_PULL_REQUEST === "true") return "staging";
    return "production";
  }

  // AWS Lambda
  if (process.env.AWS_EXECUTION_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return "production";
  }

  // Fly.io
  if (process.env.FLY_APP_NAME) {
    return "production";
  }

  // Fall back to NODE_ENV
  if (process.env.NODE_ENV) {
    const value = process.env.NODE_ENV.toLowerCase();
    if (value === "production" || value === "staging") {
      return value;
    }
    return "development";
  }

  // Default to development
  return "development";
};

export const listenOnAvailablePort = async (
  server: Server,
  preferredPort: number,
): Promise<number> =>
  await new Promise<number>((resolveListen, rejectListen) => {
    let currentPort = preferredPort;

    const tryListen = (): void => {
      const onListening = (): void => {
        server.off("error", onError);
        const address = server.address();
        if (address && typeof address === "object" && typeof address.port === "number") {
          resolveListen(address.port);
          return;
        }
        resolveListen(currentPort);
      };

      const onError = (error: unknown): void => {
        server.off("listening", onListening);
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "EADDRINUSE"
        ) {
          currentPort += 1;
          if (currentPort > 65535) {
            rejectListen(
              new Error(
                "No available ports found from the requested port up to 65535.",
              ),
            );
            return;
          }
          setImmediate(tryListen);
          return;
        }
        rejectListen(error);
      };

      server.once("listening", onListening);
      server.once("error", onError);
      server.listen(currentPort);
    };

    tryListen();
  });

export const readJsonFile = async <T>(path: string): Promise<T | undefined> => {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
};

export const parseParams = (values: string[]): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const value of values) {
    const [key, ...rest] = value.split("=");
    if (!key) {
      continue;
    }
    params[key] = rest.join("=");
  }
  return params;
};

export const formatSseEvent = (event: AgentEvent): string =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
