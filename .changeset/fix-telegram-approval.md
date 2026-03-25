---
"@poncho-ai/cli": patch
"@poncho-ai/messaging": patch
---

Fix Telegram tool approval handler never persisting the approval decision, preventing the resume-from-checkpoint flow from triggering. Make answerCallbackQuery best-effort so transient fetch failures don't block approval processing.
