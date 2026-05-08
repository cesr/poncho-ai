---
"@poncho-ai/cli": patch
"@poncho-ai/harness": patch
---

cli: include VFS skills in the chat input slash command menu

The `/api/slash-commands` endpoint was returning only repo-loaded skills,
so tenant-authored skills stored in the VFS (`/skills/<name>/SKILL.md`)
never appeared in the `/` autocomplete bar even though the agent could
already see and run them at conversation time.

The endpoint now resolves skills per-tenant via a new
`harness.listSkillsForTenant(tenantId)` and applies the same repo-wins
collision semantics used elsewhere in the harness.
