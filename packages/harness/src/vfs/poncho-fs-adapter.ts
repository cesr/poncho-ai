// ---------------------------------------------------------------------------
// PonchoFsAdapter – implements just-bash's IFileSystem backed by StorageEngine.
//
// Optionally supports read-only virtual mounts: a VFS prefix (e.g. "/system/")
// that resolves to a local filesystem directory. Reads under the prefix are
// served from local disk; writes are rejected. Used by PonchOS to expose
// deployment-shipped defaults (system jobs, system skills) without storing
// them in each tenant's VFS, so improvements ship via normal deploys and
// users export their personal data without inheriting frozen system content.
// ---------------------------------------------------------------------------

import * as nodeFs from "node:fs/promises";
import * as nodeFsSync from "node:fs";
import * as nodePath from "node:path";

import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";
import type { StorageEngine } from "../storage/engine.js";

const MIME_MAP: Record<string, string> = {
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".sh": "application/x-sh",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".sql": "application/sql",
  ".wasm": "application/wasm",
};

const mimeFromExtension = (path: string): string | undefined => {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  return MIME_MAP[path.slice(dot).toLowerCase()];
};

const normalize = (path: string): string => {
  // Resolve . and .. segments, collapse multiple slashes
  const parts = path.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      out.pop();
    } else {
      out.push(p);
    }
  }
  return "/" + out.join("/");
};

/**
 * Read-only virtual mount mapping a VFS path prefix to a local filesystem
 * directory. All read operations under the prefix resolve via local FS;
 * writes throw. The prefix is normalised internally to end with "/".
 */
export interface VirtualMount {
  /** VFS prefix, e.g. "/system/". Leading slash required; trailing slash
   *  optional (normalised). Must be a single non-root segment in practice
   *  but no validation is enforced here. */
  prefix: string;
  /** Absolute local FS path to serve from, e.g. "/srv/poncho/system". */
  source: string;
}

/** Internal normalised form: prefix always ends with "/", source has no
 *  trailing slash. */
interface NormalisedMount {
  prefix: string;
  prefixNoSlash: string;
  source: string;
}

const READ_ONLY_ERROR = (path: string, op: string): Error =>
  new Error(`EROFS: read-only mount, ${op} '${path}'`);

export class PonchoFsAdapter implements IFileSystem {
  private mounts: NormalisedMount[];

  constructor(
    private engine: StorageEngine,
    private tenantId: string,
    private limits: { maxFileSize: number; maxTotalStorage: number },
    mounts: VirtualMount[] = [],
  ) {
    this.mounts = mounts.map((m) => {
      const prefix = m.prefix.endsWith("/") ? m.prefix : m.prefix + "/";
      return {
        prefix,
        prefixNoSlash: prefix.slice(0, -1),
        source: m.source.replace(/\/+$/, ""),
      };
    });
  }

  /** Find which mount, if any, a normalised VFS path falls under.
   *  Returns the relative path within the mount's source dir (empty string
   *  when the path is exactly the mount root). */
  private routeToMount(np: string): { mount: NormalisedMount; relative: string } | null {
    for (const m of this.mounts) {
      if (np === m.prefixNoSlash) return { mount: m, relative: "" };
      if (np.startsWith(m.prefix)) return { mount: m, relative: np.slice(m.prefix.length) };
    }
    return null;
  }

  /** Treat `np` as a directory and return mount-root segments that should be
   *  listed as virtual subdirectories. E.g. with mount "/system/", reading
   *  "/" returns ["system"]; reading "/system" goes via routeToMount and
   *  serves from local FS instead. */
  private virtualChildrenAt(np: string): string[] {
    const dirPrefix = np === "/" ? "/" : np + "/";
    const out: string[] = [];
    for (const m of this.mounts) {
      if (m.prefix.startsWith(dirPrefix) && m.prefix !== dirPrefix) {
        const remaining = m.prefix.slice(dirPrefix.length);
        const seg = remaining.split("/")[0];
        if (seg && !out.includes(seg)) out.push(seg);
      }
    }
    return out;
  }

  private toLocal(mount: NormalisedMount, relative: string): string {
    // nodePath.join handles empty relative -> source dir
    return nodePath.join(mount.source, relative);
  }

  /** Build an FsStat from a node fs.Stats. */
  private toFsStat(s: nodeFsSync.Stats): FsStat {
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      mode: s.mode,
      size: s.size,
      mtime: s.mtime,
    };
  }

  /** Synthesise a directory stat for a virtual ancestor (e.g. "/system"
   *  when "/system/jobs/" is mounted but "/system" itself isn't a real dir
   *  on disk). Used so `ls /` and `stat /system` work without surprises. */
  private syntheticDirStat(): FsStat {
    return {
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      mode: 0o755,
      size: 0,
      mtime: new Date(0),
    };
  }

  // --- Reads ---

  async readFile(path: string, _options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const np = normalize(path);
    const route = this.routeToMount(np);
    if (route) {
      const buf = await nodeFs.readFile(this.toLocal(route.mount, route.relative));
      return buf.toString("utf8");
    }
    const buf = await this.engine.vfs.readFile(this.tenantId, np);
    return new TextDecoder().decode(buf);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const np = normalize(path);
    const route = this.routeToMount(np);
    if (route) {
      const buf = await nodeFs.readFile(this.toLocal(route.mount, route.relative));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    return this.engine.vfs.readFile(this.tenantId, np);
  }

  async exists(path: string): Promise<boolean> {
    const np = normalize(path);
    const route = this.routeToMount(np);
    if (route) {
      try {
        await nodeFs.access(this.toLocal(route.mount, route.relative));
        return true;
      } catch {
        return false;
      }
    }
    // Virtual ancestor of a mount (e.g. "/" when only "/system/" is mounted):
    // it exists if either the engine has it OR it's a real ancestor of a mount.
    const s = await this.engine.vfs.stat(this.tenantId, np);
    if (s) return true;
    return this.virtualChildrenAt(np).length > 0;
  }

  async stat(path: string): Promise<FsStat> {
    const np = normalize(path);
    const route = this.routeToMount(np);
    if (route) {
      try {
        const s = await nodeFs.stat(this.toLocal(route.mount, route.relative));
        return this.toFsStat(s);
      } catch {
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      }
    }
    const s = await this.engine.vfs.stat(this.tenantId, np);
    if (s) {
      return {
        isFile: s.type === "file",
        isDirectory: s.type === "directory",
        isSymbolicLink: s.type === "symlink",
        mode: s.mode,
        size: s.size,
        mtime: new Date(s.updatedAt),
      };
    }
    // Virtual ancestor directory (no real entry, but mounts beneath it).
    if (this.virtualChildrenAt(np).length > 0) return this.syntheticDirStat();
    throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
  }

  async readdir(path: string): Promise<string[]> {
    const np = normalize(path);
    const route = this.routeToMount(np);
    if (route) {
      return nodeFs.readdir(this.toLocal(route.mount, route.relative));
    }
    // Engine-backed read; also inject any mount-root segments whose parent
    // is this directory but which aren't real directories on the engine side.
    let engineNames: string[] = [];
    try {
      const entries = await this.engine.vfs.readdir(this.tenantId, np);
      engineNames = entries.map((e) => e.name);
    } catch {
      // Falls through: maybe this is a virtual-only directory (e.g. "/system"
      // when there's no engine row for it but "/system/jobs/" is mounted).
    }
    const virtualSegs = this.virtualChildrenAt(np);
    if (virtualSegs.length === 0) return engineNames;
    const merged = new Set(engineNames);
    for (const seg of virtualSegs) merged.add(seg);
    return Array.from(merged);
  }

  async readdirWithFileTypes(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>> {
    const np = normalize(path);
    const route = this.routeToMount(np);
    if (route) {
      const entries = await nodeFs.readdir(this.toLocal(route.mount, route.relative), { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymbolicLink: e.isSymbolicLink(),
      }));
    }
    let engineEntries: Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }> = [];
    try {
      const entries = await this.engine.vfs.readdir(this.tenantId, np);
      engineEntries = entries.map((e) => ({
        name: e.name,
        isFile: e.type === "file",
        isDirectory: e.type === "directory",
        isSymbolicLink: e.type === "symlink",
      }));
    } catch {
      // virtual-only directory, see readdir
    }
    const virtualSegs = this.virtualChildrenAt(np);
    if (virtualSegs.length === 0) return engineEntries;
    const seen = new Set(engineEntries.map((e) => e.name));
    for (const seg of virtualSegs) {
      if (!seen.has(seg)) {
        engineEntries.push({ name: seg, isFile: false, isDirectory: true, isSymbolicLink: false });
      }
    }
    return engineEntries;
  }

  // --- Writes ---

  async writeFile(
    path: string,
    content: FileContent,
    _options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    const np = normalize(path);
    if (this.routeToMount(np)) throw READ_ONLY_ERROR(path, "writeFile");
    const buf = typeof content === "string" ? new TextEncoder().encode(content) : content;
    if (buf.byteLength > this.limits.maxFileSize) {
      throw new Error(
        `File too large: ${buf.byteLength} bytes exceeds limit of ${this.limits.maxFileSize} bytes`,
      );
    }
    const mime = mimeFromExtension(path);
    await this.engine.vfs.writeFile(this.tenantId, np, buf, mime);
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    const np = normalize(path);
    if (this.routeToMount(np)) throw READ_ONLY_ERROR(path, "appendFile");
    const buf = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await this.engine.vfs.appendFile(this.tenantId, np, buf);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const np = normalize(path);
    if (this.routeToMount(np)) throw READ_ONLY_ERROR(path, "mkdir");
    await this.engine.vfs.mkdir(this.tenantId, np, options?.recursive);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const np = normalize(path);
    if (this.routeToMount(np)) throw READ_ONLY_ERROR(path, "rm");
    const s = await this.engine.vfs.stat(this.tenantId, np);
    if (!s) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }
    if (s.type === "directory") {
      await this.engine.vfs.deleteDir(this.tenantId, np, options?.recursive);
    } else {
      await this.engine.vfs.deleteFile(this.tenantId, np);
    }
  }

  // --- Compound ops ---

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcNorm = normalize(src);
    const destNorm = normalize(dest);
    if (this.routeToMount(destNorm)) throw READ_ONLY_ERROR(dest, "cp");

    // Source may be either engine-backed or mount-backed. Route through this
    // adapter's own read methods so reads from mounted paths work.
    const srcStat = await this.stat(srcNorm).catch(() => null);
    if (!srcStat) throw new Error(`ENOENT: no such file or directory, cp '${src}'`);

    if (srcStat.isDirectory) {
      if (!options?.recursive) {
        throw new Error(`EISDIR: cp -r not specified; omitting directory '${src}'`);
      }
      await this.engine.vfs.mkdir(this.tenantId, destNorm, true);
      const entries = await this.readdir(srcNorm);
      for (const name of entries) {
        await this.cp(`${srcNorm}/${name}`, `${destNorm}/${name}`, options);
      }
    } else {
      const content = await this.readFileBuffer(srcNorm);
      const mime = mimeFromExtension(destNorm);
      await this.engine.vfs.writeFile(this.tenantId, destNorm, content, mime);
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcNorm = normalize(src);
    const destNorm = normalize(dest);
    if (this.routeToMount(srcNorm)) throw READ_ONLY_ERROR(src, "mv (source)");
    if (this.routeToMount(destNorm)) throw READ_ONLY_ERROR(dest, "mv (dest)");
    await this.engine.vfs.rename(this.tenantId, srcNorm, destNorm);
  }

  // --- Path resolution ---

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalize(path);
    return normalize(`${base}/${path}`);
  }

  async realpath(path: string): Promise<string> {
    const np = normalize(path);
    const route = this.routeToMount(np);
    if (route) {
      // Mount contents on local disk: resolve via node, but report back
      // in VFS-namespace terms (don't leak the on-disk source path to the
      // agent — that would be confusing and non-portable).
      const localResolved = await nodeFs.realpath(this.toLocal(route.mount, route.relative));
      const localRoot = await nodeFs.realpath(route.mount.source).catch(() => route.mount.source);
      if (localResolved === localRoot) return route.mount.prefixNoSlash;
      if (localResolved.startsWith(localRoot + nodePath.sep)) {
        const rel = localResolved.slice(localRoot.length + 1).split(nodePath.sep).join("/");
        return `${route.mount.prefix}${rel}`;
      }
      // Symlink escaped the mount — return the VFS path as-is.
      return np;
    }
    // Resolve symlinks in the path
    const s = await this.engine.vfs.lstat(this.tenantId, np);
    if (!s) {
      if (this.virtualChildrenAt(np).length > 0) return np;
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }
    if (s.type === "symlink" && s.symlinkTarget) {
      const target = s.symlinkTarget.startsWith("/")
        ? s.symlinkTarget
        : normalize(`${np.slice(0, np.lastIndexOf("/"))}/${s.symlinkTarget}`);
      return this.realpath(target);
    }
    return np;
  }

  // --- Sync: required by just-bash for glob/find ---

  getAllPaths(): string[] {
    const enginePaths = this.engine.vfs.listAllPaths(this.tenantId);
    if (this.mounts.length === 0) return enginePaths;
    const out = new Set(enginePaths);
    for (const m of this.mounts) {
      // Always advertise the mount root itself as a directory.
      out.add(m.prefixNoSlash);
      // Walk the local source once and add all paths under the mount.
      // Sync IO is acceptable here: bash glob/find call this sporadically and
      // the source is a small static asset directory on the API container.
      try {
        const stack: Array<{ abs: string; vfs: string }> = [
          { abs: m.source, vfs: m.prefixNoSlash },
        ];
        while (stack.length > 0) {
          const { abs, vfs } = stack.pop()!;
          let entries: nodeFsSync.Dirent[];
          try {
            entries = nodeFsSync.readdirSync(abs, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const e of entries) {
            const childVfs = `${vfs}/${e.name}`;
            out.add(childVfs);
            if (e.isDirectory()) {
              stack.push({ abs: nodePath.join(abs, e.name), vfs: childVfs });
            }
          }
        }
      } catch {
        // Source dir doesn't exist; skip it. Mount root is still advertised.
      }
    }
    return Array.from(out);
  }

  // --- Metadata ---

  async chmod(path: string, mode: number): Promise<void> {
    const np = normalize(path);
    if (this.routeToMount(np)) throw READ_ONLY_ERROR(path, "chmod");
    await this.engine.vfs.chmod(this.tenantId, np, mode);
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const np = normalize(path);
    if (this.routeToMount(np)) throw READ_ONLY_ERROR(path, "utimes");
    await this.engine.vfs.utimes(this.tenantId, np, mtime);
  }

  // --- Symlinks ---

  async symlink(target: string, linkPath: string): Promise<void> {
    const np = normalize(linkPath);
    if (this.routeToMount(np)) throw READ_ONLY_ERROR(linkPath, "symlink");
    await this.engine.vfs.symlink(this.tenantId, target, np);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const npNew = normalize(newPath);
    if (this.routeToMount(npNew)) throw READ_ONLY_ERROR(newPath, "link");
    // Hard link: copy content. Source may be mount-backed, so route through
    // this adapter's own read path.
    const content = await this.readFileBuffer(existingPath);
    const mime = mimeFromExtension(newPath);
    await this.engine.vfs.writeFile(this.tenantId, npNew, content, mime);
  }

  async readlink(path: string): Promise<string> {
    const np = normalize(path);
    const route = this.routeToMount(np);
    if (route) {
      // Mount contents are real files; readlink only makes sense for symlinks
      // we don't expect to have on disk. Node will throw EINVAL for non-links.
      return nodeFs.readlink(this.toLocal(route.mount, route.relative));
    }
    return this.engine.vfs.readlink(this.tenantId, np);
  }

  async lstat(path: string): Promise<FsStat> {
    const np = normalize(path);
    const route = this.routeToMount(np);
    if (route) {
      try {
        const s = await nodeFs.lstat(this.toLocal(route.mount, route.relative));
        return this.toFsStat(s);
      } catch {
        throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
      }
    }
    const s = await this.engine.vfs.lstat(this.tenantId, np);
    if (s) {
      return {
        isFile: s.type === "file",
        isDirectory: s.type === "directory",
        isSymbolicLink: s.type === "symlink",
        mode: s.mode,
        size: s.size,
        mtime: new Date(s.updatedAt),
      };
    }
    if (this.virtualChildrenAt(np).length > 0) return this.syntheticDirStat();
    throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
  }
}
