---
"@poncho-ai/harness": patch
---

harness: discover VFS skills written without running bash

Per-tenant VFS skill discovery was tied to the storage engine's
in-memory path cache, which was only ever populated by
`bash-manager.refreshPathCache` before a bash invocation. Chat-only
flows (PonchOS's iOS Files browser, the `write_file` tool, any agent
that never shells out) left the cache empty, the patched `writeFile`'s
incremental update was a silent no-op (it only mutates when the cache
is already initialized for that tenant), and the skill fingerprint
stuck at `""` for the lifetime of the harness instance — so any
SKILL.md authored after `getSkillsForTenant` first ran for a tenant
was invisible from that point forward.

Refresh the engine's path cache inside `getSkillsForTenant` before
computing the fingerprint. One extra SELECT-paths round-trip per
turn (skills are checked once per `buildSystemPrompt`); correctness
for the increasingly common no-bash deployments wins easily over the
saved query.

Surfaced by PonchOS (no bash, iOS Files + write_file is the only way
SKILL.md ends up in `/skills/`).
