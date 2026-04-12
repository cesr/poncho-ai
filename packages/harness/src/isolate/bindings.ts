// ---------------------------------------------------------------------------
// Isolate Bindings – factory functions that create IsolateBinding objects
// for VFS operations, scoped fetch, and builder custom bindings.
//
// All bindings use __poncho_ prefix to avoid colliding with the standard
// API polyfills that wrap them (see polyfills.ts).
// ---------------------------------------------------------------------------

import type { IsolateBinding, IsolateConfig, NetworkConfig } from "../config.js";
import type { PonchoFsAdapter } from "../vfs/poncho-fs-adapter.js";

// ---------------------------------------------------------------------------
// VFS bindings (created per-invocation with a tenant-scoped adapter)
// ---------------------------------------------------------------------------

export function createVfsBindings(
  adapter: PonchoFsAdapter,
): Record<string, IsolateBinding> {
  return {
    __poncho_fs_read: {
      description: "Read a text file from the VFS",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async (input) => {
        return await adapter.readFile(input.path as string);
      },
    },

    __poncho_fs_write: {
      description: "Write a text file to the VFS",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      handler: async (input) => {
        await adapter.writeFile(input.path as string, input.content as string);
      },
    },

    __poncho_fs_read_binary: {
      description: "Read a binary file (returns base64)",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async (input) => {
        const buf = await adapter.readFileBuffer(input.path as string);
        return Buffer.from(buf).toString("base64");
      },
    },

    __poncho_fs_write_binary: {
      description: "Write a binary file (content is base64)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      handler: async (input) => {
        const buf = Buffer.from(input.content as string, "base64");
        await adapter.writeFile(input.path as string, buf);
      },
    },

    __poncho_fs_list: {
      description: "List directory entries",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async (input) => {
        return await adapter.readdir(input.path as string);
      },
    },

    __poncho_fs_exists: {
      description: "Check if path exists",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async (input) => {
        return await adapter.exists(input.path as string);
      },
    },

    __poncho_fs_delete: {
      description: "Delete a file or directory",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async (input) => {
        await adapter.rm(input.path as string, { force: true });
      },
    },

    __poncho_fs_mkdir: {
      description: "Create a directory (recursive)",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async (input) => {
        await adapter.mkdir(input.path as string, { recursive: true });
      },
    },

    __poncho_fs_stat: {
      description: "Get file metadata",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
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
  network?: NetworkConfig,
): IsolateBinding {
  const allowAll = network?.dangerouslyAllowAll === true;
  const domainSet = new Set(allowedDomains.map((d) => d.toLowerCase()));

  return {
    description: "Internal fetch binding",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string" },
        binary: { type: "boolean" },
      },
      required: ["url"],
    },
    handler: async (input) => {
      const url = new URL(input.url as string);
      if (!allowAll && !domainSet.has(url.hostname.toLowerCase())) {
        throw new Error(
          `Fetch blocked: domain "${url.hostname}" is not in the allowed list [${allowedDomains.join(", ")}]`,
        );
      }

      const resp = await fetch(input.url as string, {
        method: (input.method as string) ?? "GET",
        headers: (input.headers as Record<string, string>) ?? undefined,
        body: (input.body as string) ?? undefined,
        redirect: "follow",
      });

      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });

      if (input.binary) {
        const buf = await resp.arrayBuffer();
        const base64 = Buffer.from(buf).toString("base64");
        return { status: resp.status, statusText: resp.statusText, headers, body: base64, encoding: "base64" };
      }

      const body = await resp.text();
      return { status: resp.status, statusText: resp.statusText, headers, body };
    },
  };
}

// ---------------------------------------------------------------------------
// Builder custom bindings (adapt from config format)
// ---------------------------------------------------------------------------

export function mergeBuilderBindings(
  configBindings: NonNullable<IsolateConfig["bindings"]>,
): Record<string, IsolateBinding> {
  return { ...configBindings };
}
