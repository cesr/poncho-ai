---
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
---

feat: tenant-authored skills in the VFS

Tenants can now author skills in their VFS at `/skills/<name>/SKILL.md`
(plus sibling files such as `scripts/*.ts` and `references/*.md`). VFS
skills are merged with the agent's repo skills per-tenant when building
the `<available_skills>` block in the system prompt; repo skills win on
name collision (a warning is logged for the dropped VFS skill).

VFS skills can ship runnable scripts in their tree (`scripts/foo.ts`
etc.); the agent runs them via the existing `run_code` tool with
`file: "/skills/<name>/scripts/foo.ts"`, which executes in the sandboxed
isolated-vm runtime. `run_skill_script` remains for repo-shipped skills
only (jiti, full Node access), and returns a clear redirect when
called against a VFS skill. The agent's tool-policy lookups still
resolve against repo skills only, so tenants cannot grant themselves
new MCP tools by uploading a SKILL.md (security boundary).

`run_code` is enhanced so skill-authored scripts feel natural:
- Accepts top-level `export const run = ...`, `export default function ...`,
  and `export default <expr>;` (the keyword is stripped at strip-TypeScript
  time; `export default <expr>` becomes a `__default` binding).
- New optional `input` parameter, exposed inside the script as the global
  `__input`.
- If the script defines a top-level `run` / `default` / `main` / `handler`
  function and doesn't `return` on its own, the dispatcher invokes that
  function with `__input` and returns its result. Existing
  return-style scripts are unaffected.

The CLI Files sidebar already exposes the VFS, so creating a tenant
skill is just writing to `/skills/...` from the UI or via the agent's
own VFS write tools — the harness invalidates its per-tenant skill
cache on writes under `/skills/`.
