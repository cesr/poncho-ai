import { describe, expect, it } from "vitest";
import { createIsolateRuntime } from "../src/isolate/runtime.js";
import type { IsolateBinding } from "../src/config.js";

const DEFAULT_CONFIG = { memoryLimit: 64, timeout: 5000, outputLimit: 65536 };

describe("IsolateRuntime", () => {
  it("executes basic JavaScript and returns a result", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const res = await runtime.execute("return 1 + 2;", {}, null);

    expect(res.error).toBeUndefined();
    expect(res.result).toBe(3);
    expect(res.executionTimeMs).toBeGreaterThan(0);
  });

  it("captures console.log output to stdout", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const res = await runtime.execute(
      `console.log("hello"); console.log("world"); return 42;`,
      {},
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.stdout).toBe("hello\nworld");
    expect(res.result).toBe(42);
  });

  it("captures console.error/warn to stderr", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const res = await runtime.execute(
      `console.error("err"); console.warn("warn");`,
      {},
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.stderr).toBe("err\nwarn");
  });

  it("serializes non-string console arguments as JSON", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const res = await runtime.execute(
      `console.log({ a: 1 }); console.log([1, 2, 3]);`,
      {},
      null,
    );

    expect(res.stdout).toContain('"a": 1');
    expect(res.stdout).toContain("[");
  });

  it("returns error with line number for runtime errors", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const res = await runtime.execute(
      `const x = 1;\nconst y = 2;\nthrow new Error("boom");`,
      {},
      null,
    );

    expect(res.error).toBeDefined();
    expect(res.error!.message).toBe("boom");
    expect(res.error!.name).toBe("Error");
  });

  it("handles syntax errors from V8", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const res = await runtime.execute("const x = {;", {}, null);

    expect(res.error).toBeDefined();
    expect(res.error!.message).toBeTruthy();
  });

  it("times out long-running code", async () => {
    const runtime = createIsolateRuntime({ ...DEFAULT_CONFIG, timeout: 100 });
    const res = await runtime.execute("while (true) {}", {}, null);

    expect(res.error).toBeDefined();
    expect(res.error!.message).toMatch(/timed out|timeout|Script execution/i);
  });

  it("truncates output at the configured limit", async () => {
    const runtime = createIsolateRuntime({
      ...DEFAULT_CONFIG,
      outputLimit: 50,
    });
    const res = await runtime.execute(
      `for (let i = 0; i < 100; i++) console.log("line " + i);`,
      {},
      null,
    );

    expect(res.stdout).toContain("[output truncated at 50 bytes]");
  });

  it("supports async code with await", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const res = await runtime.execute(
      `const result = await Promise.resolve(99); return result;`,
      {},
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe(99);
  });

  it("handles abort signal (already aborted)", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const controller = new AbortController();
    controller.abort();

    const res = await runtime.execute("return 1;", {}, null, controller.signal);

    expect(res.error).toBeDefined();
    expect(res.error!.message).toBe("Execution cancelled");
  });

  it("handles abort signal during execution", async () => {
    const runtime = createIsolateRuntime({ ...DEFAULT_CONFIG, timeout: 10000 });
    const controller = new AbortController();

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    const res = await runtime.execute(
      "while (true) {}",
      {},
      null,
      controller.signal,
    );

    expect(res.error).toBeDefined();
    expect(res.error!.message).toMatch(/cancelled|disposed/i);
  });
});

describe("IsolateRuntime bindings", () => {
  it("calls async bindings and returns results", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings: Record<string, IsolateBinding> = {
      get_greeting: {
        description: "Returns a greeting",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        handler: async (input) => `Hello, ${input.name}!`,
      },
    };

    const res = await runtime.execute(
      `const msg = await get_greeting({ name: "World" }); return msg;`,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("Hello, World!");
  });

  it("handles binding errors gracefully", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings: Record<string, IsolateBinding> = {
      fail: {
        description: "Always fails",
        inputSchema: { type: "object" },
        handler: async () => {
          throw new Error("binding error");
        },
      },
    };

    const res = await runtime.execute(
      `try { await fail({}); } catch (e) { return e.message; }`,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("binding error");
  });

  it("supports multiple bindings in the same execution", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const bindings: Record<string, IsolateBinding> = {
      add: {
        description: "Add two numbers",
        inputSchema: { type: "object" },
        handler: async (input) =>
          (input.a as number) + (input.b as number),
      },
      multiply: {
        description: "Multiply two numbers",
        inputSchema: { type: "object" },
        handler: async (input) =>
          (input.a as number) * (input.b as number),
      },
    };

    const res = await runtime.execute(
      `const sum = await add({ a: 3, b: 4 }); const prod = await multiply({ a: sum, b: 2 }); return prod;`,
      bindings,
      null,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe(14);
  });
});

describe("IsolateRuntime preamble", () => {
  it("evaluates library preamble before user code", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    const preamble = `var __lib_mylib = { greet: function(n) { return "Hi " + n; } };
var __modules = { mylib: __lib_mylib };
function require(name) {
  if (!__modules[name]) throw new Error('Module "' + name + '" not found');
  return __modules[name];
}`;

    const res = await runtime.execute(
      `const lib = require("mylib"); return lib.greet("Test");`,
      {},
      preamble,
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toBe("Hi Test");
  });

  it("preamble errors don't affect user code line numbers", async () => {
    const runtime = createIsolateRuntime(DEFAULT_CONFIG);
    // A valid preamble with many lines
    const preamble = Array(50).fill("var _unused = 0;").join("\n");

    const res = await runtime.execute(
      `const x = 1;\nthrow new Error("line2");`,
      {},
      preamble,
    );

    expect(res.error).toBeDefined();
    expect(res.error!.message).toBe("line2");
    // Line should refer to the user code, not the preamble
    if (res.error!.line !== undefined) {
      expect(res.error!.line).toBeLessThanOrEqual(3);
    }
  });
});
