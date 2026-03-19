---
"@poncho-ai/cli": patch
---

Fix cron job continuation on serverless

- Persist _continuationMessages so cron continuations resume from correct harness state
- Use selfFetchWithRetry with doWaitUntil instead of raw fetch for cron continuation trigger
- Extend internal auth bypass to /api/cron/ paths for continuation self-fetch
- Add startup warning when VERCEL_AUTOMATION_BYPASS_SECRET is missing
