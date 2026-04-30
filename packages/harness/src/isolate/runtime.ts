// ---------------------------------------------------------------------------
// Isolate Runtime – thin wrapper around isolated-vm with async bridging,
// timeout, memory limits, and console capture.
// ---------------------------------------------------------------------------

import type { IsolateBinding } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  result?: unknown;
  stdout: string;
  stderr: string;
  error?: { message: string; name?: string; line?: number; column?: number };
  executionTimeMs: number;
}

export interface IsolateRuntime {
  execute(
    code: string,
    bindings: Record<string, IsolateBinding>,
    preamble: string | null,
    signal?: AbortSignal,
    polyfillPreamble?: string | null,
  ): Promise<ExecutionResult>;
}

// ---------------------------------------------------------------------------
// Dynamic import helper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ivmModule: any | undefined;

async function loadIvm(): Promise<typeof import("isolated-vm")> {
  if (ivmModule) return ivmModule;
  try {
    const mod = await import("isolated-vm");
    // CJS native module: handle both ESM interop shapes
    ivmModule = mod.default ?? mod;
    return ivmModule;
  } catch (err) {
    // Surface the underlying load error — `isolated-vm` is a native module
    // that frequently fails for non-MODULE_NOT_FOUND reasons (no prebuilt
    // binary for the current Node version, ABI mismatch after a Node
    // upgrade, build-from-source failure, etc.). Hiding the real error
    // wastes hours.
    const cause = err instanceof Error ? err : new Error(String(err));
    const hint = cause.message.includes("Cannot find module") ||
      (cause as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
      ? "Install with: pnpm add isolated-vm"
      : "Likely native build/ABI mismatch — try: pnpm rebuild isolated-vm " +
        "(or `cd node_modules/.pnpm/isolated-vm@*/node_modules/isolated-vm && npm rebuild`). " +
        `Node ${process.version} is on V8 ABI ${process.versions.modules}.`;
    throw new Error(
      `Code execution requires isolated-vm. ${hint}\nUnderlying error: ${cause.message}`,
      { cause },
    );
  }
}

// ---------------------------------------------------------------------------
// Runtime preamble – injected into every isolate context.
//
// Provides:
//   - console.log / console.error / console.warn  (captured to buffers)
//   - Ergonomic wrappers for __binding_* callbacks (JSON marshal/unmarshal)
// ---------------------------------------------------------------------------

function buildRuntimePreamble(): string {
  return `
// --- console capture ---
const __stdout = [];
const __stderr = [];
let __outputBytes = 0;
const __outputLimit = typeof __OUTPUT_LIMIT === "number" ? __OUTPUT_LIMIT : 65536;

function __serialize(v) {
  if (typeof v === "string") return v;
  try {
    const seen = new WeakSet();
    return JSON.stringify(v, function(_k, val) {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    }, 2);
  } catch { return String(v); }
}

function __capture(arr, args) {
  const line = Array.from(args).map(__serialize).join(" ");
  const bytes = line.length;
  if (__outputBytes + bytes > __outputLimit) {
    arr.push("[output truncated at " + __outputLimit + " bytes]");
    __outputBytes = __outputLimit;
    return;
  }
  __outputBytes += bytes;
  arr.push(line);
}

const console = {
  log:   function() { __capture(__stdout, arguments); },
  info:  function() { __capture(__stdout, arguments); },
  warn:  function() { __capture(__stderr, arguments); },
  error: function() { __capture(__stderr, arguments); },
  debug: function() { __capture(__stdout, arguments); },
};
`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createIsolateRuntime(config: {
  memoryLimit: number;
  timeout: number;
  outputLimit: number;
}): IsolateRuntime {
  return {
    async execute(code, bindings, preamble, signal, polyfillPreamble) {
      const ivm = await loadIvm();

      const isolate = new ivm.Isolate({
        memoryLimit: config.memoryLimit,
      });

      // Wire abort → dispose
      let abortHandler: (() => void) | undefined;
      let aborted = false;
      if (signal) {
        if (signal.aborted) {
          isolate.dispose();
          return {
            stdout: "",
            stderr: "",
            error: { message: "Execution cancelled", name: "AbortError" },
            executionTimeMs: 0,
          };
        }
        abortHandler = () => {
          aborted = true;
          isolate.dispose();
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      const t0 = performance.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let context: any;
      try {
        context = await isolate.createContext();
        const jail = context.global;

        // Inject output limit constant
        jail.setSync("__OUTPUT_LIMIT", config.outputLimit);

        // Inject binding References and build wrapper declarations
        const bindingNames = Object.keys(bindings);
        const wrapperDecls: string[] = [];
        for (const name of bindingNames) {
          const binding = bindings[name]!;
          const ref = new ivm.Reference(async (inputJson: string) => {
            const input = JSON.parse(inputJson) as Record<string, unknown>;
            const result = await binding.handler(input);
            return JSON.stringify(result ?? null);
          });
          jail.setSync(`__binding_${name}`, ref);
          wrapperDecls.push(
            `async function ${name}(input) {\n` +
            `  const raw = await __binding_${name}.apply(undefined, [JSON.stringify(input)], { result: { promise: true, copy: true } });\n` +
            `  return JSON.parse(raw);\n` +
            `}`,
          );
        }

        // Evaluate runtime preamble (console capture + binding wrappers)
        const runtimePreamble = buildRuntimePreamble() + "\n" + wrapperDecls.join("\n");
        await context.eval(runtimePreamble, { filename: "<runtime>" });

        // Evaluate polyfill preamble (standard APIs wrapping internal bindings)
        if (polyfillPreamble) {
          await context.eval(polyfillPreamble, { filename: "<polyfills>" });
        }

        // Evaluate library preamble (bundled libs + require shim)
        if (preamble) {
          await context.eval(preamble, { filename: "<libraries>" });
        }

        // Wrap user code in async IIFE and execute via context.eval
        // (context.eval + promise option handles Reference.apply resolution
        // correctly, unlike compileScript().run())
        const wrapped = `(async () => {\n${code}\n})()`;
        const rawResult = await context.eval(wrapped, {
          filename: "<user-code>",
          promise: true,
          copy: true,
          timeout: config.timeout,
        });

        // Read captured stdout/stderr from isolate
        const stdout = (await context.eval("__stdout.join('\\n')", { copy: true })) as string;
        const stderr = (await context.eval("__stderr.join('\\n')", { copy: true })) as string;

        // Serialize result
        let result: unknown;
        try {
          result =
            rawResult === undefined || rawResult === null
              ? rawResult
              : JSON.parse(JSON.stringify(rawResult));
        } catch {
          result = undefined;
        }

        return {
          result,
          stdout,
          stderr,
          executionTimeMs: performance.now() - t0,
        };
      } catch (err: unknown) {
        const elapsed = performance.now() - t0;

        if (aborted) {
          return {
            stdout: "",
            stderr: "",
            error: { message: "Execution cancelled", name: "AbortError" },
            executionTimeMs: elapsed,
          };
        }

        // Try to recover stdout/stderr captured before the error
        let stdout = "";
        let stderr = "";
        if (context) {
          try {
            stdout = (await context.eval("__stdout.join('\\n')", { copy: true })) as string;
            stderr = (await context.eval("__stderr.join('\\n')", { copy: true })) as string;
          } catch {
            // Context may be disposed or unavailable
          }
        }

        const error = err instanceof Error ? err : new Error(String(err));
        const parsed = parseV8Error(error);
        return {
          stdout,
          stderr,
          error: parsed,
          executionTimeMs: elapsed,
        };
      } finally {
        if (abortHandler && signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        try {
          isolate.dispose();
        } catch {
          // Already disposed (e.g. via abort)
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Error parsing – extract line/column from V8 stack traces
// ---------------------------------------------------------------------------

function parseV8Error(error: Error): {
  message: string;
  name?: string;
  line?: number;
  column?: number;
} {
  const result: { message: string; name?: string; line?: number; column?: number } = {
    message: error.message,
    name: error.name,
  };

  // Match "<user-code>:N:N" in stack trace
  const match = error.stack?.match(/<user-code>:(\d+):(\d+)/);
  if (match) {
    // Subtract 1 for the async IIFE wrapper line
    const rawLine = parseInt(match[1]!, 10);
    result.line = Math.max(1, rawLine - 1);
    result.column = parseInt(match[2]!, 10);
  }

  return result;
}
