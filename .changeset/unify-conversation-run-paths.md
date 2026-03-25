---
"@poncho-ai/cli": patch
---

Unify conversation run paths into executeConversationTurn, reducing duplicated event handling and post-run persistence logic across all execution surfaces (Web UI, Telegram, cron, approvals, continuations). Net reduction of ~245 lines with no behavior changes.
