---
"@poncho-ai/cli": patch
"@poncho-ai/harness": patch
---

Improve time-to-first-token by lazy-loading the recall corpus

The recall corpus (past conversation summaries) is now fetched on-demand only when the LLM invokes the `conversation_recall` tool, instead of blocking every message with ~1.3s of upfront I/O. Also adds batch `mget` support to Upstash/Redis/DynamoDB conversation stores, parallelizes memory fetch with skill refresh, debounces skill refresh in dev mode, and caches message conversions across multi-step runs.
