---
"@poncho-ai/harness": minor
"@poncho-ai/sdk": minor
---

events: add stable identity so streaming clients match instead of guess

Additive fields that let a streaming client reconstruct view-state by
identity rather than inferring structure from event order (the source of a
class of reconnect/subagent rendering bugs):

- `tool:started` / `tool:completed` / `tool:error` now carry `toolCallId`
  (already in scope as `call.id` / `result.callId`). Clients match tool
  pills by id instead of by tool name.
- `subagent:spawned|completed|error|stopped` now carry `parentToolCallId`
  (the `spawn_subagent` tool call's id) and `task`; `completed`/`error`
  also carry `resultText`. Clients attach subagent state to the spawning
  tool's pill and render the result inline — no header-regex or
  sequential-cursor pairing needed.
- `ToolContext` gains `toolCallId` so the `spawn_subagent` handler can
  record which call produced the subagent (plumbed: tool-dispatcher →
  spawn handler → `SubagentSpawnOptions.parentToolCallId` →
  `subagentMeta.parentToolCallId` → the events above).
- `run:started` gains an optional `cause` field in the type
  (`user|continuation|subagent_callback|approval_resume`); emission is
  deferred to a later pass.

All fields are additive; older clients ignore them.
