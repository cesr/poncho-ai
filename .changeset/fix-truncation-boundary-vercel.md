---
"@poncho-ai/harness": patch
---

Fix historical tool result truncation reliability for deployed conversations.

This stamps `runId` on all harness-authored assistant messages and adds a fallback truncation boundary for legacy histories that lack `runId` metadata.
