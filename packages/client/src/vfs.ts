import type {
  ApiVfsListResponse,
  ApiVfsWriteResponse,
} from "@poncho-ai/sdk";
import type { BaseClient } from "./base.js";

const normalizePath = (p: string): string => (p.startsWith("/") ? p : `/${p}`);

const encodeVfsPath = (p: string): string =>
  p
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");

/**
 * Read a file from the agent's virtual filesystem.
 * Returns the raw Response so callers can handle binary content.
 */
export async function readFile(
  this: BaseClient,
  path: string,
): Promise<Response> {
  const response = await this.fetchImpl(
    `${this.baseUrl}/api/vfs/${encodeVfsPath(normalizePath(path))}`,
    {
      method: "GET",
      headers: this.headers(),
    },
  );
  if (!response.ok) {
    throw new Error(`VFS read failed: HTTP ${response.status}`);
  }
  return response;
}

/**
 * List the entries in a directory of the agent's VFS.
 */
export async function listDir(
  this: BaseClient,
  path = "/",
): Promise<ApiVfsListResponse> {
  const url = this.buildUrl("/api/vfs-list", { path: normalizePath(path) });
  return this.json<ApiVfsListResponse>(url);
}

/**
 * Write a file to the agent's VFS. Throws on conflict unless `overwrite` is true.
 *
 * `content` accepts string, Uint8Array, ArrayBuffer, or Blob. The provided
 * `contentType` (or `application/octet-stream`) is stored as the entry's mime.
 */
export async function writeFile(
  this: BaseClient,
  path: string,
  content: string | Uint8Array | ArrayBuffer | Blob,
  options?: { contentType?: string; overwrite?: boolean },
): Promise<ApiVfsWriteResponse> {
  const url =
    `${this.baseUrl}/api/vfs/${encodeVfsPath(normalizePath(path))}` +
    (options?.overwrite ? "?overwrite=1" : "");
  const headers: Record<string, string> = {
    ...(this.headers() as Record<string, string>),
    "Content-Type": options?.contentType ?? "application/octet-stream",
  };
  const response = await this.fetchImpl(url, {
    method: "PUT",
    headers,
    body: content as BodyInit,
  });
  if (!response.ok) {
    let payload: Record<string, unknown> = {};
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {}
    const error = new Error(
      (payload.message as string) ?? `VFS write failed: HTTP ${response.status}`,
    ) as Error & { status: number; payload: Record<string, unknown> };
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return (await response.json()) as ApiVfsWriteResponse;
}

/**
 * Delete a file or directory from the agent's VFS. Directories are removed
 * recursively.
 */
export async function deleteFile(this: BaseClient, path: string): Promise<void> {
  const url = `${this.baseUrl}/api/vfs/${encodeVfsPath(normalizePath(path))}`;
  const response = await this.fetchImpl(url, {
    method: "DELETE",
    headers: this.headers(),
  });
  if (!response.ok) {
    let payload: Record<string, unknown> = {};
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {}
    const error = new Error(
      (payload.message as string) ?? `VFS delete failed: HTTP ${response.status}`,
    ) as Error & { status: number; payload: Record<string, unknown> };
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
}

/**
 * Create a directory in the agent's VFS. Parent directories are created as
 * needed.
 */
export async function mkdir(this: BaseClient, path: string): Promise<void> {
  await this.json("/api/vfs-mkdir", {
    method: "POST",
    body: JSON.stringify({ path: normalizePath(path) }),
  });
}
