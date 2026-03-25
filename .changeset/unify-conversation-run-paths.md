---
"@poncho-ai/cli": patch
"@poncho-ai/messaging": patch
---

Unify conversation run paths into executeConversationTurn, reducing duplicated event handling and post-run persistence logic across all execution surfaces (Web UI, Telegram, cron, approvals, continuations). Net reduction of ~245 lines with no behavior changes.

Fix Telegram tool approval handler never persisting the approval decision, which prevented the resume flow from triggering. Make answerCallbackQuery best-effort so transient fetch failures don't block approval processing.
