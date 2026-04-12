import { describe, expect, it } from "vitest";
import { createIsolateRuntime } from "../src/isolate/runtime.js";
import { createVfsBindings, createFetchBinding } from "../src/isolate/bindings.js";
import { InMemoryEngine } from "../src/storage/memory-engine.js";
import { PonchoFsAdapter } from "../src/vfs/poncho-fs-adapter.js";
import type { IsolateBinding } from "../src/config.js";

const MB = 1024 * 1024;
const LIMITS = { maxFileSize: 10 * MB, maxTotalStorage: 100 * MB };
const DEFAULT_CONFIG = { memoryLimit: 64, timeout: 5000, outputLimit: 65536 };

async function createTestAdapter(tenantId = "t1"): Promise<{
  adapter: PonchoFsAdapter;
  engine: InMemoryEngine;
}> {
  const engine = new InMemoryEngine("test");
  await engine.initialize();
  const adapter = new PonchoFsAdapter(engine, tenantId, LIMITS);
  return { adapter, engine };
}

describe("VFS bindings in isolate", () => {
  it("reads and writes text files", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    const res = await runtime.execute(
      `
      await fs_write({ path: "/test.txt", content: "hello world" });
      const content = await fs_read({ path: "/test.txt" });
      return content;
      `,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("hello world");

    // Verify it persisted to the engine
    const persisted = await adapter.readFile("/test.txt");
    expect(persisted).toBe("hello world");

    await engine.close();
  });

  it("reads and writes binary files via base64", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    // Write some bytes as base64 (ASCII "ABC" = QUJD)
    const res = await runtime.execute(
      `
      await fs_write_binary({ path: "/data.bin", content: "QUJD" });
      const b64 = await fs_read_binary({ path: "/data.bin" });
      return b64;
      `,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("QUJD");

    // Verify raw bytes
    const buf = await adapter.readFileBuffer("/data.bin");
    expect(Buffer.from(buf).toString("utf-8")).toBe("ABC");

    await engine.close();
  });

  it("lists directories", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    await adapter.mkdir("/mydir", { recursive: true });
    await adapter.writeFile("/mydir/a.txt", "a");
    await adapter.writeFile("/mydir/b.txt", "b");

    const res = await runtime.execute(
      `return await fs_list({ path: "/mydir" });`,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect((res.result as string[]).sort()).toEqual(["a.txt", "b.txt"]);

    await engine.close();
  });

  it("checks file existence", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    await adapter.writeFile("/exists.txt", "yes");

    const res = await runtime.execute(
      `
      const a = await fs_exists({ path: "/exists.txt" });
      const b = await fs_exists({ path: "/nope.txt" });
      return { a, b };
      `,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ a: true, b: false });

    await engine.close();
  });

  it("deletes files", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    await adapter.writeFile("/doomed.txt", "bye");

    const res = await runtime.execute(
      `
      await fs_delete({ path: "/doomed.txt" });
      return await fs_exists({ path: "/doomed.txt" });
      `,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe(false);

    await engine.close();
  });

  it("creates directories", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    const res = await runtime.execute(
      `
      await fs_mkdir({ path: "/deep/nested/dir" });
      await fs_write({ path: "/deep/nested/dir/file.txt", content: "hi" });
      return await fs_read({ path: "/deep/nested/dir/file.txt" });
      `,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("hi");

    await engine.close();
  });

  it("gets file stats", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    await adapter.writeFile("/info.txt", "12345");

    const res = await runtime.execute(
      `return await fs_stat({ path: "/info.txt" });`,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    const stat = res.result as { isFile: boolean; isDirectory: boolean; size: number; mtime: string };
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBe(5);
    expect(stat.mtime).toBeTruthy();

    await engine.close();
  });

  it("preserves writes on error (partial execution)", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    const res = await runtime.execute(
      `
      await fs_write({ path: "/good.txt", content: "persisted" });
      throw new Error("intentional");
      `,
      bindings,
      null,
    );

    expect(res.error).toBeDefined();
    expect(res.error!.message).toBe("intentional");

    // The write before the error should have persisted
    const content = await adapter.readFile("/good.txt");
    expect(content).toBe("persisted");

    await engine.close();
  });

  it("handles VFS errors gracefully inside isolate", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    const res = await runtime.execute(
      `
      try {
        await fs_read({ path: "/nonexistent.txt" });
        return "should not reach here";
      } catch (e) {
        return "caught: " + e.message;
      }
      `,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toMatch(/caught:.*ENOENT/);

    await engine.close();
  });
});

describe("VFS tenant isolation", () => {
  it("isolates file systems between tenants", async () => {
    const engine = new InMemoryEngine("test");
    await engine.initialize();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const adapter1 = new PonchoFsAdapter(engine, "tenant-a", LIMITS);
    const adapter2 = new PonchoFsAdapter(engine, "tenant-b", LIMITS);

    const bindings1 = createVfsBindings(adapter1);
    const bindings2 = createVfsBindings(adapter2);

    // Write in tenant A
    await runtime.execute(
      `await fs_write({ path: "/secret.txt", content: "tenant-a-data" });`,
      bindings1,
      null,
    );

    // Tenant B should not see it
    const res = await runtime.execute(
      `return await fs_exists({ path: "/secret.txt" });`,
      bindings2,
      null,
    );

    expect(res.result).toBe(false);

    await engine.close();
  });
});

describe("Scoped fetch binding", () => {
  it("rejects requests to non-allowed domains", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const fetchBinding = createFetchBinding(["api.example.com"]);
    const bindings: Record<string, IsolateBinding> = { fetch: fetchBinding };

    const res = await runtime.execute(
      `
      try {
        await fetch({ url: "https://evil.com/data" });
        return "should not reach here";
      } catch (e) {
        return e.message;
      }
      `,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toMatch(/blocked.*evil\.com/i);
  });
});
