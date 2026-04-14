// ---------------------------------------------------------------------------
// write_file tool – create or overwrite a file in the filesystem.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { IFileSystem } from "just-bash";

export const createWriteFileTool = (
  getFs: (tenantId: string) => IFileSystem,
): ToolDefinition => defineTool({
  name: "write_file",
  description:
    "Create a new file or overwrite an existing file in the virtual filesystem. " +
    "Parent directories are created automatically. " +
    "Prefer edit_file for targeted changes to existing files.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path of the file to write (e.g. /data/output.json)",
      },
      content: {
        type: "string",
        description: "The full content to write to the file",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  handler: async (input, context) => {
    const filePath = typeof input.path === "string" ? input.path.trim() : "";
    const content = typeof input.content === "string" ? input.content : "";

    if (!filePath) throw new Error("path is required");

    const tenantId = context.tenantId ?? "__default__";
    const fs = getFs(tenantId);

    // Create parent directories
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));
    if (dir) {
      await fs.mkdir(dir, { recursive: true });
    }

    await fs.writeFile(filePath, content);

    return { ok: true, path: filePath };
  },
});
