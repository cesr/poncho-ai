// ---------------------------------------------------------------------------
// PonchoFsAdapter – implements just-bash's IFileSystem backed by StorageEngine.
// ---------------------------------------------------------------------------

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

export class PonchoFsAdapter implements IFileSystem {
  constructor(
    private engine: StorageEngine,
    private tenantId: string,
    private limits: { maxFileSize: number; maxTotalStorage: number },
  ) {}

  // --- Reads ---

  async readFile(path: string, _options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    const buf = await this.engine.vfs.readFile(this.tenantId, normalize(path));
    return new TextDecoder().decode(buf);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.engine.vfs.readFile(this.tenantId, normalize(path));
  }

  async exists(path: string): Promise<boolean> {
    const s = await this.engine.vfs.stat(this.tenantId, normalize(path));
    return s !== undefined;
  }

  async stat(path: string): Promise<FsStat> {
    const np = normalize(path);
    const s = await this.engine.vfs.stat(this.tenantId, np);
    if (!s) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    return {
      isFile: s.type === "file",
      isDirectory: s.type === "directory",
      isSymbolicLink: s.type === "symlink",
      mode: s.mode,
      size: s.size,
      mtime: new Date(s.updatedAt),
    };
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.engine.vfs.readdir(this.tenantId, normalize(path));
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>> {
    const entries = await this.engine.vfs.readdir(this.tenantId, normalize(path));
    return entries.map((e) => ({
      name: e.name,
      isFile: e.type === "file",
      isDirectory: e.type === "directory",
      isSymbolicLink: e.type === "symlink",
    }));
  }

  // --- Writes ---

  async writeFile(
    path: string,
    content: FileContent,
    _options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    const buf = typeof content === "string" ? new TextEncoder().encode(content) : content;
    if (buf.byteLength > this.limits.maxFileSize) {
      throw new Error(
        `File too large: ${buf.byteLength} bytes exceeds limit of ${this.limits.maxFileSize} bytes`,
      );
    }
    const mime = mimeFromExtension(path);
    await this.engine.vfs.writeFile(this.tenantId, normalize(path), buf, mime);
  }

  async appendFile(
    path: string,
    content: FileContent,
    _options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    const buf = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await this.engine.vfs.appendFile(this.tenantId, normalize(path), buf);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.engine.vfs.mkdir(this.tenantId, normalize(path), options?.recursive);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const np = normalize(path);
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
    const srcStat = await this.engine.vfs.stat(this.tenantId, srcNorm);
    if (!srcStat) throw new Error(`ENOENT: no such file or directory, cp '${src}'`);

    if (srcStat.type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: cp -r not specified; omitting directory '${src}'`);
      }
      await this.engine.vfs.mkdir(this.tenantId, destNorm, true);
      const entries = await this.engine.vfs.readdir(this.tenantId, srcNorm);
      for (const entry of entries) {
        await this.cp(`${srcNorm}/${entry.name}`, `${destNorm}/${entry.name}`, options);
      }
    } else {
      const content = await this.engine.vfs.readFile(this.tenantId, srcNorm);
      const mime = mimeFromExtension(destNorm);
      await this.engine.vfs.writeFile(this.tenantId, destNorm, content, mime);
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.engine.vfs.rename(this.tenantId, normalize(src), normalize(dest));
  }

  // --- Path resolution ---

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalize(path);
    return normalize(`${base}/${path}`);
  }

  async realpath(path: string): Promise<string> {
    const np = normalize(path);
    // Resolve symlinks in the path
    const s = await this.engine.vfs.lstat(this.tenantId, np);
    if (!s) throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
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
    return this.engine.vfs.listAllPaths(this.tenantId);
  }

  // --- Metadata ---

  async chmod(path: string, mode: number): Promise<void> {
    await this.engine.vfs.chmod(this.tenantId, normalize(path), mode);
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    await this.engine.vfs.utimes(this.tenantId, normalize(path), mtime);
  }

  // --- Symlinks ---

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.engine.vfs.symlink(this.tenantId, target, normalize(linkPath));
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    // Hard link: copy content
    const content = await this.engine.vfs.readFile(this.tenantId, normalize(existingPath));
    const mime = mimeFromExtension(newPath);
    await this.engine.vfs.writeFile(this.tenantId, normalize(newPath), content, mime);
  }

  async readlink(path: string): Promise<string> {
    return this.engine.vfs.readlink(this.tenantId, normalize(path));
  }

  async lstat(path: string): Promise<FsStat> {
    const np = normalize(path);
    const s = await this.engine.vfs.lstat(this.tenantId, np);
    if (!s) throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    return {
      isFile: s.type === "file",
      isDirectory: s.type === "directory",
      isSymbolicLink: s.type === "symlink",
      mode: s.mode,
      size: s.size,
      mtime: new Date(s.updatedAt),
    };
  }
}
