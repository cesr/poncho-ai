// ---------------------------------------------------------------------------
// run_code tool – sandboxed JavaScript/TypeScript execution in V8 isolates.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@poncho-ai/sdk";
import type { IsolateConfig, IsolateBinding } from "../config.js";
import type { BashEnvironmentManager } from "../vfs/bash-manager.js";
import { createIsolateRuntime, type IsolateRuntime } from "./runtime.js";
import { createVfsBindings, createFetchBinding, mergeBuilderBindings } from "./bindings.js";

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

async function stripTypeScript(code: string): Promise<string> {
  const transform = await loadEsbuild();
  // Wrap in an async function before transforming so that top-level
  // `await` + `return` don't trigger esbuild's ESM detection
  // (ESM forbids top-level return).
  const wrapped = "async function __poncho_wrapper__() {\n" + code + "\n}";
  const result = await transform(wrapped, { loader: "ts" });
  // Unwrap: remove the function declaration and closing brace
  const stripped = result.code
    .replace(/^async function __poncho_wrapper__\(\) \{\n/, "")
    .replace(/\n\}\n?$/, "");
  return stripped;
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
}

export function createRunCodeTool(opts: CreateRunCodeToolOptions): ToolDefinition {
  const { config, bashManager, libraryPreamble, description } = opts;

  const memoryLimit = config.memoryLimit ?? 128;
  const timeout = config.timeLimit ?? 10_000;
  const outputLimit = config.outputLimit ?? 65_536;
  const codeLimit = config.codeLimit ?? 102_400;

  const runtime: IsolateRuntime = createIsolateRuntime({
    memoryLimit,
    timeout,
    outputLimit,
  });

  // Static bindings (created once, reused across calls)
  const staticBindings: Record<string, IsolateBinding> = {};
  if (config.apis?.fetch) {
    staticBindings.fetch = createFetchBinding(config.apis.fetch.allowedDomains);
  }
  if (config.bindings) {
    Object.assign(staticBindings, mergeBuilderBindings(config.bindings));
  }

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
      },
      additionalProperties: false,
    },
    handler: async (input, context) => {
      const code = input.code as string | undefined;
      const file = input.file as string | undefined;

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
