---
"@poncho-ai/harness": patch
"@poncho-ai/cli": patch
---

fix: persist subagent `parentConversationId` atomically so children never appear top-level in the sidebar.

`SubagentManager.spawn` previously did a two-step write: `conversationStore.create(...)` followed by `conversationStore.update(...)` to attach `parentConversationId`, `subagentMeta`, and the initial user message. If the follow-up update was interrupted (serverless timeout, transient DB error), the child row was left in the database with `parent_conversation_id = NULL`, so it slipped past the `!c.parentConversationId` filter on `/api/conversations` and showed up as a top-level conversation. This was especially visible with cron-driven research subagents.

`ConversationStore.create` now accepts an optional `init` bag (`parentConversationId`, `subagentMeta`, `messages`, `channelMeta`) that is written in the single INSERT — both into the `data` blob and into the dedicated `parent_conversation_id` column. `spawn` passes those fields through and drops the redundant update, eliminating the orphan window. All existing `create(ownerId, title, tenantId)` callers keep working since `init` is optional.
