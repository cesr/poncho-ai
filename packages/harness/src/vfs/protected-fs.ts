// ---------------------------------------------------------------------------
// ProtectedFs – write protection wrapper for project files.
// Blocks writes/deletes to sensitive paths. All reads pass through.
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

const DEFAULT_PROTECTED_PATTERNS = [
  ".env",
  ".env.*",
  ".git/",
  "node_modules/",
  ".poncho/",
  "poncho.config.*",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

function matchProtectedPattern(pattern: string, path: string): boolean {
  // Normalize: strip leading /
  const rel = path.startsWith("/") ? path.slice(1) : path;
  const segments = rel.split("/");

  if (pattern.endsWith("/")) {
    // Directory prefix: block this dir and everything under it
    const dir = pattern.slice(0, -1);
    return segments[0] === dir || rel.startsWith(dir + "/");
  }

  if (pattern.includes("*")) {
    // Wildcard: convert to regex
    const re = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, "[^/]*") + "$",
    );
    return re.test(segments[0] ?? "") || re.test(rel);
  }

  // Exact match on the first segment or full path
  return segments[0] === pattern || rel === pattern;
}

export class ProtectedFs implements IFileSystem {
  private inner: IFileSystem;
  private patterns: string[];

  constructor(inner: IFileSystem, patterns?: string[]) {
    this.inner = inner;
    this.patterns = patterns ?? DEFAULT_PROTECTED_PATTERNS;
  }

  private isProtected(path: string): boolean {
    return this.patterns.some((p) => matchProtectedPattern(p, path));
  }

  private guard(path: string, op: string): void {
    if (this.isProtected(path)) {
      throw new Error(`Permission denied: ${path} is protected (${op})`);
    }
  }

  // --- Reads: pass through ---

  readFile(path: string, options?: { encoding?: BufferEncoding | null } | BufferEncoding): Promise<string> {
    return this.inner.readFile(path, options);
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.inner.readFileBuffer(path);
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  stat(path: string): Promise<FsStat> {
    return this.inner.stat(path);
  }

  readdir(path: string): Promise<string[]> {
    return this.inner.readdir(path);
  }

  readdirWithFileTypes(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>> {
    if (this.inner.readdirWithFileTypes) {
      return this.inner.readdirWithFileTypes(path);
    }
    throw new Error("readdirWithFileTypes not supported");
  }

  lstat(path: string): Promise<FsStat> {
    return this.inner.lstat(path);
  }

  readlink(path: string): Promise<string> {
    return this.inner.readlink(path);
  }

  realpath(path: string): Promise<string> {
    return this.inner.realpath(path);
  }

  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }

  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }

  // --- Writes: check protection ---

  writeFile(
    path: string,
    content: FileContent,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    this.guard(path, "write");
    return this.inner.writeFile(path, content, options);
  }

  appendFile(
    path: string,
    content: FileContent,
    options?: { encoding?: BufferEncoding } | BufferEncoding,
  ): Promise<void> {
    this.guard(path, "append");
    return this.inner.appendFile(path, content, options);
  }

  mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.inner.mkdir(path, options);
  }

  rm(path: string, options?: RmOptions): Promise<void> {
    this.guard(path, "rm");
    return this.inner.rm(path, options);
  }

  cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    this.guard(dest, "cp");
    return this.inner.cp(src, dest, options);
  }

  mv(src: string, dest: string): Promise<void> {
    this.guard(src, "mv");
    this.guard(dest, "mv");
    return this.inner.mv(src, dest);
  }

  chmod(path: string, mode: number): Promise<void> {
    this.guard(path, "chmod");
    return this.inner.chmod(path, mode);
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.inner.utimes(path, atime, mtime);
  }

  symlink(target: string, linkPath: string): Promise<void> {
    this.guard(linkPath, "symlink");
    return this.inner.symlink(target, linkPath);
  }

  link(existingPath: string, newPath: string): Promise<void> {
    this.guard(newPath, "link");
    return this.inner.link(existingPath, newPath);
  }
}
