#!/usr/bin/env node
// Suppress Node's `ExperimentalWarning` output. The TS-stripping warnings
// (emitted every time jiti loads a .ts skill script under Node 22.6+) are
// pure noise for poncho users — there's nothing actionable. Filter via
// `process.emitWarning` so warnings still go to telemetry / logs but don't
// pollute the dev server output.
const _originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
  const name =
    typeof warning === "object" && warning !== null && "name" in warning
      ? (warning as { name?: unknown }).name
      : typeof args[0] === "string"
        ? args[0]
        : args[0] && typeof args[0] === "object" && "type" in args[0]
          ? (args[0] as { type?: unknown }).type
          : undefined;
  if (name === "ExperimentalWarning") return;
  return (_originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

import { main } from "./index.js";

void main();
