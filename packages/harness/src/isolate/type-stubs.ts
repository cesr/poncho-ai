// ---------------------------------------------------------------------------
// Type stubs – generate TypeScript declarations for the isolate system prompt.
// ---------------------------------------------------------------------------

import type { IsolateConfig, IsolateBinding } from "../config.js";

/**
 * Build a TypeScript declaration block listing all APIs available inside the
 * isolate. Included in the agent system prompt when `run_code` is registered.
 */
export function generateIsolateTypeStubs(config: IsolateConfig): string {
  const lines: string[] = [];

  // Standard APIs
  lines.push(
    "// Standard Web/Node.js APIs available in the sandbox",
    "",
    "// --- fetch (standard Web API) ---",
    "declare function fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response>;",
    "declare class Response {",
    "  readonly ok: boolean;",
    "  readonly status: number;",
    "  readonly statusText: string;",
    "  readonly headers: Headers;",
    "  text(): Promise<string>;",
    "  json(): Promise<any>;",
    "  arrayBuffer(): Promise<ArrayBuffer>;",
    "  blob(): Promise<Blob>;",
    "}",
    "",
    "// --- fs (Node.js-compatible) ---",
    "declare const fs: {",
    "  readFile(path: string, encoding?: string): Promise<string | Buffer>;",
    "  writeFile(path: string, data: string | Buffer | Uint8Array): Promise<void>;",
    "  readdir(path: string): Promise<string[]>;",
    "  mkdir(path: string): Promise<void>;",
    "  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number; mtime: Date }>;",
    "  exists(path: string): Promise<boolean>;",
    "  unlink(path: string): Promise<void>;",
    "  rm(path: string): Promise<void>;",
    "};",
    "",
    "// --- path ---",
    "declare const path: {",
    "  join(...parts: string[]): string;",
    "  resolve(...parts: string[]): string;",
    "  basename(p: string, ext?: string): string;",
    "  dirname(p: string): string;",
    "  extname(p: string): string;",
    "};",
    "",
    "// --- Buffer, encoding, crypto ---",
    "declare class Buffer extends Uint8Array {",
    "  static from(input: string | ArrayBuffer | Uint8Array | number[], encoding?: string): Buffer;",
    "  static alloc(size: number, fill?: number): Buffer;",
    "  static concat(list: Uint8Array[]): Buffer;",
    "  toString(encoding?: 'utf-8' | 'base64' | 'hex'): string;",
    "}",
    "declare function atob(data: string): string;",
    "declare function btoa(data: string): string;",
    "declare function setTimeout(fn: () => void, ms?: number): number;",
    "declare function clearTimeout(id: number): void;",
    "declare const crypto: { randomUUID(): string; getRandomValues(arr: Uint8Array): Uint8Array };",
    "declare function structuredClone<T>(value: T): T;",
  );

  // Console
  lines.push(
    "",
    "// Console (output captured and returned in tool result)",
    "declare const console: {",
    "  log(...args: unknown[]): void; error(...args: unknown[]): void;",
    "  warn(...args: unknown[]): void; info(...args: unknown[]): void;",
    "  table(data: unknown): void; time(label?: string): void; timeEnd(label?: string): void;",
    "};",
  );

  // Builder custom bindings
  if (config.bindings) {
    const entries = Object.entries(config.bindings);
    if (entries.length > 0) {
      lines.push("", "// Custom bindings");
      for (const [name, binding] of entries) {
        lines.push(formatBindingStub(name, binding));
      }
    }
  }

  // Libraries
  if (config.libraries?.length) {
    lines.push(
      "",
      `// Pre-bundled libraries (use require())`,
      `declare function require(name: ${config.libraries.map((l) => `"${l}"`).join(" | ")}): any;`,
    );
  }

  return lines.join("\n");
}

/**
 * Build the dynamic tool description for `run_code` based on the isolate config.
 */
export function buildRunCodeDescription(
  config: IsolateConfig,
  hasNetwork?: boolean,
): string {
  const parts: string[] = [
    "Execute JavaScript/TypeScript code in a sandboxed V8 isolate with standard Node.js/Web APIs.",
    "",
    "Input: provide either `code` (inline string) or `file` (path to a .js/.ts file in the VFS).",
    "",
    "Available standard APIs:",
    "- fs.readFile(path, encoding?) / fs.writeFile(path, data) / fs.readdir(path) / fs.mkdir(path)",
    "- fs.stat(path) / fs.exists(path) / fs.unlink(path)",
    "- path.join() / path.resolve() / path.basename() / path.dirname() / path.extname()",
    "- Buffer.from() / Buffer.alloc() / Buffer.concat() / buf.toString(encoding)",
    "- atob() / btoa() / setTimeout() / crypto.randomUUID() / structuredClone()",
    "- console.log() / console.error() / console.table()",
  ];

  if (hasNetwork || config.apis?.fetch) {
    parts.push(
      "- fetch(url, init?) — standard Web fetch API with Response.text(), .json(), .arrayBuffer()",
    );
  } else {
    parts.push(
      "- fetch() — not available (enable `network` in poncho.config.js)",
    );
  }

  if (config.bindings) {
    for (const [name, binding] of Object.entries(config.bindings)) {
      parts.push(`- ${name}({...}) — ${binding.description}`);
    }
  }

  if (config.libraries?.length) {
    parts.push(
      "",
      `Pre-bundled libraries (use require()):`,
      `- ${config.libraries.join(", ")}`,
    );
  }

  const memoryLimit = config.memoryLimit ?? 128;
  const timeLimit = config.timeLimit ?? 10_000;
  const codeLimit = config.codeLimit ?? 102_400;
  parts.push(
    "",
    "Notes:",
    "- Code is wrapped in an async IIFE. Use `return` to return a value.",
    "- Files written during execution persist even if the code throws an error.",
    "- TypeScript is supported (type annotations are stripped before execution).",
    `- Execution timeout: ${timeLimit / 1000}s. Memory limit: ${memoryLimit}MB. Max code size: ${Math.round(codeLimit / 1024)}KB.`,
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBindingStub(name: string, binding: IsolateBinding): string {
  const schema = binding.inputSchema;
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const params = Object.entries(props)
    .map(([k, v]) => {
      const opt = required.has(k) ? "" : "?";
      const tsType = jsonSchemaToTsType(v);
      return `${k}${opt}: ${tsType}`;
    })
    .join("; ");

  return `declare function ${name}(input: { ${params} }): Promise<unknown>; // ${binding.description}`;
}

function jsonSchemaToTsType(schema: { type?: string; [key: string]: unknown }): string {
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "unknown[]";
    case "object":
      return "Record<string, unknown>";
    default:
      return "unknown";
  }
}
