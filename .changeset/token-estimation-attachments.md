---
"@poncho-ai/harness": patch
---

fix: improve token estimation accuracy and handle missing attachments

- Use a JSON-specific token ratio for tool definitions to avoid inflating counts with many MCP tools.
- Track actual context size from model responses for compaction triggers instead of cumulative input tokens.
- Gracefully degrade when file attachments are missing or expired instead of crashing.
