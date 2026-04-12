import { describe, expect, it } from "vitest";
import { createIsolateRuntime } from "../src/isolate/runtime.js";
import { createVfsBindings, createFetchBinding } from "../src/isolate/bindings.js";
import { buildPolyfillPreamble } from "../src/isolate/polyfills.js";
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

const polyfills = buildPolyfillPreamble(false);
const polyfillsWithFetch = buildPolyfillPreamble(true);

describe("Standard fs API in isolate", () => {
  it("reads and writes text files via fs.readFile/writeFile", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    const res = await runtime.execute(
      `
      await fs.writeFile("/test.txt", "hello world");
      const content = await fs.readFile("/test.txt", "utf-8");
      return content;
      `,
      bindings, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("hello world");

    const persisted = await adapter.readFile("/test.txt");
    expect(persisted).toBe("hello world");

    await engine.close();
  });

  it("reads binary files as Buffer", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    // Write binary via adapter
    await adapter.writeFile("/data.bin", Buffer.from([0x41, 0x42, 0x43]));

    const res = await runtime.execute(
      `
      const buf = await fs.readFile("/data.bin");
      return buf.toString("utf-8");
      `,
      bindings, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("ABC");

    await engine.close();
  });

  it("writes Buffer/Uint8Array binary data", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    const res = await runtime.execute(
      `
      const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      await fs.writeFile("/hello.bin", buf);
      return true;
      `,
      bindings, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    const content = await adapter.readFileBuffer("/hello.bin");
    expect(Buffer.from(content).toString("utf-8")).toBe("Hello");

    await engine.close();
  });

  it("lists directories via fs.readdir", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    await adapter.mkdir("/mydir", { recursive: true });
    await adapter.writeFile("/mydir/a.txt", "a");
    await adapter.writeFile("/mydir/b.txt", "b");

    const res = await runtime.execute(
      `return await fs.readdir("/mydir");`,
      bindings, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect((res.result as string[]).sort()).toEqual(["a.txt", "b.txt"]);

    await engine.close();
  });

  it("checks file existence via fs.exists", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    await adapter.writeFile("/exists.txt", "yes");

    const res = await runtime.execute(
      `
      const a = await fs.exists("/exists.txt");
      const b = await fs.exists("/nope.txt");
      return { a, b };
      `,
      bindings, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ a: true, b: false });

    await engine.close();
  });

  it("gets file stats via fs.stat", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    await adapter.writeFile("/info.txt", "12345");

    const res = await runtime.execute(
      `
      const s = await fs.stat("/info.txt");
      return { isFile: s.isFile(), isDir: s.isDirectory(), size: s.size };
      `,
      bindings, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ isFile: true, isDir: false, size: 5 });

    await engine.close();
  });

  it("deletes files via fs.unlink", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    await adapter.writeFile("/doomed.txt", "bye");

    const res = await runtime.execute(
      `
      await fs.unlink("/doomed.txt");
      return await fs.exists("/doomed.txt");
      `,
      bindings, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe(false);

    await engine.close();
  });

  it("creates directories via fs.mkdir", async () => {
    const { adapter, engine } = await createTestAdapter();
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings = createVfsBindings(adapter);

    const res = await runtime.execute(
      `
      await fs.mkdir("/deep/nested/dir");
      await fs.writeFile("/deep/nested/dir/file.txt", "hi");
      return await fs.readFile("/deep/nested/dir/file.txt", "utf-8");
      `,
      bindings, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("hi");

    await engine.close();
  });
});

describe("Buffer polyfill in isolate", () => {
  it("supports from/toString with encodings", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const res = await runtime.execute(
      `
      const b = Buffer.from("hello");
      const hex = b.toString("hex");
      const b64 = b.toString("base64");
      const back = Buffer.from(b64, "base64").toString("utf-8");
      return { hex, b64, back };
      `,
      {}, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      hex: "68656c6c6f",
      b64: "aGVsbG8=",
      back: "hello",
    });
  });

  it("supports concat and alloc", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const res = await runtime.execute(
      `
      const a = Buffer.from("hel");
      const b = Buffer.from("lo");
      const c = Buffer.concat([a, b]);
      return c.toString("utf-8");
      `,
      {}, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("hello");
  });
});

describe("path polyfill in isolate", () => {
  it("join, basename, dirname, extname work", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const res = await runtime.execute(
      `
      return {
        joined: path.join("/foo", "bar", "baz.txt"),
        base: path.basename("/foo/bar/baz.txt"),
        baseNoExt: path.basename("/foo/bar/baz.txt", ".txt"),
        dir: path.dirname("/foo/bar/baz.txt"),
        ext: path.extname("/foo/bar/baz.txt"),
      };
      `,
      {}, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      joined: "/foo/bar/baz.txt",
      base: "baz.txt",
      baseNoExt: "baz",
      dir: "/foo/bar",
      ext: ".txt",
    });
  });
});

describe("Polyfill basics in isolate", () => {
  it("atob/btoa work", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const res = await runtime.execute(
      `return { encoded: btoa("hello"), decoded: atob("aGVsbG8=") };`,
      {}, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ encoded: "aGVsbG8=", decoded: "hello" });
  });

  it("setTimeout with 0 delay works", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const res = await runtime.execute(
      `
      let called = false;
      setTimeout(() => { called = true; }, 0);
      await new Promise(r => setTimeout(r, 0));
      // Give microtasks a chance to flush
      await new Promise(r => setTimeout(r, 0));
      return called;
      `,
      {}, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe(true);
  });

  it("crypto.randomUUID returns valid format", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const res = await runtime.execute(
      `return crypto.randomUUID();`,
      {}, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("Blob works", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const res = await runtime.execute(
      `
      const blob = new Blob(["hello ", "world"], { type: "text/plain" });
      const text = await blob.text();
      return { size: blob.size, type: blob.type, text };
      `,
      {}, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ size: 11, type: "text/plain", text: "hello world" });
  });

  it("structuredClone works", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const res = await runtime.execute(
      `
      const obj = { a: 1, b: [2, 3] };
      const clone = structuredClone(obj);
      clone.b.push(4);
      return { original: obj.b.length, cloned: clone.b.length };
      `,
      {}, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ original: 2, cloned: 3 });
  });

  it("console.table works", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const res = await runtime.execute(
      `console.table([{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }]);`,
      {}, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.stdout).toContain("Alice");
    expect(res.stdout).toContain("Bob");
  });

  it("fetch() gives helpful error when network not configured", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);

    const res = await runtime.execute(
      `
      try {
        await fetch("https://example.com");
        return "should not reach here";
      } catch (e) {
        return e.message;
      }
      `,
      {}, null, undefined, polyfills,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toMatch(/not available|network/i);
  });
});

describe("Standard fetch API in isolate", () => {
  it("fetches text content with standard API", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const fetchBinding = createFetchBinding(["example.com"], { dangerouslyAllowAll: true });
    const bindings: Record<string, IsolateBinding> = {
      __poncho_fetch: fetchBinding,
    };

    const res = await runtime.execute(
      `
      const resp = await fetch("https://example.com");
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, hasContent: text.length > 0 };
      `,
      bindings, null, undefined, polyfillsWithFetch,
    );

    expect(res.error).toBeUndefined();
    const result = res.result as { ok: boolean; status: number; hasContent: boolean };
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.hasContent).toBe(true);
  });

  it("rejects requests to non-allowed domains", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const fetchBinding = createFetchBinding(["api.example.com"]);
    const bindings: Record<string, IsolateBinding> = {
      __poncho_fetch: fetchBinding,
    };

    const res = await runtime.execute(
      `
      try {
        await fetch("https://evil.com/data");
        return "should not reach here";
      } catch (e) {
        return e.message;
      }
      `,
      bindings, null, undefined, polyfillsWithFetch,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toMatch(/blocked.*evil\.com/i);
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
      `await fs.writeFile("/secret.txt", "tenant-a-data");`,
      bindings1, null, undefined, polyfills,
    );

    // Tenant B should not see it
    const res = await runtime.execute(
      `return await fs.exists("/secret.txt");`,
      bindings2, null, undefined, polyfills,
    );

    expect(res.result).toBe(false);

    await engine.close();
  });
});
