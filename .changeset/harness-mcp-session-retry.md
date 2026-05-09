---
"@poncho-ai/harness": patch
---

harness: re-initialize MCP session on 404 instead of staying wedged

Streamable-HTTP MCP clients with session state (e.g. Arcade's gateway
for Gmail / Google Calendar) issue an `Mcp-Session-Id` on initialize
and expire it after some idle window. The bridge cached `sessionId`
and `initialized` in process memory and never reset them, so once the
server returned 404 for a stale session every subsequent tool call
also 404'd until the host process restarted. Long-lived deployments
(e.g. Railway) hit this; serverless platforms masked it because each
invocation re-initialized.

The client now treats `404` with a stored `sessionId` as a session
expiry signal: it clears the session, re-runs `initialize`, and
retries the request once. A 404 from initialize itself (no session
yet) is still treated as a hard endpoint failure with no retry.
