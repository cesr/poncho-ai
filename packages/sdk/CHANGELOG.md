# @poncho-ai/sdk

## 1.11.0

### Minor Changes

- [`1adaae2`](https://github.com/cesr/poncho-ai/commit/1adaae2d4cc55800f01d602f2a7d6ecc65031443) Thanks [@cesr](https://github.com/cesr)! - harness: device-dispatch mode for tools that execute on a connected client

  Tools can now be marked `dispatch: "device"` on `loadedConfig.tools`. When
  the model calls such a tool the dispatcher pauses the run, emits a new
  `tool:device:required` event, and checkpoints with the new
  `kind: "device"` discriminator on `pendingApprovals` — same plumbing as
  the approval flow, different trigger and different resume payload.
  Consumers (e.g. PonchOS for iOS device tools) drive the external
  execution and feed the result back via `continueFromToolResult`.

  Approval can be combined: `{access: "approval", dispatch: "device"}`
  yields the approval card first, then on resume falls through to the
  device-required event. The wire vocabulary for approvals
  (`approvalId` etc.) is unchanged; the `pendingApprovals` column /
  field name stays.

  `ToolAccess` is broadened to accept both the legacy string `"approval"`
  and the new `{access?, dispatch?}` object form. Existing configs keep
  working unchanged.

## 1.10.0

### Minor Changes

- [#104](https://github.com/cesr/poncho-ai/pull/104) [`9616060`](https://github.com/cesr/poncho-ai/commit/96160607502c2c0b05bc60b67b8fc012f4052ef1) Thanks [@cesr](https://github.com/cesr)! - dev: add a Files mode to the sidebar with VFS browsing, preview, and uploads

  The web UI sidebar now has a Chats / Files segmented control. Switching to
  Files reveals a folder-tree view of the agent's VFS — the same storage the
  agent reads and writes via `read_file`, `write_file`, and the virtualized
  `bash` tool. Folders expand inline with the same caret/dropdown pattern as
  the Cron jobs section. Clicking a file previews it in the main panel:
  - Text / JSON / source code render as a wrapped `<pre>` (5 MB cap), with an Edit button for inline editing (last-write-wins via PUT).
  - Images render inline.
  - PDFs render in an embedded iframe.
  - Audio and video render with native controls.
  - Anything else shows a placeholder card with a Download button.

  Files can be added directly from the UI: an Upload button (multi-file
  picker), drag-and-drop onto the explorer or onto a specific folder row, and
  a New folder button. Files and folders are deletable via a hover-X with a
  two-step confirm. Conflicts prompt to overwrite. Four new HTTP routes back
  this UI: `GET /api/vfs-list`, `PUT /api/vfs/{path}`, `DELETE /api/vfs/{path}`,
  and `POST /api/vfs-mkdir`. URLs of the form `/f/{path}` deep-link to a file
  preview; the chat composer is hidden while previewing a file.

  The same routes are exposed on `AgentClient` for programmatic use:
  `listDir`, `writeFile`, `deleteFile`, and `mkdir` (alongside the existing
  `readFile`). New shared types `ApiVfsEntry`, `ApiVfsListResponse`, and
  `ApiVfsWriteResponse` are exported from `@poncho-ai/sdk`.

### Patch Changes

- [`524df41`](https://github.com/cesr/poncho-ai/commit/524df411904bd00c07901695eda6d4dd07dde972) Thanks [@cesr](https://github.com/cesr)! - fix: persist harness messages on cancelled runs so the agent doesn't lose context

  When a run was cancelled (Stop button, abort signal), `conversation.messages`
  was updated with the partial assistant turn but `conversation._harnessMessages`
  — the canonical history `loadCanonicalHistory` hands to the model on the next
  turn — was left holding a snapshot from the _previous_ successful run. The
  agent had no memory of the cancelled work, even though the user-facing UI
  still showed it. The new verbose-mode harness toggle made this divergence
  directly visible.

  The fix plumbs an in-flight `messages` snapshot through the `run:cancelled`
  event, trims it to a model-valid prefix (no orphan `tool_use`), and persists
  it as `_harnessMessages` on every cancel path in the CLI.

## 1.9.0

### Minor Changes

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

## 1.8.1

### Patch Changes

- Add VfsAccess interface and expand ToolContext with optional `vfs` field for tenant-scoped virtual filesystem access in tool handlers.

## 1.8.0

### Minor Changes

- [`83d3c5f`](https://github.com/cesr/poncho-ai/commit/83d3c5f841fe84965d1f9fec6dfc5d8832e4489a) Thanks [@cesr](https://github.com/cesr)! - feat: add multi-tenancy with JWT-based tenant scoping

  Deploy one agent, serve many tenants with fully isolated conversations, memory, reminders, and secrets. Tenancy activates automatically when a valid JWT is received — no config changes needed.
  - **Auth**: `createTenantToken()` in client SDK, `poncho auth create-token` CLI, or any HS256 JWT library.
  - **Isolation**: conversations, memory, reminders, and todos scoped per tenant.
  - **Per-tenant secrets**: encrypted secret overrides for MCP auth tokens, manageable via CLI (`poncho secrets`), API, and web UI settings panel.
  - **MCP**: per-tenant token resolution with deferred discovery for servers without a default env var.
  - **Web UI**: `?token=` tenant access, settings cog for secret management, dark mode support.
  - **Backward compatible**: existing single-user deployments work unchanged.

## 1.7.1

### Patch Changes

- [#54](https://github.com/cesr/poncho-ai/pull/54) [`2341915`](https://github.com/cesr/poncho-ai/commit/23419152d52c39f3bcaf8cdcd424625d5f897315) Thanks [@cesr](https://github.com/cesr)! - Reduce high-cost outliers with aggressive runtime controls and better cost visibility.

  This adds older-turn tool result archiving/truncation, tighter retry/step/subagent limits, compaction tuning, selective prompt cache behavior, and richer cache-write token attribution in logs/events.

## 1.7.0

### Minor Changes

- Add OpenAI Codex OAuth provider support with one-time auth bootstrap and runtime token refresh.

  This adds `openai-codex` model provider support, `poncho auth` login/status/logout/export commands, onboarding updates, and Codex request compatibility handling for OAuth-backed Responses API calls.

## 1.6.3

### Patch Changes

- [`193c367`](https://github.com/cesr/poncho-ai/commit/193c367568dce22a470dff6acd022c221be3b722) Thanks [@cesr](https://github.com/cesr)! - Unified continuation logic across all entry points (chat, cron, subagents, SDK) with mid-stream soft deadline checkpointing and proper context preservation across continuation boundaries.

## 1.6.2

### Patch Changes

- [#51](https://github.com/cesr/poncho-ai/pull/51) [`eb661a5`](https://github.com/cesr/poncho-ai/commit/eb661a554da6839702651671db8a8820ceb13f35) Thanks [@cesr](https://github.com/cesr)! - Add generic OTLP trace exporter for sending OpenTelemetry traces to any collector (Jaeger, Grafana Tempo, Honeycomb, etc.). Configure via `telemetry.otlp` as a URL string or `{ url, headers }` object. Works alongside or instead of Latitude telemetry.

## 1.6.1

### Patch Changes

- [`4d50ad9`](https://github.com/cesr/poncho-ai/commit/4d50ad970886c9d3635ec36a407514c91ce6a71a) Thanks [@cesr](https://github.com/cesr)! - Improve callback-run reliability and streaming across subagent workflows, including safer concurrent approval handling and parent callback retriggers.

  Add context window/token reporting through run completion events, improve cron/web UI rendering and approval streaming behavior, and harden built-in web search retry/throttle behavior.

## 1.6.0

### Minor Changes

- [#42](https://github.com/cesr/poncho-ai/pull/42) [`e58a984`](https://github.com/cesr/poncho-ai/commit/e58a984efaa673b649318102bbf735fb4c2f9172) Thanks [@cesr](https://github.com/cesr)! - Add continuation model and fire-and-forget subagents

  **Continuation model**: Agents no longer send a synthetic `"Continue"` user message between steps. Instead, the harness injects a transient signal when needed, and the full internal message chain is preserved across continuations so the LLM never loses context. `RunInput` gains `disableSoftDeadline` and `RunResult` gains `continuationMessages`.

  **Fire-and-forget subagents**: Subagents now run asynchronously in the background. `spawn_subagent` returns immediately with a subagent ID; results are delivered back to the parent conversation as a callback once the subagent completes. Subagents cannot spawn their own subagents. The web UI shows results in a collapsible disclosure and reconnects the live event stream automatically when the parent agent resumes.

  **Bug fixes**:
  - Fixed a race condition where concurrent runs on the same harness instance could assign a subagent or browser tab to the wrong parent conversation (shared `_currentRunConversationId` field replaced with per-run `ToolContext.conversationId`).
  - Fixed Upstash KV store silently dropping large values by switching from URL-path encoding to request body format for `SET`/`SETEX` commands.
  - Fixed empty assistant content blocks causing Anthropic `text content blocks must be non-empty` errors.

  **Client**: Added `getConversationStatus()` and `waitForSubagents` option on `sendMessage()`.

## 1.5.0

### Minor Changes

- [`6f0abfd`](https://github.com/cesr/poncho-ai/commit/6f0abfd9f729b545cf293741ee813f705910aaf3) Thanks [@cesr](https://github.com/cesr)! - Add context compaction for long conversations. Automatically summarizes older messages when the context window fills up, keeping conversations going indefinitely. Includes auto-compaction in the run loop, `/compact` command, Web UI divider with expandable summary, and visual history preservation.

## 1.4.1

### Patch Changes

- [`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d) Thanks [@cesr](https://github.com/cesr)! - Add Telegram messaging adapter with private/group chat support, file attachments, /new command, and typing indicators.

## 1.4.0

### Minor Changes

- [`075b9ac`](https://github.com/cesr/poncho-ai/commit/075b9ac3556847af913bf2b58f030575c3b99852) Thanks [@cesr](https://github.com/cesr)! - Batch tool approvals, fix serverless session persistence and adapter init
  - Batch tool approvals: all approval-requiring tool calls in a single step are now collected and presented together instead of one at a time.
  - Fix messaging adapter route registration: routes are only registered after successful initialization, preventing "Adapter not initialised" errors on Vercel.
  - Add stateless signed-cookie sessions so web UI auth survives serverless cold starts.

## 1.3.0

### Minor Changes

- [`cd6ccd7`](https://github.com/cesr/poncho-ai/commit/cd6ccd7846e16fbaf17167617666796320ec29ce) Thanks [@cesr](https://github.com/cesr)! - Add MCP custom headers support, tool:generating streaming feedback, and cross-owner subagent recovery
  - **MCP custom headers**: `poncho mcp add --header "Name: value"` and `headers` config field let servers like Arcade receive extra HTTP headers alongside bearer auth.
  - **tool:generating event**: the harness now emits `tool:generating` events when the model begins writing tool-call arguments, so the web UI shows real-time "preparing <tool>" feedback instead of appearing stuck during large tool calls.
  - **Subagent recovery**: `list`/`listSummaries` accept optional `ownerId` so stale-subagent recovery on server restart scans across all owners.

## 1.2.0

### Minor Changes

- [#16](https://github.com/cesr/poncho-ai/pull/16) [`972577d`](https://github.com/cesr/poncho-ai/commit/972577d255ab43c2c56f3c3464042a8a617b7f9e) Thanks [@cesr](https://github.com/cesr)! - Add subagent support: agents can spawn recursive copies of themselves as independent sub-conversations with blocking tool calls, read-only memory, approval tunneling to the parent thread, and nested sidebar display in the web UI. Also adds ConversationStore.listSummaries() for fast sidebar loading without reading full conversation files from disk.

## 1.1.1

### Patch Changes

- Fix browser session reconnection, tab lifecycle management, and web UI panel state handling.

## 1.1.0

### Minor Changes

- [`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b) Thanks [@cesr](https://github.com/cesr)! - Add browser automation for Poncho agents with real-time viewport streaming, per-conversation tab management, interactive browser control in the web UI, and shared agent-level profiles for authentication persistence.

## 1.0.3

### Patch Changes

- [`1f47bb4`](https://github.com/cesr/poncho-ai/commit/1f47bb49e5d48dc17644172012b057190b316469) Thanks [@cesr](https://github.com/cesr)! - Add conversation rename via double-click on the title in the web UI, standardize all credential config fields to the `*Env` naming pattern, and sync the init README template with the repo README.

## 1.0.2

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

## 1.0.1

### Patch Changes

- [#10](https://github.com/cesr/poncho-ai/pull/10) [`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218) Thanks [@cesr](https://github.com/cesr)! - Add generic messaging layer with Slack as the first adapter. Agents can now respond to @mentions in Slack by adding `messaging: [{ platform: 'slack' }]` to `poncho.config.js`. Includes signature verification, threaded conversations, processing indicators, and Vercel `waitUntil` support.

## 1.0.0

### Major Changes

- [`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3) Thanks [@cesr](https://github.com/cesr)! - Add multimodal file support for agents — images, PDFs, and text files can be uploaded via the web UI, HTTP API, and terminal CLI. Includes pluggable upload storage (local, Vercel Blob, S3), write-behind caching, build-time dependency injection, and graceful handling of unsupported formats.

## 0.6.0

### Minor Changes

- [`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72) Thanks [@cesr](https://github.com/cesr)! - Add cooperative run cancellation: stop active runs via Ctrl+C (CLI), stop button (Web UI), or the /stop API endpoint. Partial output is preserved and empty assistant messages are skipped to prevent conversation corruption.

## 0.5.0

### Minor Changes

- Improve deployment scaffolding and init onboarding for production targets.

  The CLI now scaffolds deployment files directly in project roots (including Vercel `api/index.mjs` + `vercel.json`), adds safer overwrite behavior with `--force`, and normalizes runtime dependencies for deployable projects. Onboarding now captures `deploy.target` so new projects can scaffold the selected platform during `poncho init`.

## 0.2.0

### Minor Changes

- Initial release of Poncho - an open framework for building and deploying AI agents.
  - `@poncho-ai/sdk`: Core types and utilities for building Poncho skills
  - `@poncho-ai/harness`: Agent execution runtime with conversation loop, tool dispatch, and streaming
  - `@poncho-ai/client`: TypeScript client for calling deployed Poncho agents
  - `@poncho-ai/cli`: CLI for building and deploying AI agents
