---
"@poncho-ai/harness": patch
---

chore(harness): declare `engines.node` as `>=20.0.0 <25.0.0`

`isolated-vm@6.1.2` (the version harness uses for sandboxed code execution)
ships V8-ABI-specific prebuilt binaries up to ABI 137 (Node 24). Node 25
reports ABI 141 and has no matching prebuild, so the native module fails
to load. Declaring the upper bound makes pnpm/npm warn (or hard-fail with
`engine-strict`) at install time on Node 25, instead of surfacing as a
runtime error the first time `run_code` is invoked.
