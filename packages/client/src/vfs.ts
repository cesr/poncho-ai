import type { BaseClient } from "./base.js";

/**
 * Read a file from the agent's virtual filesystem.
 * Returns the raw Response so callers can handle binary content.
 */
export async function readFile(
  this: BaseClient,
  path: string,
): Promise<Response> {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const response = await this.fetchImpl(
    `${this.baseUrl}/api/vfs${normalizedPath}`,
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
