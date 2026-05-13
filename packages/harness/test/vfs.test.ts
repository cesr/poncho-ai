import { describe, expect, it } from "vitest";
import { Bash } from "just-bash";
import { InMemoryEngine } from "../src/storage/memory-engine.js";
import { PonchoFsAdapter } from "../src/vfs/poncho-fs-adapter.js";
import { ProtectedFs } from "../src/vfs/protected-fs.js";
import { createBashFs } from "../src/vfs/create-bash-fs.js";
import { BashEnvironmentManager } from "../src/vfs/bash-manager.js";

const MB = 1024 * 1024;
const LIMITS = { maxFileSize: 10 * MB, maxTotalStorage: 100 * MB };

describe("PonchoFsAdapter", () => {
  it("implements IFileSystem contract with InMemoryEngine", async () => {
    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const adapter = new PonchoFsAdapter(engine, "t1", LIMITS);

    // writeFile + readFile
    await adapter.writeFile("/hello.txt", "world");
    const content = await adapter.readFile("/hello.txt");
    expect(content).toBe("world");

    // readFileBuffer
    const buf = await adapter.readFileBuffer("/hello.txt");
    expect(new TextDecoder().decode(buf)).toBe("world");

    // exists
    expect(await adapter.exists("/hello.txt")).toBe(true);
    expect(await adapter.exists("/nope.txt")).toBe(false);

    // stat
    const stat = await adapter.stat("/hello.txt");
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe(5);

    // mkdir + readdir
    await adapter.mkdir("/mydir", { recursive: true });
    await adapter.writeFile("/mydir/a.txt", "a");
    await adapter.writeFile("/mydir/b.txt", "b");
    const entries = await adapter.readdir("/mydir");
    expect(entries.sort()).toEqual(["a.txt", "b.txt"]);

    // cp
    await adapter.cp("/mydir/a.txt", "/mydir/copy.txt");
    expect(await adapter.readFile("/mydir/copy.txt")).toBe("a");

    // mv
    await adapter.mv("/mydir/copy.txt", "/mydir/moved.txt");
    expect(await adapter.exists("/mydir/copy.txt")).toBe(false);
    expect(await adapter.readFile("/mydir/moved.txt")).toBe("a");

    // rm
    await adapter.rm("/mydir/moved.txt");
    expect(await adapter.exists("/mydir/moved.txt")).toBe(false);

    // getAllPaths
    const paths = adapter.getAllPaths();
    expect(paths).toContain("/hello.txt");

    // chmod
    await adapter.chmod("/hello.txt", 0o755);
    const stat2 = await adapter.stat("/hello.txt");
    expect(stat2.mode).toBe(0o755);

    await engine.close();
  });

  it("enforces file size limits", async () => {
    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const adapter = new PonchoFsAdapter(engine, "t1", { maxFileSize: 10, maxTotalStorage: 1000 });

    await expect(adapter.writeFile("/big.txt", "x".repeat(20))).rejects.toThrow("File too large");
    await engine.close();
  });
});

describe("ProtectedFs", () => {
  it("blocks writes to protected paths", async () => {
    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const inner = new PonchoFsAdapter(engine, "t1", LIMITS);
    const protectedFs = new ProtectedFs(inner);

    // Write to .env should be blocked (guard throws synchronously)
    expect(() => protectedFs.writeFile(".env", "SECRET=bad")).toThrow("Permission denied");
    expect(() => protectedFs.writeFile(".env.local", "SECRET=bad")).toThrow("Permission denied");
    expect(() => protectedFs.writeFile(".git/config", "bad")).toThrow("Permission denied");
    expect(() => protectedFs.writeFile("node_modules/foo", "bad")).toThrow("Permission denied");

    // Write to normal paths should work
    await protectedFs.writeFile("/src/index.ts", "console.log('ok')");
    const content = await protectedFs.readFile("/src/index.ts");
    expect(content).toBe("console.log('ok')");

    // Reads from protected paths should work
    await inner.writeFile("/.env", "SECRET=ok");
    const secret = await protectedFs.readFile("/.env");
    expect(secret).toBe("SECRET=ok");

    await engine.close();
  });
});

describe("bash + VFS integration", () => {
  it("executes bash commands against the VFS", async () => {
    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const manager = new BashEnvironmentManager(engine, LIMITS, null);
    const bash = manager.getOrCreate("t1");

    // Write via bash
    const writeResult = await bash.exec('echo "hello from bash" > /greeting.txt');
    expect(writeResult.exitCode).toBe(0);

    // Read via bash
    const catResult = await bash.exec("cat /greeting.txt");
    expect(catResult.stdout.trim()).toBe("hello from bash");

    // Data processing pipeline
    await bash.exec('echo -e "3\\n1\\n2" > /numbers.txt');
    const sortResult = await bash.exec("cat /numbers.txt | sort -n");
    expect(sortResult.stdout.trim()).toBe("1\n2\n3");

    // Files persist across exec calls
    const lsResult = await bash.exec("ls /");
    expect(lsResult.stdout).toContain("greeting.txt");
    expect(lsResult.stdout).toContain("numbers.txt");

    // Verify data is in the engine (not just in bash memory)
    const adapter = manager.getAdapter("t1");
    const content = await adapter.readFile("/greeting.txt");
    expect(content.trim()).toBe("hello from bash");

    manager.destroyAll();
    await engine.close();
  });

  it("creates production filesystem without /project mount", () => {
    const engine = new InMemoryEngine("test");
    const adapter = new PonchoFsAdapter(engine, "t1", LIMITS);

    // null workingDir = production mode, no project mount
    const fs = createBashFs(adapter, null);
    expect(fs).toBe(adapter); // Should return adapter directly
  });

  it("enables curl when network config is provided", async () => {
    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const manager = new BashEnvironmentManager(engine, LIMITS, null, undefined, {
      dangerouslyAllowAll: true,
    });
    const bash = manager.getOrCreate("t1");

    // curl should be registered as a command when network is configured.
    // Fetching a known URL and writing to VFS:
    const result = await bash.exec("curl -s -o /test.txt https://example.com");
    expect(result.exitCode).toBe(0);

    // Verify the file was written to VFS
    const adapter = manager.getAdapter("t1");
    expect(await adapter.exists("/test.txt")).toBe(true);
    const content = await adapter.readFile("/test.txt");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("Example Domain");

    manager.destroyAll();
    await engine.close();
  });

  it("blocks curl when no network config is provided", async () => {
    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const manager = new BashEnvironmentManager(engine, LIMITS, null);
    const bash = manager.getOrCreate("t1");

    const result = await bash.exec("curl https://example.com");
    // curl should either not be found or be blocked
    expect(result.exitCode).not.toBe(0);

    manager.destroyAll();
    await engine.close();
  });

  it("restricts commands when whitelist is provided", async () => {
    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const manager = new BashEnvironmentManager(engine, LIMITS, null, {
      commands: ["echo", "cat"],
    });
    const bash = manager.getOrCreate("t1");

    // Allowed commands work
    const echoResult = await bash.exec('echo "hello"');
    expect(echoResult.exitCode).toBe(0);
    expect(echoResult.stdout.trim()).toBe("hello");

    // Disallowed commands fail
    const rmResult = await bash.exec("rm /some-file");
    expect(rmResult.exitCode).not.toBe(0);

    manager.destroyAll();
    await engine.close();
  });

  it("enforces execution limits", async () => {
    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const manager = new BashEnvironmentManager(engine, LIMITS, null, {
      executionLimits: { maxLoopIterations: 5 },
    });
    const bash = manager.getOrCreate("t1");

    // A loop that exceeds the limit should fail
    const result = await bash.exec("for i in $(seq 1 100); do echo $i; done");
    expect(result.exitCode).not.toBe(0);

    manager.destroyAll();
    await engine.close();
  });

  it("injects environment variables", async () => {
    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const manager = new BashEnvironmentManager(engine, LIMITS, null, {
      env: { MY_VAR: "hello_world", TZ: "UTC" },
    });
    const bash = manager.getOrCreate("t1");

    const result = await bash.exec("echo $MY_VAR");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello_world");

    const tzResult = await bash.exec("echo $TZ");
    expect(tzResult.exitCode).toBe(0);
    expect(tzResult.stdout.trim()).toBe("UTC");

    manager.destroyAll();
    await engine.close();
  });
});

describe("PonchoFsAdapter virtual read-only mounts", () => {
  async function withMountFixture(): Promise<{
    engine: InMemoryEngine;
    adapter: PonchoFsAdapter;
    sourceDir: string;
    cleanup: () => Promise<void>;
  }> {
    const nodeFs = await import("node:fs/promises");
    const nodeOs = await import("node:os");
    const nodePath = await import("node:path");
    const sourceDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "ponchofs-mount-"));
    await nodeFs.mkdir(nodePath.join(sourceDir, "jobs"), { recursive: true });
    await nodeFs.writeFile(nodePath.join(sourceDir, "jobs", "dream.md"), "dream content");
    await nodeFs.writeFile(nodePath.join(sourceDir, "jobs", "heartbeat.md"), "heartbeat content");

    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const adapter = new PonchoFsAdapter(engine, "t1", LIMITS, [
      { prefix: "/system/", source: sourceDir },
    ]);

    return {
      engine,
      adapter,
      sourceDir,
      cleanup: async () => {
        await engine.close();
        await nodeFs.rm(sourceDir, { recursive: true, force: true });
      },
    };
  }

  it("serves mounted files from disk and lists them via readdir", async () => {
    const { adapter, cleanup } = await withMountFixture();
    try {
      expect(await adapter.readFile("/system/jobs/dream.md")).toBe("dream content");
      expect(await adapter.readFile("/system/jobs/heartbeat.md")).toBe("heartbeat content");

      const sysEntries = (await adapter.readdir("/system")).sort();
      expect(sysEntries).toEqual(["jobs"]);

      const jobsEntries = (await adapter.readdir("/system/jobs")).sort();
      expect(jobsEntries).toEqual(["dream.md", "heartbeat.md"]);

      const dreamStat = await adapter.stat("/system/jobs/dream.md");
      expect(dreamStat.isFile).toBe(true);
      expect(dreamStat.size).toBe("dream content".length);

      const sysStat = await adapter.stat("/system");
      expect(sysStat.isDirectory).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("exposes the mount root segment when listing the root", async () => {
    const { adapter, cleanup } = await withMountFixture();
    try {
      // Write a user file at /jobs/ so root has both engine + virtual entries.
      await adapter.mkdir("/jobs", { recursive: true });
      await adapter.writeFile("/jobs/mine.md", "mine");
      const rootEntries = (await adapter.readdir("/")).sort();
      expect(rootEntries).toContain("jobs");
      expect(rootEntries).toContain("system");
    } finally {
      await cleanup();
    }
  });

  it("rejects writes anywhere under a mount prefix", async () => {
    const { adapter, cleanup } = await withMountFixture();
    try {
      await expect(adapter.writeFile("/system/jobs/new.md", "x")).rejects.toThrow(/EROFS/);
      await expect(adapter.writeFile("/system/jobs/dream.md", "overwrite")).rejects.toThrow(/EROFS/);
      await expect(adapter.mkdir("/system/extra", { recursive: true })).rejects.toThrow(/EROFS/);
      await expect(adapter.rm("/system/jobs/dream.md")).rejects.toThrow(/EROFS/);
      await expect(adapter.appendFile("/system/jobs/dream.md", "y")).rejects.toThrow(/EROFS/);
      // Source of mv being mounted also rejects (can't move out of read-only).
      await expect(adapter.mv("/system/jobs/dream.md", "/jobs/dream.md")).rejects.toThrow(/EROFS/);
    } finally {
      await cleanup();
    }
  });

  it("getAllPaths includes mount contents for bash glob/find", async () => {
    const { adapter, cleanup } = await withMountFixture();
    try {
      const paths = adapter.getAllPaths();
      expect(paths).toContain("/system");
      expect(paths).toContain("/system/jobs");
      expect(paths).toContain("/system/jobs/dream.md");
      expect(paths).toContain("/system/jobs/heartbeat.md");
    } finally {
      await cleanup();
    }
  });

  it("does not affect engine-backed reads outside any mount", async () => {
    const { adapter, cleanup } = await withMountFixture();
    try {
      await adapter.mkdir("/jobs", { recursive: true });
      await adapter.writeFile("/jobs/morning-brief.md", "brief");
      expect(await adapter.readFile("/jobs/morning-brief.md")).toBe("brief");
      // Mount path still serves from disk independently
      expect(await adapter.readFile("/system/jobs/dream.md")).toBe("dream content");
    } finally {
      await cleanup();
    }
  });
});
