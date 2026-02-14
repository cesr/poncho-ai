import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";

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
