import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import { PONCHO_DOCS } from "./generated/poncho-docs.js";

const resolveSafePath = (workingDir: string, inputPath: string): string => {
  const base = resolve(workingDir);
  const target = resolve(base, inputPath);
  if (target === base || target.startsWith(`${base}${sep}`)) {
    return target;
  }
  throw new Error("Access denied: path must stay inside the working directory.");
};

export const createDefaultTools = (workingDir: string): ToolDefinition[] => [
  defineTool({
    name: "list_directory",
    description: "List files and folders at a path",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to working directory",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const path = typeof input.path === "string" ? input.path : ".";
      const resolved = resolveSafePath(workingDir, path);
      const entries = await readdir(resolved, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }));
    },
  }),
  defineTool({
    name: "read_file",
    description: "Read UTF-8 text file contents",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to working directory",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const path = typeof input.path === "string" ? input.path : "";
      const resolved = resolveSafePath(workingDir, path);
      const content = await readFile(resolved, "utf8");
      return { path, content };
    },
  }),
];

export const createWriteTool = (workingDir: string): ToolDefinition =>
  defineTool({
    name: "write_file",
    description: "Write UTF-8 text file contents (create or overwrite)",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to working directory",
        },
        content: {
          type: "string",
          description: "Text content to write",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const path = typeof input.path === "string" ? input.path : "";
      const content = typeof input.content === "string" ? input.content : "";
      const resolved = resolveSafePath(workingDir, path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf8");
      return { path, written: true };
    },
  });

export const createEditTool = (workingDir: string): ToolDefinition =>
  defineTool({
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string match with new content. " +
      "The old_str must match exactly one location in the file (including whitespace and indentation). " +
      "Use an empty new_str to delete matched content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to working directory",
        },
        old_str: {
          type: "string",
          description:
            "The exact text to find and replace (must be unique in the file). " +
            "Include surrounding context lines if needed to ensure uniqueness.",
        },
        new_str: {
          type: "string",
          description: "The replacement text (use empty string to delete the matched content)",
        },
      },
      required: ["path", "old_str", "new_str"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const path = typeof input.path === "string" ? input.path : "";
      const oldStr = typeof input.old_str === "string" ? input.old_str : "";
      const newStr = typeof input.new_str === "string" ? input.new_str : "";
      if (!oldStr) throw new Error("old_str must not be empty.");
      const resolved = resolveSafePath(workingDir, path);
      const content = await readFile(resolved, "utf8");
      const first = content.indexOf(oldStr);
      if (first === -1) {
        throw new Error(
          "old_str not found in file. Make sure it matches exactly, including whitespace and line breaks.",
        );
      }
      const last = content.lastIndexOf(oldStr);
      if (first !== last) {
        throw new Error(
          "old_str appears multiple times in the file. Please provide more context to ensure a unique match.",
        );
      }
      const newContent = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
      await writeFile(resolved, newContent, "utf8");
      return { path, edited: true };
    },
  });

export const createDeleteTool = (workingDir: string): ToolDefinition =>
  defineTool({
    name: "delete_file",
    description: "Delete a file at a path inside the working directory",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to working directory",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const path = typeof input.path === "string" ? input.path : "";
      const resolved = resolveSafePath(workingDir, path);
      await unlink(resolved);
      return { path, deleted: true };
    },
  });

export const createDeleteDirectoryTool = (workingDir: string): ToolDefinition =>
  defineTool({
    name: "delete_directory",
    description: "Recursively delete a directory and all its contents inside the working directory",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to working directory",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const path = typeof input.path === "string" ? input.path : "";
      if (!path) throw new Error("Path must not be empty.");
      const resolved = resolveSafePath(workingDir, path);
      if (resolved === resolve(workingDir)) {
        throw new Error("Cannot delete the working directory root.");
      }
      await rm(resolved, { recursive: true });
      return { path, deleted: true };
    },
  });

const PONCHO_DOCS_TOPICS = Object.keys(PONCHO_DOCS);

export const ponchoDocsTool: ToolDefinition = defineTool({
  name: "poncho_docs",
  description:
    "Read detailed Poncho framework documentation by topic. " +
    `Available topics: ${PONCHO_DOCS_TOPICS.join(", ")}.`,
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: PONCHO_DOCS_TOPICS,
        description: "Documentation topic to read",
      },
    },
    required: ["topic"],
    additionalProperties: false,
  },
  handler: async (input) => {
    const topic = typeof input.topic === "string" ? input.topic : "";
    const content = PONCHO_DOCS[topic];
    if (!content) {
      return { error: `Unknown topic "${topic}". Available: ${PONCHO_DOCS_TOPICS.join(", ")}` };
    }
    return { topic, content };
  },
});