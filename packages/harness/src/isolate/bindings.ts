// ---------------------------------------------------------------------------
// Isolate Bindings – factory functions that create IsolateBinding objects
// for VFS operations, scoped fetch, and builder custom bindings.
// ---------------------------------------------------------------------------

import type { IsolateBinding, IsolateConfig } from "../config.js";
import type { PonchoFsAdapter } from "../vfs/poncho-fs-adapter.js";

// ---------------------------------------------------------------------------
// VFS bindings (created per-invocation with a tenant-scoped adapter)
// ---------------------------------------------------------------------------

export function createVfsBindings(
  adapter: PonchoFsAdapter,
): Record<string, IsolateBinding> {
  return {
    fs_read: {
      description: "Read a text file from the VFS",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path in the VFS" } },
        required: ["path"],
      },
      handler: async (input) => {
        const content = await adapter.readFile(input.path as string);
        return content;
      },
    },

    fs_write: {
      description: "Write a text file to the VFS",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path in the VFS" },
          content: { type: "string", description: "Text content to write" },
        },
        required: ["path", "content"],
      },
      handler: async (input) => {
        await adapter.writeFile(input.path as string, input.content as string);
      },
    },

    fs_read_binary: {
      description: "Read a binary file from the VFS (returns base64)",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path in the VFS" } },
        required: ["path"],
      },
      handler: async (input) => {
        const buf = await adapter.readFileBuffer(input.path as string);
        return Buffer.from(buf).toString("base64");
      },
    },

    fs_write_binary: {
      description: "Write a binary file to the VFS (content is base64-encoded)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path in the VFS" },
          content: { type: "string", description: "Base64-encoded binary content" },
        },
        required: ["path", "content"],
      },
      handler: async (input) => {
        const buf = Buffer.from(input.content as string, "base64");
        await adapter.writeFile(input.path as string, buf);
      },
    },

    fs_list: {
      description: "List files and directories at a path",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path in the VFS" } },
        required: ["path"],
      },
      handler: async (input) => {
        return await adapter.readdir(input.path as string);
      },
    },

    fs_exists: {
      description: "Check if a file or directory exists",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path in the VFS" } },
        required: ["path"],
      },
      handler: async (input) => {
        return await adapter.exists(input.path as string);
      },
    },

    fs_delete: {
      description: "Delete a file or directory",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path in the VFS" } },
        required: ["path"],
      },
      handler: async (input) => {
        await adapter.rm(input.path as string, { force: true });
      },
    },

    fs_mkdir: {
      description: "Create a directory (recursive)",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path to create" } },
        required: ["path"],
      },
      handler: async (input) => {
        await adapter.mkdir(input.path as string, { recursive: true });
      },
    },

    fs_stat: {
      description: "Get file/directory metadata (size, type, mtime)",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path in the VFS" } },
        required: ["path"],
      },
      handler: async (input) => {
        const stat = await adapter.stat(input.path as string);
        return {
          isFile: stat.isFile,
          isDirectory: stat.isDirectory,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Scoped fetch binding (created once at registration time)
// ---------------------------------------------------------------------------

export function createFetchBinding(
  allowedDomains: string[],
): IsolateBinding {
  const domainSet = new Set(allowedDomains.map((d) => d.toLowerCase()));

  return {
    description: `HTTP fetch restricted to: ${allowedDomains.join(", ")}`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        method: { type: "string", description: "HTTP method (default: GET)" },
        headers: {
          type: "object",
          description: "Request headers",
          additionalProperties: { type: "string" },
        },
        body: { type: "string", description: "Request body" },
      },
      required: ["url"],
    },
    handler: async (input) => {
      const url = new URL(input.url as string);
      if (!domainSet.has(url.hostname.toLowerCase())) {
        throw new Error(
          `Fetch blocked: domain "${url.hostname}" is not in the allowed list [${allowedDomains.join(", ")}]`,
        );
      }

      const resp = await fetch(input.url as string, {
        method: (input.method as string) ?? "GET",
        headers: (input.headers as Record<string, string>) ?? undefined,
        body: (input.body as string) ?? undefined,
        redirect: "manual",
      });

      const body = await resp.text();
      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });

      return { status: resp.status, headers, body };
    },
  };
}

// ---------------------------------------------------------------------------
// Builder custom bindings (adapt from config format)
// ---------------------------------------------------------------------------

export function mergeBuilderBindings(
  configBindings: NonNullable<IsolateConfig["bindings"]>,
): Record<string, IsolateBinding> {
  // Config bindings are already in IsolateBinding format
  return { ...configBindings };
}
