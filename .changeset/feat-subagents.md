---
"@poncho-ai/sdk": minor
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
---

Add subagent support: agents can spawn recursive copies of themselves as independent sub-conversations with blocking tool calls, read-only memory, approval tunneling to the parent thread, and nested sidebar display in the web UI. Also adds ConversationStore.listSummaries() for fast sidebar loading without reading full conversation files from disk.
