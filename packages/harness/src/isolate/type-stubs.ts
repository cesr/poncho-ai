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

  // VFS
  lines.push(
    "// Filesystem (persistent virtual filesystem, all async)",
    "declare function fs_read(input: { path: string }): Promise<string>;",
    "declare function fs_write(input: { path: string; content: string }): Promise<void>;",
    "declare function fs_read_binary(input: { path: string }): Promise<string>; // returns base64",
    "declare function fs_write_binary(input: { path: string; content: string }): Promise<void>; // content is base64",
    "declare function fs_list(input: { path: string }): Promise<string[]>;",
    "declare function fs_exists(input: { path: string }): Promise<boolean>;",
    "declare function fs_delete(input: { path: string }): Promise<void>;",
    "declare function fs_mkdir(input: { path: string }): Promise<void>;",
    "declare function fs_stat(input: { path: string }): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: string }>;",
  );

  // Fetch
  if (config.apis?.fetch) {
    const domains = config.apis.fetch.allowedDomains.join(", ");
    lines.push(
      "",
      `// HTTP fetch (restricted to: ${domains})`,
      "declare function fetch(input: { url: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string>; body: string }>;",
    );
  }

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

  // Console
  lines.push(
    "",
    "// Console (output captured and returned in tool result)",
    "declare const console: { log(...args: unknown[]): void; error(...args: unknown[]): void; warn(...args: unknown[]): void; info(...args: unknown[]): void; debug(...args: unknown[]): void; };",
  );

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
export function buildRunCodeDescription(config: IsolateConfig): string {
  const parts: string[] = [
    "Execute JavaScript/TypeScript code in a sandboxed V8 isolate.",
    "",
    "Input: provide either `code` (inline string) or `file` (path to a .js/.ts file in the VFS).",
    "",
    "Available APIs inside the isolate (all async, all take a single object argument):",
    "- fs_read({path}) / fs_write({path, content}) / fs_read_binary({path}) / fs_write_binary({path, content})",
    "- fs_list({path}) / fs_exists({path}) / fs_delete({path}) / fs_mkdir({path}) / fs_stat({path})",
    "- console.log() / console.error() -- output captured and returned (not async)",
  ];

  if (config.apis?.fetch) {
    parts.push(
      `- fetch({url, method?, headers?, body?}) -- restricted to: ${config.apis.fetch.allowedDomains.join(", ")}`,
    );
  }

  if (config.bindings) {
    for (const [name, binding] of Object.entries(config.bindings)) {
      parts.push(`- ${name}({...}) -- ${binding.description}`);
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
