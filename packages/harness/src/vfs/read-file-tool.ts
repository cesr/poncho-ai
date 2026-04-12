// ---------------------------------------------------------------------------
// read_file tool – read files from the VFS, returning binary files (images,
// PDFs) as FileContentPart references that the harness resolves lazily at
// model-request time via the vfs:// scheme.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { StorageEngine } from "../storage/engine.js";
import { VFS_SCHEME } from "../upload-store.js";

const MIME_MAP: Record<string, string> = {
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".ts": "text/typescript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".py": "text/x-python",
  ".sh": "application/x-sh",
  ".sql": "application/sql",
};

const mimeFromPath = (path: string): string | undefined => {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  return MIME_MAP[path.slice(dot).toLowerCase()];
};

const isTextMime = (mime: string): boolean =>
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime === "application/xml" ||
  mime === "application/sql" ||
  mime === "application/javascript" ||
  mime === "application/x-sh";

export const createReadFileTool = (
  engine: StorageEngine,
): ToolDefinition => defineTool({
  name: "read_file",
  description:
    "Read a file from the virtual filesystem. " +
    "Returns text content for text-based files, or sends images and PDFs " +
    "directly to the model for visual analysis.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path of the file to read (e.g. /data/report.pdf, /screenshots/page.png)",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  handler: async (input, context) => {
    const filePath = typeof input.path === "string" ? input.path.trim() : "";
    if (!filePath) {
      throw new Error("path is required");
    }

    const tenantId = context.tenantId ?? "__default__";
    const stat = await engine.vfs.stat(tenantId, filePath);
    if (!stat) {
      throw new Error(`File not found: ${filePath}`);
    }
    if (stat.type === "directory") {
      throw new Error(`${filePath} is a directory, not a file`);
    }

    const mediaType = stat.mimeType ?? mimeFromPath(filePath) ?? "application/octet-stream";
    const filename = filePath.split("/").pop() ?? filePath;

    // Text files: read and return inline
    if (isTextMime(mediaType)) {
      const buf = await engine.vfs.readFile(tenantId, filePath);
      const text = Buffer.from(buf).toString("utf8");
      return { filename, mediaType, content: text };
    }

    // Images and PDFs: return a vfs:// reference that the harness resolves
    // lazily at model-request time — the actual bytes never sit in context.
    return {
      type: "file",
      data: `${VFS_SCHEME}${filePath}`,
      mediaType,
      filename,
    };
  },
});
