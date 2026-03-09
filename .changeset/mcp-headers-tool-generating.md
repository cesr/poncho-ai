---
"@poncho-ai/sdk": minor
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
---

Add MCP custom headers support, tool:generating streaming feedback, and cross-owner subagent recovery

- **MCP custom headers**: `poncho mcp add --header "Name: value"` and `headers` config field let servers like Arcade receive extra HTTP headers alongside bearer auth.
- **tool:generating event**: the harness now emits `tool:generating` events when the model begins writing tool-call arguments, so the web UI shows real-time "preparing <tool>" feedback instead of appearing stuck during large tool calls.
- **Subagent recovery**: `list`/`listSummaries` accept optional `ownerId` so stale-subagent recovery on server restart scans across all owners.
