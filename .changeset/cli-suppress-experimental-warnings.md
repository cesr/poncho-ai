---
"@poncho-ai/cli": patch
---

cli: suppress Node `ExperimentalWarning` output during `poncho dev`

When running on Node 22.6+, every `.ts` skill script triggers a
`stripTypeScriptTypes is an experimental feature` warning via
`process.emitWarning`. Repeated activation of TypeScript-backed skills
spammed the dev server log with the same warning, sometimes 4–8 times
in a single agent turn.

The CLI now installs an in-process `process.emitWarning` filter at the
entry point that drops `ExperimentalWarning`s before they reach stderr.
Other warnings (deprecation, security, etc.) pass through unchanged.

If the in-process filter doesn't catch a particular warning (e.g. one
emitted from a Node internal module before user code runs), users can
still suppress them with `NODE_OPTIONS='--disable-warning=ExperimentalWarning'`.
