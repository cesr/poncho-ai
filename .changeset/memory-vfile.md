---
"@poncho-ai/cli": minor
---

feat(web-ui): expose persistent agent memory as `/memory.md` in the Files tree

The agent's per-tenant persistent memory document — previously only reachable
through the `memory_main_get` / `memory_main_write` / `memory_main_edit` tools
— now appears as a virtual file `memory.md` at the root of the Files mode.
Clicking it uses the existing markdown preview/edit UX: read inline, click
Edit to open the textarea, Save to persist. Reading and writing both go
through `engine.memory` (not the VFS), so changes the agent makes via tools
and changes a user makes through the UI see the same document.

The five VFS routes short-circuit on the path `/memory.md`:
`GET` reads from `engine.memory`, `PUT` writes (trimmed, mirroring
`memory_main_write` semantics), `DELETE` returns 400 RESERVED, `vfs-list`
splices the synthetic entry into the root listing, and `vfs-archive`
includes it in root-archive downloads. `vfs-mkdir` rejects the path.
