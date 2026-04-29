---
"@poncho-ai/harness": patch
---

fix(harness): don't archive `browser_screenshot` / `browser_snapshot` payloads

The per-conversation `_toolResultArchive` had no size cap or eviction, and
browser tool results were being archived in full — base64 JPEG screenshots
(~50-500KB each) and accessibility-tree snapshots accumulated for the lifetime
of a conversation. Heavy browser sessions OOM'd `poncho dev` after ~80 minutes.

Skip archiving for view-once tool results (`browser_screenshot`,
`browser_snapshot`). The model consumes them in-step; they're never retrieved
after-the-fact, so archiving them only burns memory.
