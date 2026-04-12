// ---------------------------------------------------------------------------
// Library Bundler – esbuild-based npm library bundling with require() shim.
//
// Bundles each declared library into a self-contained IIFE, then generates
// a module map + require() shim that the isolate can use.
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Dynamic import
// ---------------------------------------------------------------------------

let esbuildBuild: typeof import("esbuild").build | undefined;

async function loadEsbuild(): Promise<typeof import("esbuild").build> {
  if (esbuildBuild) return esbuildBuild;
  try {
    const mod = await import("esbuild");
    esbuildBuild = mod.build;
    return esbuildBuild;
  } catch {
    throw new Error(
      "Library bundling requires esbuild. Run: pnpm add esbuild",
    );
  }
}

// ---------------------------------------------------------------------------
// Node built-in stubs
// ---------------------------------------------------------------------------

/** Node built-ins that we refuse to polyfill — they need real OS access. */
const BLOCKED_BUILTINS = new Set([
  "fs",
  "fs/promises",
  "net",
  "tls",
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "os",
  "perf_hooks",
  "readline",
  "repl",
  "stream",
  "tty",
  "v8",
  "vm",
  "worker_threads",
  "wasi",
]);

/**
 * Build an esbuild plugin that stubs out blocked Node built-ins with a
 * throw at import time, so libraries that depend on them fail clearly.
 */
function blockedBuiltinsPlugin(): import("esbuild").Plugin {
  return {
    name: "blocked-builtins",
    setup(build) {
      // Match bare specifiers and node: prefixed
      const filter = new RegExp(
        `^(node:)?(${[...BLOCKED_BUILTINS].join("|")})$`,
      );
      build.onResolve({ filter }, (args) => ({
        path: args.path,
        namespace: "blocked-builtin",
      }));
      build.onLoad(
        { filter: /.*/, namespace: "blocked-builtin" },
        (args) => {
          const name = args.path.replace(/^node:/, "");
          return {
            contents: `throw new Error("Module '${name}' is not available in the isolate. Use the injected fs_* functions instead.");`,
            loader: "js",
          };
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bundle the declared libraries into a single JS preamble string.
 *
 * Each library is bundled as an IIFE with `globalName: '__lib_<safeName>'`.
 * The preamble ends with a module map and `require()` shim.
 *
 * @param libraries - npm package names declared in config
 * @param projectDir - project root for resolving node_modules
 * @returns Concatenated JS preamble, or null if no libraries
 */
export async function bundleLibraries(
  libraries: string[],
  projectDir: string,
): Promise<string | null> {
  if (libraries.length === 0) return null;

  const build = await loadEsbuild();
  const chunks: string[] = [];
  const moduleEntries: string[] = [];

  for (const lib of libraries) {
    // Verify the library is installed
    const pkgPath = resolve(projectDir, "node_modules", lib, "package.json");
    if (!existsSync(pkgPath)) {
      throw new Error(
        `Library '${lib}' is declared in isolate.libraries but not installed. Run: pnpm add ${lib}`,
      );
    }

    // Read version for cache key (informational)
    let version = "unknown";
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
      version = pkg.version ?? "unknown";
    } catch {
      // Non-critical
    }

    const safeName = lib.replace(/[^a-zA-Z0-9_]/g, "_");
    const globalName = `__lib_${safeName}`;

    const result = await build({
      entryPoints: [lib],
      bundle: true,
      write: false,
      format: "iife",
      globalName,
      platform: "neutral",
      target: "es2022",
      // Resolve from the project's node_modules
      nodePaths: [resolve(projectDir, "node_modules")],
      plugins: [blockedBuiltinsPlugin()],
      logLevel: "silent",
      minify: false,
    });

    if (result.outputFiles?.[0]) {
      chunks.push(
        `// --- ${lib}@${version} ---\n${result.outputFiles[0].text}`,
      );
      moduleEntries.push(`  ${JSON.stringify(lib)}: ${globalName}`);
    } else {
      throw new Error(
        `Failed to bundle library '${lib}': esbuild produced no output.`,
      );
    }
  }

  // Build the require() shim
  const requireShim = `
// --- require() shim ---
var __modules = {
${moduleEntries.join(",\n")}
};
function require(name) {
  var mod = __modules[name];
  if (!mod) throw new Error('Module "' + name + '" is not available. Available: ${libraries.join(", ")}');
  // Handle both default and namespace exports
  if (mod && mod.default !== undefined && Object.keys(mod).length === 1) return mod.default;
  return mod;
}
`;

  return chunks.join("\n\n") + "\n\n" + requireShim;
}
