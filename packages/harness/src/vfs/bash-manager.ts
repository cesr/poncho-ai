// ---------------------------------------------------------------------------
// BashEnvironmentManager – manages per-tenant bash instances.
// ---------------------------------------------------------------------------

import { Bash } from "just-bash";
import type { StorageEngine } from "../storage/engine.js";
import { PonchoFsAdapter } from "./poncho-fs-adapter.js";
import { createBashFs } from "./create-bash-fs.js";
import type { PostgresEngine } from "../storage/postgres-engine.js";

export class BashEnvironmentManager {
  private environments = new Map<string, Bash>();
  private readonly workingDir: string | null;

  constructor(
    private engine: StorageEngine,
    private limits: { maxFileSize: number; maxTotalStorage: number },
    workingDir: string | null,
  ) {
    this.workingDir = workingDir;
  }

  getOrCreate(tenantId: string): Bash {
    let bash = this.environments.get(tenantId);
    if (!bash) {
      const adapter = new PonchoFsAdapter(this.engine, tenantId, this.limits);
      const fs = createBashFs(adapter, this.workingDir);
      bash = new Bash({ fs, cwd: "/" });
      this.environments.set(tenantId, bash);
    }
    return bash;
  }

  getAdapter(tenantId: string): PonchoFsAdapter {
    return new PonchoFsAdapter(this.engine, tenantId, this.limits);
  }

  /** Refresh the PostgreSQL path cache before a bash.exec() call. */
  async refreshPathCache(tenantId: string): Promise<void> {
    if ("refreshPathCache" in this.engine) {
      // Not on StorageEngine interface but on PostgresEngine
    }
    // Check if the engine is a PostgresEngine with refreshPathCache
    const pg = this.engine as unknown as PostgresEngine;
    if (typeof pg.refreshPathCache === "function") {
      await pg.refreshPathCache(tenantId);
    }
  }

  destroy(tenantId: string): void {
    this.environments.delete(tenantId);
  }

  destroyAll(): void {
    this.environments.clear();
  }
}
