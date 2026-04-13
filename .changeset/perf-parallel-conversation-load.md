---
"@poncho-ai/cli": patch
---

perf(web-ui): parallelize conversation and todos fetches when selecting a conversation.

Selecting a conversation in the sidebar previously issued `/api/conversations/:id` and `/api/conversations/:id/todos` sequentially, so the todos round-trip was paid on top of the (usually larger) conversation round-trip. Todos only needs the conversation id, so both requests now fire in parallel and the todos response is awaited just before the todo panel renders. The result is roughly one RTT shaved off every sidebar click, which is very noticeable on non-local connections.
