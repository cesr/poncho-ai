// ---------------------------------------------------------------------------
// run_code tool – sandboxed JavaScript/TypeScript execution in V8 isolates.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { IsolateConfig, IsolateBinding, NetworkConfig } from "../config.js";
import type { BashEnvironmentManager } from "../vfs/bash-manager.js";
import { createIsolateRuntime, type IsolateRuntime } from "./runtime.js";
import { createVfsBindings, createFetchBinding, mergeBuilderBindings } from "./bindings.js";
import { buildPolyfillPreamble } from "./polyfills.js";

// ---------------------------------------------------------------------------
// TS stripping via esbuild (dynamic import)
// ---------------------------------------------------------------------------

let esbuildTransform: typeof import("esbuild").transform | undefined;

async function loadEsbuild(): Promise<typeof import("esbuild").transform> {
  if (esbuildTransform) return esbuildTransform;
  try {
    const mod = await import("esbuild");
    esbuildTransform = mod.transform;
    return esbuildTransform;
  } catch {
    throw new Error(
      "Code execution requires esbuild for TypeScript stripping. Run: pnpm add esbuild",
    );
  }
}

export async function stripTypeScript(code: string): Promise<string> {
  const transform = await loadEsbuild();
  // The runtime executes the result inside an async IIFE, so `export` keywords
  // (which require module context) would otherwise be a syntax error. Strip
  // them at the top of declarations and rewrite `export default <expr>` to a
  // `__default` binding so dispatch can find it.
  const demoduled = stripTopLevelExports(code);
  // Wrap in an async function before transforming so that top-level
  // `await` + `return` don't trigger esbuild's ESM detection
  // (ESM forbids top-level return).
  const wrapped = "async function __poncho_wrapper__() {\n" + demoduled + "\n}";
  const result = await transform(wrapped, { loader: "ts" });
  // Unwrap: remove the function declaration and closing brace
  const stripped = result.code
    .replace(/^async function __poncho_wrapper__\(\)\s*\{\n?/, "")
    .replace(/\n?\}\s*$/, "");
  return stripped;
}

/**
 * Tolerate module-style declarations in script-mode code:
 * - `export const|let|var|function|async function|class foo` → drop `export`
 * - `export default function foo(...)` / `export default class Foo` → drop `export default`
 * - `export default <expr>;` → `const __default = (<expr>);`
 */
function stripTopLevelExports(code: string): string {
  let out = code.replace(
    /^[ \t]*export\s+default\s+((?:async\s+)?function\b|class\b)/gm,
    "$1",
  );
  out = out.replace(
    /^[ \t]*export\s+(?=(?:const|let|var|function|async\s+function|class)\b)/gm,
    "",
  );
  // `export default <expression>;` — capture up to the terminating semicolon
  // (or end-of-line/file). Keep things simple: require an explicit `;`.
  out = out.replace(
    /^[ \t]*export\s+default\s+([^\n;][^;]*);/gm,
    "const __default = ($1);",
  );
  return out;
}

// ---------------------------------------------------------------------------
// Allowed file extensions for VFS file execution
// ---------------------------------------------------------------------------

const ALLOWED_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".mts"]);

function hasAllowedExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return ALLOWED_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateRunCodeToolOptions {
  config: IsolateConfig;
  bashManager: BashEnvironmentManager;
  /** Pre-built library preamble (from bundler). null if no libraries configured. */
  libraryPreamble: string | null;
  /** Dynamic tool description built from config. */
  description: string;
  /** Top-level network config — auto-registers fetch binding when set. */
  network?: NetworkConfig;
}

export interface PreparedIsolateExecutor {
  runtime: IsolateRuntime;
  staticBindings: Record<string, IsolateBinding>;
  polyfillPreamble: string | null;
  libraryPreamble: string | null;
  codeLimit: number;
  bashManager: BashEnvironmentManager;
}

export function prepareIsolateExecutor(
  opts: Omit<CreateRunCodeToolOptions, "description">,
): PreparedIsolateExecutor {
  const { config, bashManager, libraryPreamble } = opts;

  const memoryLimit = config.memoryLimit ?? 128;
  const timeout = config.timeLimit ?? 10_000;
  const outputLimit = config.outputLimit ?? 65_536;
  const codeLimit = config.codeLimit ?? 102_400;

  const runtime: IsolateRuntime = createIsolateRuntime({
    memoryLimit,
    timeout,
    outputLimit,
  });

  const staticBindings: Record<string, IsolateBinding> = {};

  if (config.apis?.fetch) {
    staticBindings.__poncho_fetch = createFetchBinding(config.apis.fetch.allowedDomains);
  } else if (opts.network) {
    const net = opts.network;
    if (net.dangerouslyAllowAll) {
      staticBindings.__poncho_fetch = createFetchBinding([], net);
    } else if (net.allowedUrls?.length) {
      const domains: string[] = [];
      for (const entry of net.allowedUrls) {
        const urlStr = typeof entry === "string" ? entry : entry.url;
        try { domains.push(new URL(urlStr).hostname); } catch { /* skip invalid */ }
      }
      if (domains.length > 0) {
        staticBindings.__poncho_fetch = createFetchBinding(domains, net);
      }
    }
  }

  if (config.bindings) {
    Object.assign(staticBindings, mergeBuilderBindings(config.bindings));
  }

  const hasNetwork = "__poncho_fetch" in staticBindings;
  const polyfillPreamble = buildPolyfillPreamble(hasNetwork);

  return {
    runtime,
    staticBindings,
    polyfillPreamble,
    libraryPreamble,
    codeLimit,
    bashManager,
  };
}

export function createRunCodeTool(opts: CreateRunCodeToolOptions): ToolDefinition {
  const { description } = opts;
  const executor = prepareIsolateExecutor(opts);
  const { runtime, staticBindings, polyfillPreamble, libraryPreamble, codeLimit, bashManager } = executor;

  return defineTool({
    name: "run_code",
    description,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript or TypeScript code to execute",
        },
        file: {
          type: "string",
          description: "Path to a .js/.ts file in the VFS to execute instead of inline code",
        },
        input: {
          type: "object",
          description:
            "Optional JSON payload. Exposed to the script as the global `__input`. " +
            "If the script defines (or `export`s) a top-level `run`, `default`, `main`, or `handler` " +
            "function and doesn't return on its own, that function is invoked with `__input` and its result is returned.",
        },
      },
      additionalProperties: false,
    },
    handler: async (input, context) => {
      const code = input.code as string | undefined;
      const file = input.file as string | undefined;
      const scriptInput =
        typeof input.input === "object" && input.input !== null
          ? (input.input as Record<string, unknown>)
          : undefined;

      // Validate exactly one of code/file
      if (code && file) {
        return { error: "Provide either `code` or `file`, not both." };
      }
      if (!code && !file) {
        return { error: "Provide either `code` (inline) or `file` (VFS path)." };
      }

      // Resolve source code
      let source: string;
      if (file) {
        if (!hasAllowedExtension(file)) {
          return {
            error: `File must have a .js, .ts, .mjs, or .mts extension. Got: "${file}"`,
          };
        }
        const tenantId = context.tenantId ?? "__default__";
        const adapter = bashManager.getAdapter(tenantId);
        try {
          source = await adapter.readFile(file);
        } catch (err) {
          return {
            error: `Failed to read file "${file}": ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } else {
        source = code!;
      }

      // Code size limit
      if (source.length > codeLimit) {
        return {
          error: `Code exceeds size limit: ${source.length} bytes > ${codeLimit} byte max.`,
        };
      }

      // Strip TypeScript
      let jsCode: string;
      try {
        jsCode = await stripTypeScript(source);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `TypeScript parse error: ${msg}` };
      }

      // Inject `__input` and a fall-through dispatch to a top-level
      // run/default/main/handler function. If the user's code already
      // returned, the dispatch suffix never executes — strict superset of
      // the previous behavior.
      const inputLiteral = scriptInput ? JSON.stringify(scriptInput) : "undefined";
      jsCode =
        `const __input = ${inputLiteral};\n` +
        `${jsCode}\n` +
        `if (typeof run === 'function') return await run(__input);\n` +
        `if (typeof __default === 'function') return await __default(__input);\n` +
        `if (typeof main === 'function') return await main(__input);\n` +
        `if (typeof handler === 'function') return await handler(__input);\n`;

      // Build per-call VFS bindings + merge with static bindings
      const tenantId = context.tenantId ?? "__default__";
      const adapter = bashManager.getAdapter(tenantId);
      const vfsBindings = createVfsBindings(adapter);
      const allBindings: Record<string, IsolateBinding> = {
        ...vfsBindings,
        ...staticBindings,
      };

      // Execute
      const result = await runtime.execute(
        jsCode,
        allBindings,
        libraryPreamble,
        context.abortSignal,
        polyfillPreamble,
      );

      // Format output
      if (result.error) {
        return {
          error: result.error.message,
          errorName: result.error.name,
          line: result.error.line,
          column: result.error.column,
          stdout: result.stdout || undefined,
          stderr: result.stderr || undefined,
          executionTimeMs: result.executionTimeMs,
        };
      }

      return {
        result: result.result,
        stdout: result.stdout || undefined,
        stderr: result.stderr || undefined,
        executionTimeMs: result.executionTimeMs,
      };
    },
  });
}
