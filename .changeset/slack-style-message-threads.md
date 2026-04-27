---
"@poncho-ai/harness": minor
"@poncho-ai/sdk": minor
"@poncho-ai/client": minor
"@poncho-ai/cli": minor
---

feat: Slack-style message threads

Users can now fork any persisted message into one or more threads. Each
thread is a new conversation whose initial history is a snapshot of the
parent up to and including the anchor message; replies in the thread
evolve independently of the parent. Multiple threads per parent message
are supported.

## Web UI

- Hover any message in the main pane to reveal a "Reply in thread" pill
  positioned just below the bubble (offset varies by role). The pill is
  invisible by default and only appears on hover; a delayed-hide bridges
  the empty space between message and pill so the user can move the
  mouse onto it without it flickering off.
- Once a thread exists on a message, the pill is replaced by an
  always-visible badge (`"N replies · 5m ago"`, count bold + meta muted).
  Multiple threads stack vertically under the message, each with its own
  badge. Hovering a badge reveals an outside-positioned `×` delete with
  the same two-step "× → sure?" confirmation as the sidebar
  conversation-delete.
- Clicking a badge opens the thread in a right-side panel that mirrors
  the existing browser-panel pattern: a flex sibling of `.main-chat`
  with a 1px drag-resize handle. The panel has its own composer
  (independent file uploads, paste-to-attach, attachment preview)
  rendered alongside the main composer so users can keep typing in the
  parent conversation. Vertical padding matches the main composer so
  both chatboxes line up at the same baseline.
- The pinned parent message and replies inside the panel render through
  the same DOM construction logic as the main pane (assistant avatar +
  markdown, user bubble + file thumbnails). Reply submissions stream
  token-by-token via SSE (parsed model:chunk events feed an optimistic
  assistant placeholder; a thinking-indicator shows until the first
  chunk lands).
- The open thread is reflected in the URL hash (`#thread=<id>`) so a
  page reload restores the panel. Switching conversations or closing
  the panel clears the hash and any sticky drag-resize widths.

## DB

- New `parent_message_id TEXT` column on `conversations` (migration 6)
  plus a partial index on `(parent_conversation_id, parent_message_id)
  WHERE parent_message_id IS NOT NULL`.
- The existing `parent_conversation_id` plumbing is reused; subagents
  and threads coexist on that column, discriminated by whether
  `parent_message_id` is set (subagents leave it `NULL`).
- `threadMeta` (snapshot length + cached parent-message summary)
  round-trips inside the conversation `data` blob.

## API

- `GET /api/conversations/:id/threads` → `{ threads: ApiThreadSummary[] }`
- `POST /api/conversations/:id/threads { parentMessageId, title? }` →
  201 `{ thread, conversationId }` |
  404 `PARENT_MESSAGE_NOT_FOUND` |
  409 `MESSAGE_ID_REQUIRED` (anchor lacks a stable id) |
  409 `ANCHOR_IN_FLIGHT` (anchor is the streaming tail of a live run)
- The two `SUBAGENT_READ_ONLY` gates on `/messages` and `/continue` are
  now keyed on `subagentMeta` rather than `parentConversationId` so
  threads remain writable.
- New `ApiThreadSummary`, `ApiThreadListResponse`,
  `ApiCreateThreadRequest`, `ApiCreateThreadResponse` types in
  `@poncho-ai/sdk`. New `AgentClient.listThreads` /
  `AgentClient.createThread` wrappers in `@poncho-ai/client`.

## Storage interface

- `ConversationStore.listThreads(parentConversationId)` and the
  matching `StorageEngine.conversations.listThreads(...)`. External
  implementers of these interfaces will need to add the method.
- `Conversation` / `ConversationCreateInit` / `ConversationSummary`
  gained optional `parentMessageId` and `threadMeta` fields.

## Fork semantics

- Stable `metadata.id` on every persisted message: `randomUUID()` is
  hoisted once per turn and reused for both the user message and the
  in-flight assistant message across all persist sites (cli messaging
  run, cli `/messages` handler, cron path). `buildAssistantMetadata`
  takes an optional `{ id, timestamp }` opt-arg.
- No DB backfill of legacy id-less messages; the SPA hides the
  "Reply in thread" affordance on rows whose `metadata.id` is missing.
- The visible-sequence used for the anchor lookup is reconstructed as
  `[...compactedHistory, ...messages.filter(notCompactionSummary)]`,
  so pre-compaction anchors are supported. For pre-compaction anchors,
  `_harnessMessages` is reset to `undefined` so the harness rebuilds
  canonical history from `messages` on the thread's first run.
- Forking on the actively-streaming tail message of a live run returns
  409 `ANCHOR_IN_FLIGHT`; any prior, already-persisted message is
  fork-able even while the parent is mid-run.
- Tool-result archive entries are filtered to only those referenced by
  tool calls in the trimmed `_harnessMessages` (no whole-archive clones).
- All run-specific state is reset on the new thread:
  `runtimeRunId`, `pendingApprovals`, `runStatus`,
  `pendingSubagentResults`, `subagentCallbackCount`,
  `runningCallbackSince`, `_continuationMessages`. `channelMeta` and
  `subagentMeta` are explicitly NOT inherited so threads aren't bound
  to the parent's Slack/Telegram thread and aren't subagent runs.
- Thread conversations stay out of the sidebar list (already-existing
  `!c.parentConversationId` filter) and are cascade-deleted with their
  parent.
