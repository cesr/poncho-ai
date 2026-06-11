---
"@poncho-ai/harness": patch
---

conversations.rename now does a targeted title-column UPDATE instead of a
whole-row get→mutate→update. The read-modify-write raced a streaming turn's
per-step draft persist: a rename landing mid-run wrote the stale blob back
and silently reverted the turn's persisted progress.
