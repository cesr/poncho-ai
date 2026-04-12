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
