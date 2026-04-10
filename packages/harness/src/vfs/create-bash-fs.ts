// ---------------------------------------------------------------------------
// createBashFs – assembles MountableFs with VFS root + optional /project mount.
// ---------------------------------------------------------------------------

import type { IFileSystem } from "just-bash";
import { MountableFs, ReadWriteFs } from "just-bash";
import type { PonchoFsAdapter } from "./poncho-fs-adapter.js";
import { ProtectedFs } from "./protected-fs.js";

/**
 * Create the filesystem tree for the bash environment.
 *
 * - Production: VFS only (no project access).
 * - Development: VFS root + real project files at /project.
 */
export function createBashFs(
  adapter: PonchoFsAdapter,
  workingDir: string | null,
): IFileSystem {
  if (!workingDir) {
    // Prod: VFS only
    return adapter;
  }

  const realFs = new ReadWriteFs({ root: workingDir });
  const protectedFs = new ProtectedFs(realFs);

  return new MountableFs({
    base: adapter,
    mounts: [{ mountPoint: "/project", filesystem: protectedFs }],
  });
}
