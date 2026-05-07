// ---------------------------------------------------------------------------
// Isolate module – public exports for harness integration.
// ---------------------------------------------------------------------------

export {
  createRunCodeTool,
  prepareIsolateExecutor,
  stripTypeScript,
  type CreateRunCodeToolOptions,
  type PreparedIsolateExecutor,
} from "./run-code-tool.js";
export { createIsolateRuntime, type IsolateRuntime, type ExecutionResult } from "./runtime.js";
export { generateIsolateTypeStubs, buildRunCodeDescription } from "./type-stubs.js";
export { createVfsBindings, createFetchBinding, mergeBuilderBindings } from "./bindings.js";
export { buildPolyfillPreamble } from "./polyfills.js";
export { bundleLibraries } from "./bundler.js";
