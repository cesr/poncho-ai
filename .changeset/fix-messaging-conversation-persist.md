---
"@poncho-ai/harness": patch
---

fix: messaging conversations not persisting in SQL storage engines

The messaging runner creates conversations with a deterministic ID and calls
`update()` to persist them. But `update()` was a plain UPDATE that silently
matched zero rows for new conversations, so messages were never saved.
Changed `update()` to an upsert (INSERT ... ON CONFLICT DO UPDATE) so
conversations are created on first write and updated on subsequent ones.
