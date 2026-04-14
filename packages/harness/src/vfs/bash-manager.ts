// ---------------------------------------------------------------------------
// BashEnvironmentManager – manages per-tenant bash instances.
// ---------------------------------------------------------------------------

import { Bash } from "just-bash";
import type {
  BashOptions,
  CommandName,
  IFileSystem,
  NetworkConfig as JustBashNetworkConfig,
} from "just-bash";
import type { StorageEngine } from "../storage/engine.js";
import type { BashConfig, NetworkConfig } from "../config.js";
import { PonchoFsAdapter } from "./poncho-fs-adapter.js";
import { createBashFs } from "./create-bash-fs.js";
import type { PostgresEngine } from "../storage/postgres-engine.js";

/** Convert poncho NetworkConfig → just-bash NetworkConfig. */
function toJustBashNetwork(cfg: NetworkConfig): JustBashNetworkConfig {
  return {
    allowedUrlPrefixes: cfg.allowedUrls,
    allowedMethods: cfg.allowedMethods,
    dangerouslyAllowFullInternetAccess: cfg.dangerouslyAllowAll,
    maxRedirects: cfg.maxRedirects,
    timeoutMs: cfg.timeoutMs,
    maxResponseSize: cfg.maxResponseSize,
    denyPrivateRanges: cfg.denyPrivateRanges,
  };
}

/** Build the just-bash BashOptions from poncho BashConfig + NetworkConfig. */
function toBashOptions(
  cfg: BashConfig | undefined,
  network: NetworkConfig | undefined,
): Partial<BashOptions> {
  const opts: Partial<BashOptions> = {};

  if (network) {
    opts.network = toJustBashNetwork(network);
  }

  if (!cfg) return opts;

  if (cfg.commands) {
    opts.commands = cfg.commands as CommandName[];
  }

  if (cfg.executionLimits) {
    opts.executionLimits = { ...cfg.executionLimits };
  }

  if (cfg.python) {
    opts.python = true;
  }

  if (cfg.javascript) {
    opts.javascript = true;
  }

  if (cfg.env) {
    opts.env = cfg.env;
  }

  return opts;
}

export class BashEnvironmentManager {
  private environments = new Map<string, Bash>();
  private filesystems = new Map<string, IFileSystem>();
  private readonly workingDir: string | null;
  private readonly bashOptions: Partial<BashOptions>;

  constructor(
    private engine: StorageEngine,
    private limits: { maxFileSize: number; maxTotalStorage: number },
    workingDir: string | null,
    bashConfig?: BashConfig,
    network?: NetworkConfig,
  ) {
    this.workingDir = workingDir;
    this.bashOptions = toBashOptions(bashConfig, network);
  }

  /** Return the combined IFileSystem (VFS + optional /project mount) for a tenant. */
  getFs(tenantId: string): IFileSystem {
    let fs = this.filesystems.get(tenantId);
    if (!fs) {
      const adapter = new PonchoFsAdapter(this.engine, tenantId, this.limits);
      fs = createBashFs(adapter, this.workingDir);
      this.filesystems.set(tenantId, fs);
    }
    return fs;
  }

  getOrCreate(tenantId: string): Bash {
    let bash = this.environments.get(tenantId);
    if (!bash) {
      const fs = this.getFs(tenantId);
      bash = new Bash({
        fs,
        cwd: "/",
        ...this.bashOptions,
      });
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
    this.filesystems.delete(tenantId);
  }

  destroyAll(): void {
    this.environments.clear();
    this.filesystems.clear();
  }
}
