// ---------------------------------------------------------------------------
// edit_file tool – targeted string replacement in VFS files.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { IFileSystem } from "just-bash";

export const createEditFileTool = (
  getFs: (tenantId: string) => IFileSystem,
): ToolDefinition => defineTool({
  name: "edit_file",
  description:
    "Edit a file by replacing an exact string match with new content. " +
    "The old_str must match exactly one location in the file. " +
    "Use an empty new_str to delete matched content. " +
    "Use read_file first to see current content before editing.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path of the file to edit",
      },
      old_str: {
        type: "string",
        description:
          "The exact text to find and replace (must be unique in the file). " +
          "Include surrounding context if needed to ensure uniqueness.",
      },
      new_str: {
        type: "string",
        description: "The replacement text (use empty string to delete the matched content)",
      },
    },
    required: ["path", "old_str", "new_str"],
    additionalProperties: false,
  },
  handler: async (input, context) => {
    const filePath = typeof input.path === "string" ? input.path.trim() : "";
    const oldStr = typeof input.old_str === "string" ? input.old_str : "";
    const newStr = typeof input.new_str === "string" ? input.new_str : "";

    if (!filePath) throw new Error("path is required");
    if (!oldStr) throw new Error("old_str must not be empty");

    const tenantId = context.tenantId ?? "__default__";
    const fs = getFs(tenantId);

    if (!(await fs.exists(filePath))) throw new Error(`File not found: ${filePath}`);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory) throw new Error(`${filePath} is a directory`);

    const content = await fs.readFile(filePath);

    const first = content.indexOf(oldStr);
    if (first === -1) {
      throw new Error(
        "old_str not found in file. Make sure it matches exactly, including whitespace and line breaks.",
      );
    }
    const last = content.lastIndexOf(oldStr);
    if (first !== last) {
      throw new Error(
        "old_str appears multiple times in the file. Include more surrounding context to ensure a unique match.",
      );
    }

    const updated = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
    await fs.writeFile(filePath, updated);

    return { ok: true, path: filePath };
  },
});
