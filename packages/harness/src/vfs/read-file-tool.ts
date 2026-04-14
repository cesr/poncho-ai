// ---------------------------------------------------------------------------
// read_file tool – read files from the filesystem, returning binary files
// (images, PDFs) as inline base64 media parts.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { IFileSystem } from "just-bash";

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
  getFs: (tenantId: string) => IFileSystem,
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
    const fs = getFs(tenantId);

    if (!(await fs.exists(filePath))) {
      throw new Error(`File not found: ${filePath}`);
    }
    const stat = await fs.stat(filePath);
    if (stat.isDirectory) {
      throw new Error(`${filePath} is a directory, not a file`);
    }

    const mediaType = mimeFromPath(filePath) ?? "application/octet-stream";
    const filename = filePath.split("/").pop() ?? filePath;

    // Text files: read and return inline
    if (isTextMime(mediaType)) {
      const text = await fs.readFile(filePath);
      return { filename, mediaType, content: text };
    }

    // Binary files (images, PDFs): read bytes and return as base64
    const buf = await fs.readFileBuffer(filePath);
    return {
      type: "file",
      data: Buffer.from(buf).toString("base64"),
      mediaType,
      filename,
    };
  },
});
