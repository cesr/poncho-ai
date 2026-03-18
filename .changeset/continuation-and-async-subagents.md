---
"@poncho-ai/sdk": minor
"@poncho-ai/harness": minor
"@poncho-ai/browser": patch
"@poncho-ai/cli": minor
"@poncho-ai/client": minor
"@poncho-ai/messaging": patch
---

Add continuation model and fire-and-forget subagents

**Continuation model**: Agents no longer send a synthetic `"Continue"` user message between steps. Instead, the harness injects a transient signal when needed, and the full internal message chain is preserved across continuations so the LLM never loses context. `RunInput` gains `disableSoftDeadline` and `RunResult` gains `continuationMessages`.

**Fire-and-forget subagents**: Subagents now run asynchronously in the background. `spawn_subagent` returns immediately with a subagent ID; results are delivered back to the parent conversation as a callback once the subagent completes. Subagents cannot spawn their own subagents. The web UI shows results in a collapsible disclosure and reconnects the live event stream automatically when the parent agent resumes.

**Bug fixes**:
- Fixed a race condition where concurrent runs on the same harness instance could assign a subagent or browser tab to the wrong parent conversation (shared `_currentRunConversationId` field replaced with per-run `ToolContext.conversationId`).
- Fixed Upstash KV store silently dropping large values by switching from URL-path encoding to request body format for `SET`/`SETEX` commands.
- Fixed empty assistant content blocks causing Anthropic `text content blocks must be non-empty` errors.

**Client**: Added `getConversationStatus()` and `waitForSubagents` option on `sendMessage()`.
