---
"@poncho-ai/cli": patch
---

Fix channel-targeted cron jobs returning "no known chats" when using KV conversation stores (Upstash, Vercel KV). The listSummaries call now passes the owner ID so the KV store can look up conversations.
