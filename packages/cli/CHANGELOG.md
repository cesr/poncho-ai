# @poncho-ai/cli

## 0.38.2

### Patch Changes

- [`fe55b69`](https://github.com/cesr/poncho-ai/commit/fe55b69a348f530e30d9f6998ddb00666b65a983) Thanks [@cesr](https://github.com/cesr)! - dev: add a `user ↔ harness` message toggle to the web UI in verbose mode

  When `poncho dev` is run with `-v`, the web UI now shows a small `user`
  toggle button in the topbar. Clicking it switches the message area
  between the user-facing rendering and a raw view of `_harnessMessages` —
  the actual message stream sent to the model API, with role,
  runId/step/id metadata, and pretty-printed JSON content. Useful for
  debugging context construction, tool-call shape, and what the model
  actually sees turn-by-turn. Hidden entirely outside `-v` mode.

- [`1040285`](https://github.com/cesr/poncho-ai/commit/1040285496caf02bde413006d8d8324c7c5ec92d) Thanks [@cesr](https://github.com/cesr)! - dev: capture heap snapshot on OOM in `poncho dev`

  `poncho dev` now re-execs itself with `NODE_OPTIONS=--heapsnapshot-near-heap-limit=2 --max-old-space-size=4096`
  so that when the dev server hits the heap limit, V8 writes a
  `Heap.<ts>.heapsnapshot` file to the working directory before terminating.
  Open it in Chrome DevTools → Memory to inspect retainers when investigating
  memory leaks. Skipped if the user already set `NODE_OPTIONS`.

- [`8a985dc`](https://github.com/cesr/poncho-ai/commit/8a985dc5bbf027894c92d27c113fb3c4a96a500e) Thanks [@cesr](https://github.com/cesr)! - dev: add proactive heap-snapshot watchdog and SIGUSR2 trigger

  `--heapsnapshot-near-heap-limit` can fail to fire on real OOMs because V8 is
  too memory-starved to allocate the snapshot buffer by the time the hook
  runs. `poncho dev` now also runs a watchdog that calls
  `v8.writeHeapSnapshot()` proactively when `heapUsed` crosses 1.5 GB, 2.5 GB,
  and 3.3 GB — so we get evidence before the process is doomed. Snapshots
  land in cwd as `poncho-heap-auto-<threshold>mb-<ts>.heapsnapshot`.

  Also handles SIGUSR2: `kill -USR2 <pid>` writes a snapshot on demand for
  when you want to grab one without waiting for a threshold.

- [`45c71dc`](https://github.com/cesr/poncho-ai/commit/45c71dcc7ef6af24039c1302769a519671da59c2) Thanks [@cesr](https://github.com/cesr)! - fix(cli): strip large payloads and cap size on the SSE replay buffer

  The per-conversation event buffer in `broadcastEvent` only excluded
  `browser:frame` events from being retained for replay. But `tool:completed`
  events for `browser_screenshot` carry the full ~134KB base64 JPEG in
  `output.screenshot.data`, and `step:completed` / large tool outputs can be
  similarly heavy. Across a long browser-heavy session these accumulated in
  `stream.buffer` until the dev server OOM'd at ~3.7-3.8 GB heap.

  Two changes:
  1. Before pushing into the replay buffer, deep-strip any string > 4 KB
     (replaced with `[stripped-for-replay len=N]`). Live SSE subscribers still
     get the full event in real-time; only the replay buffer (used when a
     client reconnects mid-conversation) holds the stripped copy. A
     reconnecting client that wants the full screenshot can refetch the
     conversation from disk.
  2. Cap the buffer at the most recent 1000 events per conversation.

- Updated dependencies [[`d24c152`](https://github.com/cesr/poncho-ai/commit/d24c152c1ecb9bfe59b086cb1f18a5ab43688223), [`8de45a7`](https://github.com/cesr/poncho-ai/commit/8de45a7ac434fa928ae3b83deec52727073d4658), [`8e410a1`](https://github.com/cesr/poncho-ai/commit/8e410a15b246a2b129fded8d1c06b98878e5fd07)]:
  - @poncho-ai/harness@0.39.2

## 0.38.1

### Patch Changes

- [`d6248c8`](https://github.com/cesr/poncho-ai/commit/d6248c8b6d22e0fd0becde9e31dff7c12c724d84) Thanks [@cesr](https://github.com/cesr)! - fix(cli, harness): unify turn-parameter assembly so `conversation_recall` works everywhere

  The recall tool relies on three context parameters (`__conversationRecallCorpus`,
  `__conversationListFn`, `__conversationFetchFn`) that were only injected for
  user-initiated HTTP turns. Cron, reminder, messaging-adapter, chat-continuation,
  subagent-callback, and tool-approval-resume runs all built their own
  `runInput.parameters` object and silently omitted these — causing
  `conversation_recall` to throw "not available in this environment" or return
  empty results depending on the call mode.

  Introduces a single `buildTurnParameters(conversation, opts)` helper in the CLI
  that owns context-parameter assembly (recall functions, `__activeConversationId`,
  `__ownerId`, messaging metadata, tool-result archive). HTTP, messaging, and
  cron/reminder paths now go through it. The harness orchestrator's three
  internal turn sites (chat continuation, subagent-callback resume, tool-approval
  resume) now call the existing `hooks.buildRecallParams` so they pick up the
  recall functions too.

- [#101](https://github.com/cesr/poncho-ai/pull/101) [`7cc2fb5`](https://github.com/cesr/poncho-ai/commit/7cc2fb592bf11b79916df5831598a991f1ac9c0c) Thanks [@cesr](https://github.com/cesr)! - fix(web-ui): thread panel displays anchor message + replies, not full snapshot

  Shows the anchor message you forked on, plus any replies — and that's it.
  The earlier snapshot is still part of the thread's context server-side
  (the agent sees the full prior conversation), but the panel only
  displays what's relevant: the message you replied to, and what came
  after.

  Also fixes the underlying scroll bug: `.thread-panel-messages` had
  `flex: 1; overflow-y: auto` but no `min-height: 0`. In flex children
  the default `min-height: auto` lets the item grow to fit content, so
  the messages area never shrank below its content size and the scrollbar
  never engaged.

- Updated dependencies [[`244a3a3`](https://github.com/cesr/poncho-ai/commit/244a3a310c6c52f9e8535b28fb25d77829583d3f), [`d6248c8`](https://github.com/cesr/poncho-ai/commit/d6248c8b6d22e0fd0becde9e31dff7c12c724d84)]:
  - @poncho-ai/harness@0.39.1

## 0.38.0

### Minor Changes

- [#95](https://github.com/cesr/poncho-ai/pull/95) [`21ee02a`](https://github.com/cesr/poncho-ai/commit/21ee02a577cd0a85823cc3922dd0dc54c630f417) Thanks [@cesr](https://github.com/cesr)! - perf: eliminate per-conversation archive egress on the hot read path

  Three related fixes that together dramatically reduce database and
  server→browser egress for any long-lived conversation:
  - `conversationStore.get()` no longer loads the `tool_result_archive`
    column. Callers that actually need to reseed the harness archive —
    run entry points, cron runs, reminder firings — must now use the new
    `conversationStore.getWithArchive()` method instead.
  - The `GET /api/conversations/:id` response strips `_toolResultArchive`
    alongside the already-stripped `_continuationMessages` and
    `_harnessMessages`, so the browser never receives the archive payload.
  - Adds a cheap `GET /api/conversations/:id/status` endpoint backed by a
    new `getStatusSnapshot()` method that reads only summary columns (no
    `data` blob). The web UI poll loops now hit this endpoint every 2s
    and only refetch the full conversation when `updatedAt`,
    `messageCount`, or the pending-approval counts actually change.

  The SQL upsert was also updated to preserve `tool_result_archive` via
  `COALESCE(excluded, conversations.tool_result_archive)` so that updates
  on conversations loaded via the light `get()` do not clobber the
  existing archive.

- [#100](https://github.com/cesr/poncho-ai/pull/100) [`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d) Thanks [@cesr](https://github.com/cesr)! - feat: Slack-style message threads

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

### Patch Changes

- [#100](https://github.com/cesr/poncho-ai/pull/100) [`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d) Thanks [@cesr](https://github.com/cesr)! - feat(logging): readable, scoped, level-aware dev server logs

  `poncho dev` output is now formatted consistently across the CLI and
  harness:

  ```
  20:23:45 ✓ poncho     dev server ready at http://localhost:3000
  20:23:45 • slack      enabled at /api/messaging/slack
  20:23:45 • cron       scheduled 2 jobs: hourly_check, nightly_summary
  20:24:15 → cron:hourly_check  started
  20:24:17 ✓ cron:hourly_check  completed in 1.2s (3 chats)
  20:25:00 ⚠ telegram   approval not found: req-7f42a
  20:25:01 ✗ poncho     internal error: ECONNREFUSED
  ```

  Format: `HH:mm:ss <symbol> <scope> <message>`. Scopes (`poncho`, `cron`,
  `reminder`, `messaging`, `slack`, `telegram`, `resend`, `subagent`,
  `approval`, `browser`, `csrf`, `upload`, `serverless`, `self-fetch`,
  `mcp`, `telemetry`, `cost`, `model`, `harness`, `event`, `tools`)
  replace the previous mix of `[poncho]`, `[poncho][cost]`, `[cron]`,
  `[messaging-runner]`, `[event] ...`, etc.
  - New `createLogger(scope)` exported from `@poncho-ai/sdk` with
    `.debug/.info/.warn/.error/.success/.ready/.item/.child(sub)` and
    helpers `formatError`, `url`, `muted`, `num`.
  - Honors `NO_COLOR` / `FORCE_COLOR` and `LOG_LEVEL=debug|info|warn|error|silent`.
    Verbose telemetry/cost/event lines now log at `debug` and are silent
    by default.
  - `poncho dev` gains `-v`/`--verbose` (debug), `-q`/`--quiet` (warn+),
    and `--log-level <level>` flags.
  - Each scope tag is colored with a stable pastel hue (truecolor), with
    256-color and 16-color fallbacks. Children (`cron:hourly_check`)
    inherit their parent's color.
  - TTY-aware: ANSI color is stripped when stdout is piped.
  - Conversation-egress logging (`[poncho][egress] read: …`) is now opt-in
    via `PONCHO_LOG_EGRESS=1` (matching the documented behavior; it had
    been logging unconditionally).
  - No behavior changes to which events are emitted — only formatting.

- [`fcf6a02`](https://github.com/cesr/poncho-ai/commit/fcf6a027880ac94ada2e3fd732b11eed9f5f15b8) Thanks [@cesr](https://github.com/cesr)! - chore: drop browser-frame noise from the dev log

  Two sources of per-frame log noise during interactive browser use
  are now silenced:
  - `TelemetryEmitter.emit` skips `browser:frame` events alongside the
    already-skipped `model:chunk`. OTLP forwarding and custom handlers
    still receive every event unchanged.
  - The CLI's browser SSE endpoint no longer prints the
    `[poncho][browser-sse] Frame N: WxH, data bytes: ...` counter
    (which fired for the first 3 frames and every 50th). Related
    `frameCount` / `droppedFrames` state dropped with it.

- [#97](https://github.com/cesr/poncho-ai/pull/97) [`1eb1b1e`](https://github.com/cesr/poncho-ai/commit/1eb1b1e71641f79aa089a967811dcfe2de59be8d) Thanks [@cesr](https://github.com/cesr)! - refactor: extract subagent lifecycle into AgentOrchestrator (phase 5)

  Move subagent orchestration (~1100 lines) from the CLI into the
  AgentOrchestrator class in the harness package. The orchestrator now
  owns all subagent state (activeSubagentRuns, pendingSubagentApprovals,
  pendingCallbackNeeded), lifecycle methods (runSubagent,
  processSubagentCallback, triggerParentCallback), SubagentManager
  creation, approval handling, and stale recovery.

  New hooks on OrchestratorHooks allow transport-specific concerns
  (child harness creation, serverless dispatch, SSE stream lifecycle,
  messaging notifications) to stay in the CLI while the orchestrator
  handles all orchestration logic.

  Also fixes subagent approval persistence (decisions now explicitly
  written to the conversation store) and adds live SSE streaming for
  parent callback runs in the web UI.

- [`33eaf9f`](https://github.com/cesr/poncho-ai/commit/33eaf9fcc57bab916ae8a25c942912eb5d6396cc) Thanks [@cesr](https://github.com/cesr)! - fix: stop buffering `browser:frame` events for SSE replay

  Every `browser:frame` carries a base64 screenshot (~100 KB) and they
  stream at 10+ fps. `broadcastEvent` was pushing them into the
  per-conversation replay buffer (`ConversationEventStream.buffer`)
  alongside real conversation events. In a long interactive browser
  session this grew to multiple GB (observed: ~51k frames ≈ 4.4 GB of
  retained base64 strings) and eventually crashed the dev server with
  `FATAL ERROR: Reached heap limit - JavaScript heap out of memory`
  inside V8's `JsonStringify`.

  Frames are now excluded from the replay buffer — they still reach
  live SSE subscribers, they just don't accumulate for late joiners,
  matching the existing treatment of `browser:status`.

- [`a843130`](https://github.com/cesr/poncho-ai/commit/a8431303992381f338d6a90feeba03273734fd81) Thanks [@cesr](https://github.com/cesr)! - fix(web-ui): show assistant content alongside run errors

  When a run ended with `run:error` (most visibly `MAX_STEPS_EXCEEDED`),
  the web UI renderer replaced the entire assistant turn with just the
  error banner. All the text and tool activity the agent had already
  produced — which the server correctly persists — was hidden because
  the render branch was `if (_error) { only error } else { content }`.

  The renderer now renders the content first (sections, streaming tools
  and text, pending approvals) and appends the error banner at the end.
  The "waiting" spinner is also suppressed when an error is present.

- Updated dependencies [[`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d), [`fcf6a02`](https://github.com/cesr/poncho-ai/commit/fcf6a027880ac94ada2e3fd732b11eed9f5f15b8), [`1eb1b1e`](https://github.com/cesr/poncho-ai/commit/1eb1b1e71641f79aa089a967811dcfe2de59be8d), [`21ee02a`](https://github.com/cesr/poncho-ai/commit/21ee02a577cd0a85823cc3922dd0dc54c630f417), [`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d)]:
  - @poncho-ai/sdk@1.9.0
  - @poncho-ai/harness@0.39.0
  - @poncho-ai/messaging@0.8.4

## 0.37.0

### Minor Changes

- [`620a0c8`](https://github.com/cesr/poncho-ai/commit/620a0c89efaafce28968fca5cbde2e2b19bd1595) Thanks [@cesr](https://github.com/cesr)! - feat: add recurrent reminders (daily, weekly, monthly, cron)

  The `set_reminder` tool now accepts an optional `recurrence` parameter that makes reminders repeat on a schedule instead of firing once. Supports daily, weekly (with specific days-of-week), monthly, and cron expressions. Recurring reminders are rescheduled after each firing and can be bounded by `maxOccurrences` or `endsAt`. Cancel a recurring reminder to stop all future occurrences.

### Patch Changes

- [`6486de2`](https://github.com/cesr/poncho-ai/commit/6486de2242a2976068e4bd09f7c0f2d978c35c96) Thanks [@cesr](https://github.com/cesr)! - fix: persist subagent `parentConversationId` atomically so children never appear top-level in the sidebar.

  `SubagentManager.spawn` previously did a two-step write: `conversationStore.create(...)` followed by `conversationStore.update(...)` to attach `parentConversationId`, `subagentMeta`, and the initial user message. If the follow-up update was interrupted (serverless timeout, transient DB error), the child row was left in the database with `parent_conversation_id = NULL`, so it slipped past the `!c.parentConversationId` filter on `/api/conversations` and showed up as a top-level conversation. This was especially visible with cron-driven research subagents.

  `ConversationStore.create` now accepts an optional `init` bag (`parentConversationId`, `subagentMeta`, `messages`, `channelMeta`) that is written in the single INSERT — both into the `data` blob and into the dedicated `parent_conversation_id` column. `spawn` passes those fields through and drops the redundant update, eliminating the orphan window. All existing `create(ownerId, title, tenantId)` callers keep working since `init` is optional.

- Updated dependencies [[`6486de2`](https://github.com/cesr/poncho-ai/commit/6486de2242a2976068e4bd09f7c0f2d978c35c96), [`0d0578f`](https://github.com/cesr/poncho-ai/commit/0d0578fbc97a3d2644c4e22cab14ff02a79f805f), [`620a0c8`](https://github.com/cesr/poncho-ai/commit/620a0c89efaafce28968fca5cbde2e2b19bd1595)]:
  - @poncho-ai/harness@0.38.0

## 0.36.9

### Patch Changes

- [`af5b449`](https://github.com/cesr/poncho-ai/commit/af5b449b46c9994b5b7335c5d64e4c66d5d8f3d8) Thanks [@cesr](https://github.com/cesr)! - perf(web-ui): parallelize conversation and todos fetches when selecting a conversation.

  Selecting a conversation in the sidebar previously issued `/api/conversations/:id` and `/api/conversations/:id/todos` sequentially, so the todos round-trip was paid on top of the (usually larger) conversation round-trip. Todos only needs the conversation id, so both requests now fire in parallel and the todos response is awaited just before the todo panel renders. The result is roughly one RTT shaved off every sidebar click, which is very noticeable on non-local connections.

## 0.36.8

### Patch Changes

- Updated dependencies [[`2229f74`](https://github.com/cesr/poncho-ai/commit/2229f74ae4d02c5618c60787a7db925060cc1313)]:
  - @poncho-ai/harness@0.37.2

## 0.36.7

### Patch Changes

- [#89](https://github.com/cesr/poncho-ai/pull/89) [`e71cd6d`](https://github.com/cesr/poncho-ai/commit/e71cd6dcbdbba947ca5aed5f0ffddf91ac50a7e8) Thanks [@cesr](https://github.com/cesr)! - fix: surface a loud stderr warning when the CLI falls back to in-memory conversation storage (i.e. when `harness.storageEngine` is undefined). Previously this path was silent — agents appeared to work but nothing persisted to disk, no DB file was created, and the new bash tool was absent, all with zero log output. Also triggers a patch republish so the CLI tarball is re-pinned to the current workspace harness.

## 0.36.6

### Patch Changes

- Updated dependencies [[`fb61a62`](https://github.com/cesr/poncho-ai/commit/fb61a6259367f0a62d0acd7a20ef2fae93013819)]:
  - @poncho-ai/harness@0.37.1

## 0.36.5

### Patch Changes

- Updated dependencies [[`86bc5ac`](https://github.com/cesr/poncho-ai/commit/86bc5ac2a73b80a286228cd9e3b663b50b3d82e7)]:
  - @poncho-ai/harness@0.37.0

## 0.36.4

### Patch Changes

- Updated dependencies [[`d7eb744`](https://github.com/cesr/poncho-ai/commit/d7eb744fb371727278bda6a349b9e117065549b4)]:
  - @poncho-ai/harness@0.36.4

## 0.36.3

### Patch Changes

- Updated dependencies [[`abb7ec3`](https://github.com/cesr/poncho-ai/commit/abb7ec3c65503f6feaf133f5d2488dc25152a1a8)]:
  - @poncho-ai/harness@0.36.3

## 0.36.2

### Patch Changes

- Updated dependencies [[`04ebc73`](https://github.com/cesr/poncho-ai/commit/04ebc737914ee24b6f76b42016948c372d6a52d0)]:
  - @poncho-ai/harness@0.36.2

## 0.36.1

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@1.8.1
  - @poncho-ai/harness@0.36.1
  - @poncho-ai/messaging@0.8.3

## 0.36.0

### Minor Changes

- feat: unified conversation_recall tool, subagent recall access, fix subagent streaming
  - Consolidate `conversation_recall` into a single tool with three modes: keyword search, date-range listing, and full conversation fetch by ID.
  - Give subagents access to conversation recall via shared `buildRecallParams` helper.
  - Fix subagent streaming: variable scoping bug preventing poll start, race condition in `processSubagentCallback` losing concurrent results, and spawn detection race causing `pendingSubagents` flag to be missed.
  - Simplify subagent result polling to avoid duplicate messages from polling-to-SSE handoff.

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.36.0

## 0.35.0

### Minor Changes

- [`83d3c5f`](https://github.com/cesr/poncho-ai/commit/83d3c5f841fe84965d1f9fec6dfc5d8832e4489a) Thanks [@cesr](https://github.com/cesr)! - feat: add multi-tenancy with JWT-based tenant scoping

  Deploy one agent, serve many tenants with fully isolated conversations, memory, reminders, and secrets. Tenancy activates automatically when a valid JWT is received — no config changes needed.
  - **Auth**: `createTenantToken()` in client SDK, `poncho auth create-token` CLI, or any HS256 JWT library.
  - **Isolation**: conversations, memory, reminders, and todos scoped per tenant.
  - **Per-tenant secrets**: encrypted secret overrides for MCP auth tokens, manageable via CLI (`poncho secrets`), API, and web UI settings panel.
  - **MCP**: per-tenant token resolution with deferred discovery for servers without a default env var.
  - **Web UI**: `?token=` tenant access, settings cog for secret management, dark mode support.
  - **Backward compatible**: existing single-user deployments work unchanged.

### Patch Changes

- Updated dependencies [[`83d3c5f`](https://github.com/cesr/poncho-ai/commit/83d3c5f841fe84965d1f9fec6dfc5d8832e4489a)]:
  - @poncho-ai/sdk@1.8.0
  - @poncho-ai/harness@0.35.0
  - @poncho-ai/messaging@0.8.2

## 0.34.5

### Patch Changes

- Updated dependencies [[`59a88cc`](https://github.com/cesr/poncho-ai/commit/59a88cc52b5c3aa7432b820424bb8067174233e5)]:
  - @poncho-ai/harness@0.34.1

## 0.34.4

### Patch Changes

- [`8d7dadd`](https://github.com/cesr/poncho-ai/commit/8d7dadd868511b7157bcf3ee14301d7abe86bb50) Thanks [@cesr](https://github.com/cesr)! - fix: make `poncho build` target argument optional so it no-ops when called without a target (e.g. from Vercel build scripts)

- Updated dependencies [[`3f096f2`](https://github.com/cesr/poncho-ai/commit/3f096f28b9ab797b52f1b725778976929156cce9)]:
  - @poncho-ai/harness@0.34.0

## 0.34.3

### Patch Changes

- Updated dependencies [[`69dd20a`](https://github.com/cesr/poncho-ai/commit/69dd20ae31ada0edaf281cf451729ffe37f4df71)]:
  - @poncho-ai/messaging@0.8.1

## 0.34.2

### Patch Changes

- Updated dependencies [[`fb7ee97`](https://github.com/cesr/poncho-ai/commit/fb7ee97f7df0dda7318a7e59565e0b53285f10c4)]:
  - @poncho-ai/messaging@0.8.0

## 0.34.1

### Patch Changes

- [`d8fe87c`](https://github.com/cesr/poncho-ai/commit/d8fe87c68d42878829422750f98e3c70a425e3e3) Thanks [@cesr](https://github.com/cesr)! - fix: OTLP trace exporter reliability and error visibility
  - Use provider instance directly instead of global `trace.getTracer()` to avoid silent failure when another library registers a tracer provider first
  - Append `/v1/traces` to base OTLP endpoints so users can pass either the base URL or the full signal-specific URL
  - Surface HTTP status code and response body on export failures
  - Enable OTel diagnostic logger at WARN level for internal SDK errors

- Updated dependencies [[`d8fe87c`](https://github.com/cesr/poncho-ai/commit/d8fe87c68d42878829422750f98e3c70a425e3e3)]:
  - @poncho-ai/harness@0.33.1

## 0.34.0

### Minor Changes

- [#75](https://github.com/cesr/poncho-ai/pull/75) [`d447d0a`](https://github.com/cesr/poncho-ai/commit/d447d0a3cb77f3d097276b524b5f870dddf1899e) Thanks [@cesr](https://github.com/cesr)! - Add `maxRuns` option to cron jobs for automatic pruning of old conversations, preventing unbounded storage growth on hosted stores.

### Patch Changes

- Updated dependencies [[`d447d0a`](https://github.com/cesr/poncho-ai/commit/d447d0a3cb77f3d097276b524b5f870dddf1899e)]:
  - @poncho-ai/harness@0.33.0

## 0.33.4

### Patch Changes

- [#73](https://github.com/cesr/poncho-ai/pull/73) [`f72f202`](https://github.com/cesr/poncho-ai/commit/f72f202d839dbbb8240336ec76eb6340aba20f06) Thanks [@cesr](https://github.com/cesr)! - Fix Telegram approval message ordering: send accumulated assistant text before approval buttons so the conversation reads naturally. Skip empty bridge replies when text was already sent at checkpoint.

- Updated dependencies [[`f72f202`](https://github.com/cesr/poncho-ai/commit/f72f202d839dbbb8240336ec76eb6340aba20f06)]:
  - @poncho-ai/messaging@0.7.10

## 0.33.3

### Patch Changes

- [#71](https://github.com/cesr/poncho-ai/pull/71) [`3e5bf7e`](https://github.com/cesr/poncho-ai/commit/3e5bf7e527e394c5f823beac90712756e57cd491) Thanks [@cesr](https://github.com/cesr)! - Fix Telegram tool approval handler never persisting the approval decision, preventing the resume-from-checkpoint flow from triggering. Make answerCallbackQuery best-effort so transient fetch failures don't block approval processing.

- Updated dependencies [[`3e5bf7e`](https://github.com/cesr/poncho-ai/commit/3e5bf7e527e394c5f823beac90712756e57cd491)]:
  - @poncho-ai/messaging@0.7.9

## 0.33.2

### Patch Changes

- [#70](https://github.com/cesr/poncho-ai/pull/70) [`909d9d8`](https://github.com/cesr/poncho-ai/commit/909d9d86cbd62837c77637b3d3334ac086570691) Thanks [@cesr](https://github.com/cesr)! - Unify conversation run paths into executeConversationTurn, reducing duplicated event handling and post-run persistence logic across all execution surfaces (Web UI, Telegram, cron, approvals, continuations). Net reduction of ~245 lines with no behavior changes.

## 0.33.1

### Patch Changes

- Updated dependencies [[`67424e0`](https://github.com/cesr/poncho-ai/commit/67424e073b2faa28a255781f91a80f4602c745e2)]:
  - @poncho-ai/harness@0.32.1

## 0.33.0

### Minor Changes

- [#68](https://github.com/cesr/poncho-ai/pull/68) [`5a7e370`](https://github.com/cesr/poncho-ai/commit/5a7e3700a5ee441ef41cf4dc0ca70ff90e57d282) Thanks [@cesr](https://github.com/cesr)! - Add one-off reminders: agents can dynamically set, list, and cancel reminders that fire at a specific time. Fired reminders are immediately deleted from storage. Includes polling for local dev and Vercel cron integration.

### Patch Changes

- Updated dependencies [[`5a7e370`](https://github.com/cesr/poncho-ai/commit/5a7e3700a5ee441ef41cf4dc0ca70ff90e57d282)]:
  - @poncho-ai/harness@0.32.0

## 0.32.8

### Patch Changes

- [`d623f80`](https://github.com/cesr/poncho-ai/commit/d623f8024c1336dc32301b7210ebc94fd94d4877) Thanks [@cesr](https://github.com/cesr)! - Fix raw JSON tool calls rendering in web UI for Telegram conversations; archive old conversation on /new instead of deleting.

## 0.32.7

### Patch Changes

- Updated dependencies [[`30026c5`](https://github.com/cesr/poncho-ai/commit/30026c5eba3f714bb80c2402c5e8f32c6fd38d87)]:
  - @poncho-ai/messaging@0.7.8

## 0.32.6

### Patch Changes

- [#61](https://github.com/cesr/poncho-ai/pull/61) [`0a51abe`](https://github.com/cesr/poncho-ai/commit/0a51abec12191397fd36ab1fd4feca7460489e33) Thanks [@cesr](https://github.com/cesr)! - Fix /new command on Telegram in serverless environments: persist conversation reset to the store so it survives cold starts.

- Updated dependencies [[`0a51abe`](https://github.com/cesr/poncho-ai/commit/0a51abec12191397fd36ab1fd4feca7460489e33)]:
  - @poncho-ai/messaging@0.7.7

## 0.32.5

### Patch Changes

- Unify conversation run orchestration: route all message vectors through a shared executor with canonical history resolution, fixing approval loops, stale messaging context, and subagent callback reliability.

## 0.32.4

### Patch Changes

- [#58](https://github.com/cesr/poncho-ai/pull/58) [`07aad37`](https://github.com/cesr/poncho-ai/commit/07aad371ae5152199347bab11ed5c6270086db2b) Thanks [@cesr](https://github.com/cesr)! - Fix messaging conversation consistency for Telegram and other adapter-backed channels.

  This serializes per-conversation messaging runs to avoid stale concurrent context, refreshes latest conversation history before each run, and normalizes internal assistant tool-call payloads in API conversation responses for cleaner Web UI rendering.

## 0.32.3

### Patch Changes

- Updated dependencies [[`28b2913`](https://github.com/cesr/poncho-ai/commit/28b291379e640dec53a66c41a2795d0a9fbb9ee7)]:
  - @poncho-ai/harness@0.31.3

## 0.32.2

### Patch Changes

- [#54](https://github.com/cesr/poncho-ai/pull/54) [`2341915`](https://github.com/cesr/poncho-ai/commit/23419152d52c39f3bcaf8cdcd424625d5f897315) Thanks [@cesr](https://github.com/cesr)! - Reduce high-cost outliers with aggressive runtime controls and better cost visibility.

  This adds older-turn tool result archiving/truncation, tighter retry/step/subagent limits, compaction tuning, selective prompt cache behavior, and richer cache-write token attribution in logs/events.

- Updated dependencies [[`2341915`](https://github.com/cesr/poncho-ai/commit/23419152d52c39f3bcaf8cdcd424625d5f897315)]:
  - @poncho-ai/harness@0.31.2
  - @poncho-ai/sdk@1.7.1
  - @poncho-ai/messaging@0.7.6

## 0.32.1

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.31.1

## 0.32.0

### Minor Changes

- Add OpenAI Codex OAuth provider support with one-time auth bootstrap and runtime token refresh.

  This adds `openai-codex` model provider support, `poncho auth` login/status/logout/export commands, onboarding updates, and Codex request compatibility handling for OAuth-backed Responses API calls.

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.31.0
  - @poncho-ai/sdk@1.7.0
  - @poncho-ai/messaging@0.7.5

## 0.31.0

### Minor Changes

- [`193c367`](https://github.com/cesr/poncho-ai/commit/193c367568dce22a470dff6acd022c221be3b722) Thanks [@cesr](https://github.com/cesr)! - Unified continuation logic across all entry points (chat, cron, subagents, SDK) with mid-stream soft deadline checkpointing and proper context preservation across continuation boundaries.

### Patch Changes

- Updated dependencies [[`193c367`](https://github.com/cesr/poncho-ai/commit/193c367568dce22a470dff6acd022c221be3b722)]:
  - @poncho-ai/harness@0.30.0
  - @poncho-ai/sdk@1.6.3
  - @poncho-ai/messaging@0.7.4

## 0.30.8

### Patch Changes

- Updated dependencies [[`eb661a5`](https://github.com/cesr/poncho-ai/commit/eb661a554da6839702651671db8a8820ceb13f35)]:
  - @poncho-ai/harness@0.29.0
  - @poncho-ai/sdk@1.6.2
  - @poncho-ai/messaging@0.7.3

## 0.30.7

### Patch Changes

- [`af4e884`](https://github.com/cesr/poncho-ai/commit/af4e8842def6b6999836d9e0fc83edc7e3bdc801) Thanks [@cesr](https://github.com/cesr)! - Clear \_continuationMessages on cron continuation pickup to prevent 409 conflict with web UI auto-continuation

## 0.30.6

### Patch Changes

- [`56001f5`](https://github.com/cesr/poncho-ai/commit/56001f52f599f013a08e57e5de4891c02ca358d5) Thanks [@cesr](https://github.com/cesr)! - Warn at startup when CRON_SECRET is missing on Vercel with auth enabled and cron jobs configured

## 0.30.5

### Patch Changes

- [`031abc7`](https://github.com/cesr/poncho-ai/commit/031abc770b85141da5fdd209c6bf8f594f5552e4) Thanks [@cesr](https://github.com/cesr)! - Fix cron job continuation on serverless
  - Persist \_continuationMessages so cron continuations resume from correct harness state
  - Use selfFetchWithRetry with doWaitUntil instead of raw fetch for cron continuation trigger
  - Extend internal auth bypass to /api/cron/ paths for continuation self-fetch
  - Add startup warning when VERCEL_AUTOMATION_BYPASS_SECRET is missing

## 0.30.4

### Patch Changes

- [`ea8b5da`](https://github.com/cesr/poncho-ai/commit/ea8b5da1bca5d45c05a68a43c4850aacee612ffb) Thanks [@cesr](https://github.com/cesr)! - Fix internal self-fetch blocked by Vercel Deployment Protection and PONCHO_AUTH_TOKEN
  - Include x-vercel-protection-bypass header when VERCEL_AUTOMATION_BYPASS_SECRET is set
  - Internal requests with valid x-poncho-internal header bypass the PONCHO_AUTH_TOKEN auth gate
  - Better error messages distinguishing Vercel Deployment Protection from internal auth failures

## 0.30.3

### Patch Changes

- Updated dependencies [[`87f844b`](https://github.com/cesr/poncho-ai/commit/87f844b0a76ece87e4bba78eaf73392f857cdef2)]:
  - @poncho-ai/harness@0.28.3

## 0.30.2

### Patch Changes

- [`98df42f`](https://github.com/cesr/poncho-ai/commit/98df42f79e0a376d0a864598557758bfa644039d) Thanks [@cesr](https://github.com/cesr)! - Fix serverless subagent and continuation reliability
  - Use stable internal secret across serverless instances for callback auth
  - Wrap continuation self-fetches in waitUntil to survive function shutdown
  - Set runStatus during callback re-runs so clients detect active processing
  - Add post-streaming soft deadline check to catch long model responses
  - Client auto-recovers from abrupt stream termination and orphaned continuations
  - Fix callback continuation losing \_continuationMessages when no pending results

- Updated dependencies [[`98df42f`](https://github.com/cesr/poncho-ai/commit/98df42f79e0a376d0a864598557758bfa644039d)]:
  - @poncho-ai/harness@0.28.2

## 0.30.1

### Patch Changes

- [`4d50ad9`](https://github.com/cesr/poncho-ai/commit/4d50ad970886c9d3635ec36a407514c91ce6a71a) Thanks [@cesr](https://github.com/cesr)! - Improve callback-run reliability and streaming across subagent workflows, including safer concurrent approval handling and parent callback retriggers.

  Add context window/token reporting through run completion events, improve cron/web UI rendering and approval streaming behavior, and harden built-in web search retry/throttle behavior.

- Updated dependencies [[`4d50ad9`](https://github.com/cesr/poncho-ai/commit/4d50ad970886c9d3635ec36a407514c91ce6a71a)]:
  - @poncho-ai/harness@0.28.1
  - @poncho-ai/sdk@1.6.1
  - @poncho-ai/messaging@0.7.2

## 0.30.0

### Minor Changes

- [`c0ca56b`](https://github.com/cesr/poncho-ai/commit/c0ca56b54bb877d96ba8088537d6f1c7461d2a55) Thanks [@cesr](https://github.com/cesr)! - Add built-in `web_search` and `web_fetch` tools so agents can search the web and fetch page content without a browser or API keys. Remove the scaffolded `fetch-page` skill (superseded by `web_fetch`). Fix `browser_open` crash when agent projects have an older `@poncho-ai/browser` installed.

### Patch Changes

- Updated dependencies [[`c0ca56b`](https://github.com/cesr/poncho-ai/commit/c0ca56b54bb877d96ba8088537d6f1c7461d2a55)]:
  - @poncho-ai/harness@0.28.0

## 0.29.0

### Minor Changes

- [#42](https://github.com/cesr/poncho-ai/pull/42) [`e58a984`](https://github.com/cesr/poncho-ai/commit/e58a984efaa673b649318102bbf735fb4c2f9172) Thanks [@cesr](https://github.com/cesr)! - Add continuation model and fire-and-forget subagents

  **Continuation model**: Agents no longer send a synthetic `"Continue"` user message between steps. Instead, the harness injects a transient signal when needed, and the full internal message chain is preserved across continuations so the LLM never loses context. `RunInput` gains `disableSoftDeadline` and `RunResult` gains `continuationMessages`.

  **Fire-and-forget subagents**: Subagents now run asynchronously in the background. `spawn_subagent` returns immediately with a subagent ID; results are delivered back to the parent conversation as a callback once the subagent completes. Subagents cannot spawn their own subagents. The web UI shows results in a collapsible disclosure and reconnects the live event stream automatically when the parent agent resumes.

  **Bug fixes**:
  - Fixed a race condition where concurrent runs on the same harness instance could assign a subagent or browser tab to the wrong parent conversation (shared `_currentRunConversationId` field replaced with per-run `ToolContext.conversationId`).
  - Fixed Upstash KV store silently dropping large values by switching from URL-path encoding to request body format for `SET`/`SETEX` commands.
  - Fixed empty assistant content blocks causing Anthropic `text content blocks must be non-empty` errors.

  **Client**: Added `getConversationStatus()` and `waitForSubagents` option on `sendMessage()`.

### Patch Changes

- Updated dependencies [[`e58a984`](https://github.com/cesr/poncho-ai/commit/e58a984efaa673b649318102bbf735fb4c2f9172)]:
  - @poncho-ai/sdk@1.6.0
  - @poncho-ai/harness@0.27.0
  - @poncho-ai/messaging@0.7.1

## 0.28.2

### Patch Changes

- [`2ba67e8`](https://github.com/cesr/poncho-ai/commit/2ba67e89095024e4f8199a520408541803f38a60) Thanks [@cesr](https://github.com/cesr)! - Fix subagent browser panel visibility, event stream navigation between parent/subagent threads, and keep last browser frame visible when session ends.

## 0.28.1

### Patch Changes

- [`d841e0c`](https://github.com/cesr/poncho-ai/commit/d841e0c24a31293104ca3bdf050d5a2d3206c611) Thanks [@cesr](https://github.com/cesr)! - Fix web UI not connecting to subagent event stream when viewing an active subagent thread. The streaming guard now allows connecting to a different conversation's stream.

## 0.28.0

### Minor Changes

- [#40](https://github.com/cesr/poncho-ai/pull/40) [`95ae86b`](https://github.com/cesr/poncho-ai/commit/95ae86b4ea0d913357ccca9a43a227c83e46b9c4) Thanks [@cesr](https://github.com/cesr)! - Add built-in todo tools (todo_list, todo_add, todo_update, todo_remove) with per-conversation storage and a live todo panel in the web UI

### Patch Changes

- Updated dependencies [[`95ae86b`](https://github.com/cesr/poncho-ai/commit/95ae86b4ea0d913357ccca9a43a227c83e46b9c4)]:
  - @poncho-ai/harness@0.26.0

## 0.27.1

### Patch Changes

- [`5a103ca`](https://github.com/cesr/poncho-ai/commit/5a103ca62238cceaa4f4b31769a96637330d6b84) Thanks [@cesr](https://github.com/cesr)! - Split `memory_main_update` into `memory_main_write` (full overwrite) and `memory_main_edit` (targeted string replacement). Hot-reload AGENT.md and skills in dev mode without restarting the server. Merge agent + skill MCP tool patterns additively. Fix MissingToolResultsError when resuming from nested approval checkpoints.

- Updated dependencies [[`5a103ca`](https://github.com/cesr/poncho-ai/commit/5a103ca62238cceaa4f4b31769a96637330d6b84)]:
  - @poncho-ai/harness@0.25.0

## 0.27.0

### Minor Changes

- [`aee4f17`](https://github.com/cesr/poncho-ai/commit/aee4f17237d33b2cc134ed9934b709d967ca3f10) Thanks [@cesr](https://github.com/cesr)! - Add `edit_file` built-in tool with str_replace semantics for targeted file edits. The tool takes `path`, `old_str`, and `new_str` parameters, enforces uniqueness of the match, and is write-gated like `write_file` (disabled in production by default). Also improves browser SSE frame streaming with backpressure handling and auto-stops screencast when all listeners disconnect.

### Patch Changes

- Updated dependencies [[`aee4f17`](https://github.com/cesr/poncho-ai/commit/aee4f17237d33b2cc134ed9934b709d967ca3f10)]:
  - @poncho-ai/harness@0.24.0

## 0.26.0

### Minor Changes

- [`26be28a`](https://github.com/cesr/poncho-ai/commit/26be28a958f2eb27dd78225f1cf80b67b16d673d) Thanks [@cesr](https://github.com/cesr)! - Add tool approval support in Telegram via inline keyboard buttons. When the agent needs approval for a tool call, the bot sends Approve/Deny buttons to the chat. After all decisions are made, the run resumes and the response is delivered. Approvals from the web UI for Telegram conversations are also routed back to the chat.

### Patch Changes

- Updated dependencies [[`26be28a`](https://github.com/cesr/poncho-ai/commit/26be28a958f2eb27dd78225f1cf80b67b16d673d)]:
  - @poncho-ai/messaging@0.7.0

## 0.25.4

### Patch Changes

- [`827eb1d`](https://github.com/cesr/poncho-ai/commit/827eb1d231c9d70febfb47cfe00af74d32b3badd) Thanks [@cesr](https://github.com/cesr)! - Revert unnecessary Cache-Control headers from JSON API responses (the root cause was a missing ownerId, not edge caching).

## 0.25.3

### Patch Changes

- [`63f0ad5`](https://github.com/cesr/poncho-ai/commit/63f0ad509c3e673244b514341aec556a23ba5c9f) Thanks [@cesr](https://github.com/cesr)! - Fix channel-targeted cron jobs returning "no known chats" when using KV conversation stores (Upstash, Vercel KV). The listSummaries call now passes the owner ID so the KV store can look up conversations.

## 0.25.2

### Patch Changes

- [`6e56468`](https://github.com/cesr/poncho-ai/commit/6e564680ce24394e59086907affc0bf29f073e32) Thanks [@cesr](https://github.com/cesr)! - Add no-cache headers to vercel.json for API routes to prevent Vercel edge from caching dynamic endpoints.

## 0.25.1

### Patch Changes

- [`7343d7e`](https://github.com/cesr/poncho-ai/commit/7343d7e239b39d367dac09722826e3c179e7f271) Thanks [@cesr](https://github.com/cesr)! - Add Cache-Control headers to all JSON API responses to prevent Vercel CDN from caching dynamic endpoints like cron jobs.

## 0.25.0

### Minor Changes

- [`d1e1bfb`](https://github.com/cesr/poncho-ai/commit/d1e1bfbf35b18788ab79231ca675774e949f5116) Thanks [@cesr](https://github.com/cesr)! - Add proactive scheduled messaging via channel-targeted cron jobs. Cron jobs with `channel: telegram` (or `slack`) now automatically discover known conversations and send the agent's response directly to each chat, continuing the existing conversation history.

### Patch Changes

- Updated dependencies [[`d1e1bfb`](https://github.com/cesr/poncho-ai/commit/d1e1bfbf35b18788ab79231ca675774e949f5116)]:
  - @poncho-ai/harness@0.23.0
  - @poncho-ai/messaging@0.6.0

## 0.24.2

### Patch Changes

- [`70c4cfc`](https://github.com/cesr/poncho-ai/commit/70c4cfcb8d70e8b382157a82f2dc341bf526226b) Thanks [@cesr](https://github.com/cesr)! - Improve tool approval UX: optimistic approve/deny, fix browser panel not opening after approval, and restore real-time SSE streaming for resumed runs.

- [`ab4c1cb`](https://github.com/cesr/poncho-ai/commit/ab4c1cb0729a68ba0f296fd37380b5c228abfb5b) Thanks [@cesr](https://github.com/cesr)! - Fix browser hangs during long conversations in the web UI by throttling streaming renders with requestAnimationFrame and caching markdown parse output.

## 0.24.1

### Patch Changes

- [`096953d`](https://github.com/cesr/poncho-ai/commit/096953d5a64a785950ea0a7f09e2183e481afd29) Thanks [@cesr](https://github.com/cesr)! - Improve time-to-first-token by lazy-loading the recall corpus

  The recall corpus (past conversation summaries) is now fetched on-demand only when the LLM invokes the `conversation_recall` tool, instead of blocking every message with ~1.3s of upfront I/O. Also adds batch `mget` support to Upstash/Redis/DynamoDB conversation stores, parallelizes memory fetch with skill refresh, debounces skill refresh in dev mode, and caches message conversions across multi-step runs.

- Updated dependencies [[`096953d`](https://github.com/cesr/poncho-ai/commit/096953d5a64a785950ea0a7f09e2183e481afd29)]:
  - @poncho-ai/harness@0.22.1

## 0.24.0

### Minor Changes

- [`6f0abfd`](https://github.com/cesr/poncho-ai/commit/6f0abfd9f729b545cf293741ee813f705910aaf3) Thanks [@cesr](https://github.com/cesr)! - Add context compaction for long conversations. Automatically summarizes older messages when the context window fills up, keeping conversations going indefinitely. Includes auto-compaction in the run loop, `/compact` command, Web UI divider with expandable summary, and visual history preservation.

### Patch Changes

- Updated dependencies [[`6f0abfd`](https://github.com/cesr/poncho-ai/commit/6f0abfd9f729b545cf293741ee813f705910aaf3)]:
  - @poncho-ai/sdk@1.5.0
  - @poncho-ai/harness@0.22.0
  - @poncho-ai/messaging@0.5.1

## 0.23.0

### Minor Changes

- [`8ef9316`](https://github.com/cesr/poncho-ai/commit/8ef93165084b4df581e39a1581b1ead64b7b3f42) Thanks [@cesr](https://github.com/cesr)! - Add auto-continuation support for messaging adapters (Telegram, Slack, Resend) on serverless platforms. When `PONCHO_MAX_DURATION` is set, agent runs that hit the soft deadline now automatically resume with "Continue" messages, matching the web UI and client SDK behavior.

### Patch Changes

- Updated dependencies [[`8ef9316`](https://github.com/cesr/poncho-ai/commit/8ef93165084b4df581e39a1581b1ead64b7b3f42)]:
  - @poncho-ai/messaging@0.5.0

## 0.22.5

### Patch Changes

- [`76294e9`](https://github.com/cesr/poncho-ai/commit/76294e95035bf3abbb19c28871a33f82351c49ec) Thanks [@cesr](https://github.com/cesr)! - Support remote and serverless browser deployments.

  **@poncho-ai/browser**: Add `provider` and `cdpUrl` config options for cloud browser services (Browserbase, Browser Use, Kernel) and direct CDP connections. Auto-detect `@sparticuz/chromium` on serverless platforms (Vercel, Lambda) and default the profile directory to `/tmp`.

  **@poncho-ai/cli**: Generate @vercel/nft trace hints for `@poncho-ai/browser` and `@sparticuz/chromium` in the Vercel entry point so dynamically-loaded browser packages are bundled into the serverless function.

- Updated dependencies [[`76294e9`](https://github.com/cesr/poncho-ai/commit/76294e95035bf3abbb19c28871a33f82351c49ec)]:
  - @poncho-ai/harness@0.21.1

## 0.22.4

### Patch Changes

- Updated dependencies [[`f611bb9`](https://github.com/cesr/poncho-ai/commit/f611bb9137142de923d90502ece597d5cd6a5d3e)]:
  - @poncho-ai/harness@0.21.0

## 0.22.3

### Patch Changes

- Updated dependencies [[`d997362`](https://github.com/cesr/poncho-ai/commit/d997362b114f6e9c5d95794cedff2c7675e32ca5)]:
  - @poncho-ai/harness@0.20.14

## 0.22.2

### Patch Changes

- Updated dependencies [[`735eb64`](https://github.com/cesr/poncho-ai/commit/735eb6467831263671d56b58a79c736c602e594b)]:
  - @poncho-ai/harness@0.20.13

## 0.22.1

### Patch Changes

- [`3216e80`](https://github.com/cesr/poncho-ai/commit/3216e8072027896dd1cc5f29b1a7b0eea9ee1ff5) Thanks [@cesr](https://github.com/cesr)! - Add `allowedUserIds` option to Telegram adapter for restricting bot access to specific users.

- Updated dependencies [[`3216e80`](https://github.com/cesr/poncho-ai/commit/3216e8072027896dd1cc5f29b1a7b0eea9ee1ff5)]:
  - @poncho-ai/messaging@0.4.0
  - @poncho-ai/harness@0.20.12

## 0.22.0

### Minor Changes

- [`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d) Thanks [@cesr](https://github.com/cesr)! - Add Telegram messaging adapter with private/group chat support, file attachments, /new command, and typing indicators.

### Patch Changes

- Updated dependencies [[`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d)]:
  - @poncho-ai/messaging@0.3.0
  - @poncho-ai/harness@0.20.11
  - @poncho-ai/sdk@1.4.1

## 0.21.14

### Patch Changes

- Updated dependencies [[`45fc930`](https://github.com/cesr/poncho-ai/commit/45fc93066547f8ba01eb6f2fcdff560f18da3451)]:
  - @poncho-ai/harness@0.20.10

## 0.21.13

### Patch Changes

- Updated dependencies [[`29cc075`](https://github.com/cesr/poncho-ai/commit/29cc075554077db177f93fd07af031da4a69ac51)]:
  - @poncho-ai/harness@0.20.9

## 0.21.12

### Patch Changes

- Updated dependencies [[`0ec1f69`](https://github.com/cesr/poncho-ai/commit/0ec1f69a56b6424967d994663294adbbde1b9257)]:
  - @poncho-ai/harness@0.20.8

## 0.21.11

### Patch Changes

- Updated dependencies [[`8999a47`](https://github.com/cesr/poncho-ai/commit/8999a477b6e73ffb7c942a9cc5c85e704ec158b8)]:
  - @poncho-ai/harness@0.20.7

## 0.21.10

### Patch Changes

- Updated dependencies [[`e9b801f`](https://github.com/cesr/poncho-ai/commit/e9b801f0c70ffab6cb434b7adf05df22b29ea9fe)]:
  - @poncho-ai/messaging@0.2.9

## 0.21.9

### Patch Changes

- Updated dependencies [[`afbcc7b`](https://github.com/cesr/poncho-ai/commit/afbcc7b188258b7d193aa1f6f9f4462c2841ceec)]:
  - @poncho-ai/harness@0.20.6

## 0.21.8

### Patch Changes

- Updated dependencies [[`8286e1e`](https://github.com/cesr/poncho-ai/commit/8286e1ef244208d74e1daf8ef1c2a1a3afb1459e)]:
  - @poncho-ai/harness@0.20.5

## 0.21.7

### Patch Changes

- Updated dependencies [[`c35f676`](https://github.com/cesr/poncho-ai/commit/c35f676cdc548a3db9212ae7909302a5b876bc40)]:
  - @poncho-ai/harness@0.20.4

## 0.21.6

### Patch Changes

- Updated dependencies [[`28046fb`](https://github.com/cesr/poncho-ai/commit/28046fb39aea00968ac532c25db4f0d654e21876)]:
  - @poncho-ai/harness@0.20.3

## 0.21.5

### Patch Changes

- Updated dependencies [[`ec7d7a8`](https://github.com/cesr/poncho-ai/commit/ec7d7a80bf84855d19454c52053375fe86815ae4)]:
  - @poncho-ai/harness@0.20.2

## 0.21.4

### Patch Changes

- Updated dependencies [[`ec1bb60`](https://github.com/cesr/poncho-ai/commit/ec1bb601d4f47c1b50c391cdc169cbe1623b52aa)]:
  - @poncho-ai/harness@0.20.1

## 0.21.3

### Patch Changes

- [`db92933`](https://github.com/cesr/poncho-ai/commit/db92933273ba490ad4b758bfcf0d6b26c64735d0) Thanks [@cesr](https://github.com/cesr)! - Fall back to polling after approval when SSE stream ends immediately (Vercel).

## 0.21.2

### Patch Changes

- [`d06eb30`](https://github.com/cesr/poncho-ai/commit/d06eb30d896e30232b8667a93e28994ac71fedf0) Thanks [@cesr](https://github.com/cesr)! - Use `waitUntil` for messaging webhook route handlers on Vercel so the function stays alive for the full email processing after responding with 200.

## 0.21.1

### Patch Changes

- Updated dependencies [[`deb134e`](https://github.com/cesr/poncho-ai/commit/deb134e8a6ecf38d85dc200f57998e33406eff61)]:
  - @poncho-ai/messaging@0.2.8

## 0.21.0

### Minor Changes

- [`c5d94c5`](https://github.com/cesr/poncho-ai/commit/c5d94c5854081ac23e91f7104047354ad1a415ef) Thanks [@cesr](https://github.com/cesr)! - Automatically add `@vercel/functions` to project dependencies when running `poncho build vercel`. This ensures `waitUntil` is available for keeping serverless functions alive during webhook processing and approval resume.

## 0.20.3

### Patch Changes

- [`9b38474`](https://github.com/cesr/poncho-ai/commit/9b38474a25bfb54cec108d1d3eae664aaed37ccf) Thanks [@cesr](https://github.com/cesr)! - Make approval resume robust: wrap in try/catch to always clear runStatus, and await the work when waitUntil is unavailable so the resume completes before the response is sent.

## 0.20.2

### Patch Changes

- [`dcb1b51`](https://github.com/cesr/poncho-ai/commit/dcb1b51ed3be9147c982ed75e3784de38e77bc2f) Thanks [@cesr](https://github.com/cesr)! - Fix polling fallback wiping approval buttons: hydrate pending approvals on each poll cycle so the approve/deny UI stays visible.

## 0.20.1

### Patch Changes

- [`a9563b0`](https://github.com/cesr/poncho-ai/commit/a9563b03dfbdb6eb8cc9536be72b2bfd76c042ef) Thanks [@cesr](https://github.com/cesr)! - Fix approval resume dying on Vercel: wrap the post-approval tool execution and run resumption in waitUntil so the serverless function stays alive until the work completes.

## 0.20.0

### Minor Changes

- [`5df6b5f`](https://github.com/cesr/poncho-ai/commit/5df6b5fcdc98e0445bea504dc9d077f02d1e954f) Thanks [@cesr](https://github.com/cesr)! - Add polling fallback for web UI on serverless deployments: when the SSE event stream is unavailable (different instance from the webhook handler), the UI polls the conversation every 2 seconds until the run completes. Conversations now track a persisted `runStatus` field.

### Patch Changes

- Updated dependencies [[`5df6b5f`](https://github.com/cesr/poncho-ai/commit/5df6b5fcdc98e0445bea504dc9d077f02d1e954f)]:
  - @poncho-ai/harness@0.20.0

## 0.19.1

### Patch Changes

- [`470563b`](https://github.com/cesr/poncho-ai/commit/470563b96bbb5d2c6358a1c89dd3b52beb7799c8) Thanks [@cesr](https://github.com/cesr)! - Fix LocalUploadStore ENOENT on Vercel: use /tmp for uploads on serverless environments instead of the read-only working directory.

- Updated dependencies [[`470563b`](https://github.com/cesr/poncho-ai/commit/470563b96bbb5d2c6358a1c89dd3b52beb7799c8)]:
  - @poncho-ai/harness@0.19.1

## 0.19.0

### Minor Changes

- [`075b9ac`](https://github.com/cesr/poncho-ai/commit/075b9ac3556847af913bf2b58f030575c3b99852) Thanks [@cesr](https://github.com/cesr)! - Batch tool approvals, fix serverless session persistence and adapter init
  - Batch tool approvals: all approval-requiring tool calls in a single step are now collected and presented together instead of one at a time.
  - Fix messaging adapter route registration: routes are only registered after successful initialization, preventing "Adapter not initialised" errors on Vercel.
  - Add stateless signed-cookie sessions so web UI auth survives serverless cold starts.

### Patch Changes

- Updated dependencies [[`075b9ac`](https://github.com/cesr/poncho-ai/commit/075b9ac3556847af913bf2b58f030575c3b99852)]:
  - @poncho-ai/sdk@1.4.0
  - @poncho-ai/harness@0.19.0
  - @poncho-ai/messaging@0.2.7

## 0.18.0

### Minor Changes

- [`cd6ccd7`](https://github.com/cesr/poncho-ai/commit/cd6ccd7846e16fbaf17167617666796320ec29ce) Thanks [@cesr](https://github.com/cesr)! - Add MCP custom headers support, tool:generating streaming feedback, and cross-owner subagent recovery
  - **MCP custom headers**: `poncho mcp add --header "Name: value"` and `headers` config field let servers like Arcade receive extra HTTP headers alongside bearer auth.
  - **tool:generating event**: the harness now emits `tool:generating` events when the model begins writing tool-call arguments, so the web UI shows real-time "preparing <tool>" feedback instead of appearing stuck during large tool calls.
  - **Subagent recovery**: `list`/`listSummaries` accept optional `ownerId` so stale-subagent recovery on server restart scans across all owners.

### Patch Changes

- Updated dependencies [[`cd6ccd7`](https://github.com/cesr/poncho-ai/commit/cd6ccd7846e16fbaf17167617666796320ec29ce)]:
  - @poncho-ai/sdk@1.3.0
  - @poncho-ai/harness@0.18.0
  - @poncho-ai/messaging@0.2.6

## 0.17.0

### Minor Changes

- [#16](https://github.com/cesr/poncho-ai/pull/16) [`972577d`](https://github.com/cesr/poncho-ai/commit/972577d255ab43c2c56f3c3464042a8a617b7f9e) Thanks [@cesr](https://github.com/cesr)! - Add subagent support: agents can spawn recursive copies of themselves as independent sub-conversations with blocking tool calls, read-only memory, approval tunneling to the parent thread, and nested sidebar display in the web UI. Also adds ConversationStore.listSummaries() for fast sidebar loading without reading full conversation files from disk.

### Patch Changes

- Updated dependencies [[`972577d`](https://github.com/cesr/poncho-ai/commit/972577d255ab43c2c56f3c3464042a8a617b7f9e)]:
  - @poncho-ai/sdk@1.2.0
  - @poncho-ai/harness@0.17.0
  - @poncho-ai/messaging@0.2.5

## 0.16.5

### Patch Changes

- Updated dependencies [[`7475da5`](https://github.com/cesr/poncho-ai/commit/7475da5c0c2399e79064a2622137c0eb2fb16871)]:
  - @poncho-ai/harness@0.16.1

## 0.16.3

### Patch Changes

- Updated dependencies [[`12f2845`](https://github.com/cesr/poncho-ai/commit/12f28457c20e650640ff2a1c1dbece2a6e4a9ddd)]:
  - @poncho-ai/harness@0.16.0

## 0.16.1

### Patch Changes

- Fix browser session reconnection, tab lifecycle management, and web UI panel state handling.

- Updated dependencies []:
  - @poncho-ai/harness@0.15.1
  - @poncho-ai/sdk@1.1.1
  - @poncho-ai/messaging@0.2.4

## 0.16.0

### Minor Changes

- [`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b) Thanks [@cesr](https://github.com/cesr)! - Add browser automation for Poncho agents with real-time viewport streaming, per-conversation tab management, interactive browser control in the web UI, and shared agent-level profiles for authentication persistence.

### Patch Changes

- Updated dependencies [[`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b)]:
  - @poncho-ai/harness@0.15.0
  - @poncho-ai/sdk@1.1.0
  - @poncho-ai/messaging@0.2.3

## 0.15.0

### Minor Changes

- [`1f47bb4`](https://github.com/cesr/poncho-ai/commit/1f47bb49e5d48dc17644172012b057190b316469) Thanks [@cesr](https://github.com/cesr)! - Add conversation rename via double-click on the title in the web UI, standardize all credential config fields to the `*Env` naming pattern, and sync the init README template with the repo README.

### Patch Changes

- Updated dependencies [[`1f47bb4`](https://github.com/cesr/poncho-ai/commit/1f47bb49e5d48dc17644172012b057190b316469)]:
  - @poncho-ai/harness@0.14.2
  - @poncho-ai/sdk@1.0.3
  - @poncho-ai/messaging@0.2.2

## 0.14.1

### Patch Changes

- [`e000b96`](https://github.com/cesr/poncho-ai/commit/e000b96837cbbb8d95c868c91a614f458868c444) Thanks [@cesr](https://github.com/cesr)! - Durable approval checkpoints, email conversation improvements, and web UI fixes
  - Simplify approval system to checkpoint-only (remove legacy blocking approvalHandler)
  - Optimize checkpoint storage with delta messages instead of full history
  - Add sidebar sections for conversations awaiting approval with status indicator
  - Fix nested checkpoint missing baseMessageCount in resumeRunFromCheckpoint
  - Improve email conversation titles (sender email + subject)
  - Remove email threading — each incoming email creates its own conversation
  - Fix streaming after approval to preserve existing messages (liveOnly mode)
  - Preserve newlines in user messages in web UI

- Updated dependencies [[`e000b96`](https://github.com/cesr/poncho-ai/commit/e000b96837cbbb8d95c868c91a614f458868c444)]:
  - @poncho-ai/sdk@1.0.2
  - @poncho-ai/harness@0.14.1
  - @poncho-ai/messaging@0.2.1

## 0.14.0

### Minor Changes

- [`fed3e87`](https://github.com/cesr/poncho-ai/commit/fed3e870aecaea9dcbe8070f5bb2c828d4eb8921) Thanks [@cesr](https://github.com/cesr)! - Unified tool access configuration and web UI streaming for messaging conversations
  - New `tools` config in `poncho.config.js`: control any tool with `true` (available), `false` (disabled), or `'approval'` (requires human approval). Per-environment overrides via `byEnvironment`. Works for harness, adapter, MCP, and skill tools.
  - Messaging conversations (email via Resend) now stream events to the web UI: live tool progress, approval prompts, and text chunks display in real time.
  - Clicking a conversation with an active run in the web UI sidebar auto-attaches to the event stream.
  - Fix conversation persistence race condition in messaging runner (stale-write clobber).
  - Fix duplicated last section in persisted conversations.

### Patch Changes

- [`9e87d28`](https://github.com/cesr/poncho-ai/commit/9e87d2801ba7b8d4c8b0650563d59e9cad530ff6) Thanks [@cesr](https://github.com/cesr)! - Fix Latitude telemetry not exporting traces
  - Reuse a single `LatitudeTelemetry` instance across runs instead of creating one per run (avoids OpenTelemetry global registration conflicts)
  - Use `disableBatch` mode so spans export immediately instead of being silently lost on a 5s timer
  - Warn at startup when `telemetry.latitude` is configured with missing or misnamed fields (e.g. `apiKeyEnv` instead of `apiKey`)
  - Sanitize agent name for Latitude's path validation
  - Surface OTLP export errors in console output

- Updated dependencies [[`9e87d28`](https://github.com/cesr/poncho-ai/commit/9e87d2801ba7b8d4c8b0650563d59e9cad530ff6), [`fed3e87`](https://github.com/cesr/poncho-ai/commit/fed3e870aecaea9dcbe8070f5bb2c828d4eb8921)]:
  - @poncho-ai/harness@0.14.0

## 0.13.0

### Minor Changes

- [#10](https://github.com/cesr/poncho-ai/pull/10) [`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218) Thanks [@cesr](https://github.com/cesr)! - Add generic messaging layer with Slack as the first adapter. Agents can now respond to @mentions in Slack by adding `messaging: [{ platform: 'slack' }]` to `poncho.config.js`. Includes signature verification, threaded conversations, processing indicators, and Vercel `waitUntil` support.

### Patch Changes

- Updated dependencies [[`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218)]:
  - @poncho-ai/messaging@0.2.0
  - @poncho-ai/harness@0.13.1
  - @poncho-ai/sdk@1.0.1

## 0.12.0

### Minor Changes

- [#8](https://github.com/cesr/poncho-ai/pull/8) [`658bc54`](https://github.com/cesr/poncho-ai/commit/658bc54d391cb0b58aa678a2b86cd617eebdd8aa) Thanks [@cesr](https://github.com/cesr)! - Add cron job support for scheduled agent tasks. Define recurring jobs in AGENT.md frontmatter with schedule, task, and optional timezone. Includes in-process scheduler for local dev with hot-reload, HTTP endpoint for Vercel/serverless with self-continuation, Vercel scaffold generation with drift detection, and full tool activity tracking in cron conversations.

### Patch Changes

- Updated dependencies [[`658bc54`](https://github.com/cesr/poncho-ai/commit/658bc54d391cb0b58aa678a2b86cd617eebdd8aa)]:
  - @poncho-ai/harness@0.13.0

## 0.11.1

### Patch Changes

- [`0d943e5`](https://github.com/cesr/poncho-ai/commit/0d943e5b709acfe7c390bc84f1f0d10299fcc56e) Thanks [@cesr](https://github.com/cesr)! - Support paste-to-attach: pasting images or files from the clipboard into the web UI input box now adds them as attachments.

## 0.11.0

### Minor Changes

- [`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3) Thanks [@cesr](https://github.com/cesr)! - Add multimodal file support for agents — images, PDFs, and text files can be uploaded via the web UI, HTTP API, and terminal CLI. Includes pluggable upload storage (local, Vercel Blob, S3), write-behind caching, build-time dependency injection, and graceful handling of unsupported formats.

### Patch Changes

- Updated dependencies [[`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3)]:
  - @poncho-ai/sdk@1.0.0
  - @poncho-ai/harness@0.12.0

## 0.10.2

### Patch Changes

- [`3dcb914`](https://github.com/cesr/poncho-ai/commit/3dcb914acd22c403ff5372d94a0fc2152a2574b3) Thanks [@cesr](https://github.com/cesr)! - Fix scaffolded dependency versions during `poncho init` so npm installs no longer request unavailable `^0.1.0` packages.

  Improve runtime resilience by retrying transient provider/model failures, returning clearer provider error codes, and sanitizing malformed conversation history so interrupted/bad-state chats can continue.

- Updated dependencies [[`3dcb914`](https://github.com/cesr/poncho-ai/commit/3dcb914acd22c403ff5372d94a0fc2152a2574b3)]:
  - @poncho-ai/harness@0.11.2

## 0.10.1

### Patch Changes

- Updated dependencies [[`8a3937e`](https://github.com/cesr/poncho-ai/commit/8a3937e95bfb7f269e8fe46dd41640eacb30af43)]:
  - @poncho-ai/harness@0.11.1

## 0.10.0

### Minor Changes

- [`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72) Thanks [@cesr](https://github.com/cesr)! - Add cooperative run cancellation: stop active runs via Ctrl+C (CLI), stop button (Web UI), or the /stop API endpoint. Partial output is preserved and empty assistant messages are skipped to prevent conversation corruption.

### Patch Changes

- [`a95290e`](https://github.com/cesr/poncho-ai/commit/a95290e1bde10aa1dd2f668a5bcdb5201891552e) Thanks [@cesr](https://github.com/cesr)! - Render the interactive CLI mascot with high-fidelity truecolor terminal art and move mascot data into a dedicated module for maintainability.

- [`e61f479`](https://github.com/cesr/poncho-ai/commit/e61f479a839cf52db9b1a24d05d4eea637b0f4c5) Thanks [@cesr](https://github.com/cesr)! - Docs: highlight serverless-first positioning and clarify deployed agents run as stateless endpoints.

- [`a95290e`](https://github.com/cesr/poncho-ai/commit/a95290e1bde10aa1dd2f668a5bcdb5201891552e) Thanks [@cesr](https://github.com/cesr)! - Truncate long conversation titles in CLI /list output

- Updated dependencies [[`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72)]:
  - @poncho-ai/sdk@0.6.0
  - @poncho-ai/harness@0.11.0

## 0.9.4

### Patch Changes

- Reduce serverless warnings when loading TypeScript skill scripts.

  The harness now uses `jiti` first for `.ts/.mts/.cts` scripts in `run_skill_script`, avoiding Node's native ESM warning spam for TypeScript files in deployed environments.

- Updated dependencies []:
  - @poncho-ai/harness@0.10.3

## 0.9.3

### Patch Changes

- Improve runtime loading of `poncho.config.js` in serverless environments.

  The harness now falls back to `jiti` when native ESM import of `poncho.config.js` fails, allowing deploys where bundlers/runtime packaging treat project `.js` files as CommonJS. The CLI patch picks up the updated harness runtime.

- Updated dependencies []:
  - @poncho-ai/harness@0.10.2

## 0.9.2

### Patch Changes

- Fix Vercel tracing of `marked` by statically importing it in generated `api/index.mjs`.

  This ensures `marked` is included in serverless bundles when using pnpm and avoids runtime `Cannot find module 'marked'` errors in Vercel deployments.

## 0.9.1

### Patch Changes

- Fix Vercel runtime packaging for Markdown rendering in deployed agents.

  When scaffolding Vercel deploy files, ensure `marked` is added as a direct project dependency and include the `marked.umd.js` file from pnpm's store path in `vercel.json` `includeFiles` so runtime resolution works in serverless builds.

## 0.9.0

### Minor Changes

- Improve deployment scaffolding and init onboarding for production targets.

  The CLI now scaffolds deployment files directly in project roots (including Vercel `api/index.mjs` + `vercel.json`), adds safer overwrite behavior with `--force`, and normalizes runtime dependencies for deployable projects. Onboarding now captures `deploy.target` so new projects can scaffold the selected platform during `poncho init`.

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@0.5.0
  - @poncho-ai/harness@0.10.1

## 0.8.3

### Patch Changes

- Bundle fetch-page skill with init template

## 0.6.0

### Minor Changes

- Persist pending approvals on conversation state and add SSE reconnect endpoint so Web UI approvals survive page refresh and stream responses in real-time.

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.7.1

## 0.5.1

### Patch Changes

- Simplify MCP tool patterns and improve auth UI
  - Allow tool patterns without server prefix in poncho.config.js (e.g., `include: ['*']` instead of `include: ['linear/*']`)
  - Fix auth screen button styling to be fully rounded with centered arrow
  - Add self-extension capabilities section to development mode instructions
  - Update documentation to clarify MCP pattern formats

- Updated dependencies []:
  - @poncho-ai/harness@0.7.0

## 0.5.0

### Minor Changes

- Add markdown table support and fix Latitude telemetry integration
  - Add markdown table rendering with `marked` library in web UI
  - Add table styling with horizontal scroll and hover effects
  - Add margins to HR elements for better spacing
  - Integrate Latitude telemetry with Vercel AI SDK using event queue pattern
  - Enable real-time streaming while capturing complete traces
  - Fix telemetry to show all messages and interactions in Latitude dashboard

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.6.0

## 0.4.2

### Patch Changes

- Updated dependencies [d6256b2]
  - @poncho-ai/harness@0.5.0

## 0.4.1

### Patch Changes

- Fix MCP tool prefix to use `mcp:` instead of `@mcp:` for YAML compatibility. The `@` character is reserved in YAML and cannot start plain values without quoting.

- Updated dependencies []:
  - @poncho-ai/harness@0.4.1

## 0.4.0

### Minor Changes

- BREAKING: Switch to AgentSkills allowed-tools format with mcp/ prefix

  Replace nested `tools: { mcp: [...], scripts: [...] }` with flat `allowed-tools: [...]` list format. MCP tools now require `mcp/` prefix (e.g., `mcp/github/list_issues`).

  Migration: Update AGENT.md and SKILL.md frontmatter from:

  ```yaml
  tools:
    mcp:
      - github/list_issues
  ```

  To:

  ```yaml
  allowed-tools:
    - mcp/github/list_issues
  ```

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.4.0

## 0.3.2

### Patch Changes

- Fix environment detection in production deployments

  Agents deployed to Vercel, Railway, Render, AWS Lambda, and Fly.io now correctly detect their environment automatically without requiring manual NODE_ENV configuration. The resolved environment is now properly passed to the AgentHarness constructor.

## 0.3.1

### Patch Changes

- Split agent template and development context

  Move development-specific guidance from AGENT.md template into runtime-injected development context. Production agents now receive a cleaner prompt focused on task execution, while development agents get additional context about customization and setup.

- Updated dependencies []:
  - @poncho-ai/harness@0.3.1

## 0.3.0

### Minor Changes

- Implement tool policy and declarative intent system

  Add comprehensive tool policy framework for MCP and script tools with pattern matching, environment-based configuration, and declarative tool intent in AGENT.md and SKILL.md frontmatter.

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.3.0

## 0.2.0

### Minor Changes

- Initial release of Poncho - an open framework for building and deploying AI agents.
  - `@poncho-ai/sdk`: Core types and utilities for building Poncho skills
  - `@poncho-ai/harness`: Agent execution runtime with conversation loop, tool dispatch, and streaming
  - `@poncho-ai/client`: TypeScript client for calling deployed Poncho agents
  - `@poncho-ai/cli`: CLI for building and deploying AI agents

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@0.2.0
  - @poncho-ai/harness@0.2.0
