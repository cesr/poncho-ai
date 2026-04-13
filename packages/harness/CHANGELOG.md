# @poncho-ai/harness

## 0.37.0

### Minor Changes

- [`86bc5ac`](https://github.com/cesr/poncho-ai/commit/86bc5ac2a73b80a286228cd9e3b663b50b3d82e7) Thanks [@cesr](https://github.com/cesr)! - perf: promote parentConversationId, pendingApprovals, and channelMeta to dedicated columns so list/summary queries no longer fetch the full data JSONB blob — dramatically reduces database egress

## 0.36.4

### Patch Changes

- [`d7eb744`](https://github.com/cesr/poncho-ai/commit/d7eb744fb371727278bda6a349b9e117065549b4) Thanks [@cesr](https://github.com/cesr)! - fix: upsert conflict key matches PK (id only) — fixes ON CONFLICT error on conversation persist

## 0.36.3

### Patch Changes

- [`abb7ec3`](https://github.com/cesr/poncho-ai/commit/abb7ec3c65503f6feaf133f5d2488dc25152a1a8) Thanks [@cesr](https://github.com/cesr)! - fix: messaging conversations not persisting in SQL storage engines

  The messaging runner creates conversations with a deterministic ID and calls
  `update()` to persist them. But `update()` was a plain UPDATE that silently
  matched zero rows for new conversations, so messages were never saved.
  Changed `update()` to an upsert (INSERT ... ON CONFLICT DO UPDATE) so
  conversations are created on first write and updated on subsequent ones.

## 0.36.2

### Patch Changes

- [`04ebc73`](https://github.com/cesr/poncho-ai/commit/04ebc737914ee24b6f76b42016948c372d6a52d0) Thanks [@cesr](https://github.com/cesr)! - fix: disable prepared statements in PostgreSQL driver for compatibility with transaction-mode connection poolers (Supabase, PgBouncer)

## 0.36.1

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@1.8.1

## 0.36.0

### Minor Changes

- feat: unified conversation_recall tool, subagent recall access, fix subagent streaming
  - Consolidate `conversation_recall` into a single tool with three modes: keyword search, date-range listing, and full conversation fetch by ID.
  - Give subagents access to conversation recall via shared `buildRecallParams` helper.
  - Fix subagent streaming: variable scoping bug preventing poll start, race condition in `processSubagentCallback` losing concurrent results, and spawn detection race causing `pendingSubagents` flag to be missed.
  - Simplify subagent result polling to avoid duplicate messages from polling-to-SSE handoff.

- feat: VFS file tools and vfs:// lazy resolution
  - Add `read_file`, `edit_file`, and `write_file` tools for the virtual filesystem, registered alongside `bash`.
  - `read_file` returns images and PDFs as lightweight `vfs://` references resolved to actual bytes only at model-request time, keeping conversation history small.
  - `edit_file` uses targeted `old_str`/`new_str` replacement for efficient edits to large files.
  - `write_file` creates or overwrites files with automatic parent directory creation.
  - Add `vfs://` scheme resolution in `convertMessage` for user messages, tool results, and rich media items.
  - Extend `extractMediaFromToolOutput` to handle PDFs alongside images.

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

## 0.34.1

### Patch Changes

- [`59a88cc`](https://github.com/cesr/poncho-ai/commit/59a88cc52b5c3aa7432b820424bb8067174233e5) Thanks [@cesr](https://github.com/cesr)! - fix: improve token estimation accuracy and handle missing attachments
  - Use a JSON-specific token ratio for tool definitions to avoid inflating counts with many MCP tools.
  - Track actual context size from model responses for compaction triggers instead of cumulative input tokens.
  - Gracefully degrade when file attachments are missing or expired instead of crashing.

## 0.34.0

### Minor Changes

- [`3f096f2`](https://github.com/cesr/poncho-ai/commit/3f096f28b9ab797b52f1b725778976929156cce9) Thanks [@cesr](https://github.com/cesr)! - fix: scope MCP tools to skills via server-level claiming

  MCP tools from configured servers are now globally available by default. When a skill claims any tool from a server via `allowed-tools`, the entire server becomes skill-managed — its tools are only available when the claiming skill is active (or declared in AGENT.md `allowed-tools`).

## 0.33.1

### Patch Changes

- [`d8fe87c`](https://github.com/cesr/poncho-ai/commit/d8fe87c68d42878829422750f98e3c70a425e3e3) Thanks [@cesr](https://github.com/cesr)! - fix: OTLP trace exporter reliability and error visibility
  - Use provider instance directly instead of global `trace.getTracer()` to avoid silent failure when another library registers a tracer provider first
  - Append `/v1/traces` to base OTLP endpoints so users can pass either the base URL or the full signal-specific URL
  - Surface HTTP status code and response body on export failures
  - Enable OTel diagnostic logger at WARN level for internal SDK errors

## 0.33.0

### Minor Changes

- [#75](https://github.com/cesr/poncho-ai/pull/75) [`d447d0a`](https://github.com/cesr/poncho-ai/commit/d447d0a3cb77f3d097276b524b5f870dddf1899e) Thanks [@cesr](https://github.com/cesr)! - Add `maxRuns` option to cron jobs for automatic pruning of old conversations, preventing unbounded storage growth on hosted stores.

## 0.32.1

### Patch Changes

- [`67424e0`](https://github.com/cesr/poncho-ai/commit/67424e073b2faa28a255781f91a80f4602c745e2) Thanks [@cesr](https://github.com/cesr)! - Fix stale fired reminders not being cleaned up: pruneStale now removes all fired reminders immediately and runs on list() in addition to create().

## 0.32.0

### Minor Changes

- [#68](https://github.com/cesr/poncho-ai/pull/68) [`5a7e370`](https://github.com/cesr/poncho-ai/commit/5a7e3700a5ee441ef41cf4dc0ca70ff90e57d282) Thanks [@cesr](https://github.com/cesr)! - Add one-off reminders: agents can dynamically set, list, and cancel reminders that fire at a specific time. Fired reminders are immediately deleted from storage. Includes polling for local dev and Vercel cron integration.

## 0.31.3

### Patch Changes

- [#56](https://github.com/cesr/poncho-ai/pull/56) [`28b2913`](https://github.com/cesr/poncho-ai/commit/28b291379e640dec53a66c41a2795d0a9fbb9ee7) Thanks [@cesr](https://github.com/cesr)! - Fix historical tool result truncation reliability for deployed conversations.

  This stamps `runId` on all harness-authored assistant messages and adds a fallback truncation boundary for legacy histories that lack `runId` metadata.

## 0.31.2

### Patch Changes

- [#54](https://github.com/cesr/poncho-ai/pull/54) [`2341915`](https://github.com/cesr/poncho-ai/commit/23419152d52c39f3bcaf8cdcd424625d5f897315) Thanks [@cesr](https://github.com/cesr)! - Reduce high-cost outliers with aggressive runtime controls and better cost visibility.

  This adds older-turn tool result archiving/truncation, tighter retry/step/subagent limits, compaction tuning, selective prompt cache behavior, and richer cache-write token attribution in logs/events.

- Updated dependencies [[`2341915`](https://github.com/cesr/poncho-ai/commit/23419152d52c39f3bcaf8cdcd424625d5f897315)]:
  - @poncho-ai/sdk@1.7.1

## 0.31.1

### Patch Changes

- Fix OpenAI Codex compatibility for reasoning model runs by normalizing tool schemas, enforcing required payload fields, and adding endpoint fallback behavior.

## 0.31.0

### Minor Changes

- Add OpenAI Codex OAuth provider support with one-time auth bootstrap and runtime token refresh.

  This adds `openai-codex` model provider support, `poncho auth` login/status/logout/export commands, onboarding updates, and Codex request compatibility handling for OAuth-backed Responses API calls.

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@1.7.0

## 0.30.0

### Minor Changes

- [`193c367`](https://github.com/cesr/poncho-ai/commit/193c367568dce22a470dff6acd022c221be3b722) Thanks [@cesr](https://github.com/cesr)! - Unified continuation logic across all entry points (chat, cron, subagents, SDK) with mid-stream soft deadline checkpointing and proper context preservation across continuation boundaries.

### Patch Changes

- Updated dependencies [[`193c367`](https://github.com/cesr/poncho-ai/commit/193c367568dce22a470dff6acd022c221be3b722)]:
  - @poncho-ai/sdk@1.6.3

## 0.29.0

### Minor Changes

- [#51](https://github.com/cesr/poncho-ai/pull/51) [`eb661a5`](https://github.com/cesr/poncho-ai/commit/eb661a554da6839702651671db8a8820ceb13f35) Thanks [@cesr](https://github.com/cesr)! - Add generic OTLP trace exporter for sending OpenTelemetry traces to any collector (Jaeger, Grafana Tempo, Honeycomb, etc.). Configure via `telemetry.otlp` as a URL string or `{ url, headers }` object. Works alongside or instead of Latitude telemetry.

### Patch Changes

- Updated dependencies [[`eb661a5`](https://github.com/cesr/poncho-ai/commit/eb661a554da6839702651671db8a8820ceb13f35)]:
  - @poncho-ai/sdk@1.6.2

## 0.28.3

### Patch Changes

- [`87f844b`](https://github.com/cesr/poncho-ai/commit/87f844b0a76ece87e4bba78eaf73392f857cdef2) Thanks [@cesr](https://github.com/cesr)! - Fix tool execution blowing past serverless timeout and cross-skill script paths
  - Race tool batch execution against remaining soft deadline so parallel tools can't push past the hard platform timeout
  - Add post-tool-execution soft deadline checkpoint for tools that finish just past the deadline
  - Allow skill scripts to reference sibling directories (e.g. ../scripts/current-date.ts)
  - Catch script path normalization errors in approval check instead of crashing the run

## 0.28.2

### Patch Changes

- [`98df42f`](https://github.com/cesr/poncho-ai/commit/98df42f79e0a376d0a864598557758bfa644039d) Thanks [@cesr](https://github.com/cesr)! - Fix serverless subagent and continuation reliability
  - Use stable internal secret across serverless instances for callback auth
  - Wrap continuation self-fetches in waitUntil to survive function shutdown
  - Set runStatus during callback re-runs so clients detect active processing
  - Add post-streaming soft deadline check to catch long model responses
  - Client auto-recovers from abrupt stream termination and orphaned continuations
  - Fix callback continuation losing \_continuationMessages when no pending results

## 0.28.1

### Patch Changes

- [`4d50ad9`](https://github.com/cesr/poncho-ai/commit/4d50ad970886c9d3635ec36a407514c91ce6a71a) Thanks [@cesr](https://github.com/cesr)! - Improve callback-run reliability and streaming across subagent workflows, including safer concurrent approval handling and parent callback retriggers.

  Add context window/token reporting through run completion events, improve cron/web UI rendering and approval streaming behavior, and harden built-in web search retry/throttle behavior.

- Updated dependencies [[`4d50ad9`](https://github.com/cesr/poncho-ai/commit/4d50ad970886c9d3635ec36a407514c91ce6a71a)]:
  - @poncho-ai/sdk@1.6.1

## 0.28.0

### Minor Changes

- [`c0ca56b`](https://github.com/cesr/poncho-ai/commit/c0ca56b54bb877d96ba8088537d6f1c7461d2a55) Thanks [@cesr](https://github.com/cesr)! - Add built-in `web_search` and `web_fetch` tools so agents can search the web and fetch page content without a browser or API keys. Remove the scaffolded `fetch-page` skill (superseded by `web_fetch`). Fix `browser_open` crash when agent projects have an older `@poncho-ai/browser` installed.

## 0.27.0

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

## 0.26.0

### Minor Changes

- [#40](https://github.com/cesr/poncho-ai/pull/40) [`95ae86b`](https://github.com/cesr/poncho-ai/commit/95ae86b4ea0d913357ccca9a43a227c83e46b9c4) Thanks [@cesr](https://github.com/cesr)! - Add built-in todo tools (todo_list, todo_add, todo_update, todo_remove) with per-conversation storage and a live todo panel in the web UI

## 0.25.0

### Minor Changes

- [`5a103ca`](https://github.com/cesr/poncho-ai/commit/5a103ca62238cceaa4f4b31769a96637330d6b84) Thanks [@cesr](https://github.com/cesr)! - Split `memory_main_update` into `memory_main_write` (full overwrite) and `memory_main_edit` (targeted string replacement). Hot-reload AGENT.md and skills in dev mode without restarting the server. Merge agent + skill MCP tool patterns additively. Fix MissingToolResultsError when resuming from nested approval checkpoints.

## 0.24.0

### Minor Changes

- [`aee4f17`](https://github.com/cesr/poncho-ai/commit/aee4f17237d33b2cc134ed9934b709d967ca3f10) Thanks [@cesr](https://github.com/cesr)! - Add `edit_file` built-in tool with str_replace semantics for targeted file edits. The tool takes `path`, `old_str`, and `new_str` parameters, enforces uniqueness of the match, and is write-gated like `write_file` (disabled in production by default). Also improves browser SSE frame streaming with backpressure handling and auto-stops screencast when all listeners disconnect.

## 0.23.0

### Minor Changes

- [`d1e1bfb`](https://github.com/cesr/poncho-ai/commit/d1e1bfbf35b18788ab79231ca675774e949f5116) Thanks [@cesr](https://github.com/cesr)! - Add proactive scheduled messaging via channel-targeted cron jobs. Cron jobs with `channel: telegram` (or `slack`) now automatically discover known conversations and send the agent's response directly to each chat, continuing the existing conversation history.

## 0.22.1

### Patch Changes

- [`096953d`](https://github.com/cesr/poncho-ai/commit/096953d5a64a785950ea0a7f09e2183e481afd29) Thanks [@cesr](https://github.com/cesr)! - Improve time-to-first-token by lazy-loading the recall corpus

  The recall corpus (past conversation summaries) is now fetched on-demand only when the LLM invokes the `conversation_recall` tool, instead of blocking every message with ~1.3s of upfront I/O. Also adds batch `mget` support to Upstash/Redis/DynamoDB conversation stores, parallelizes memory fetch with skill refresh, debounces skill refresh in dev mode, and caches message conversions across multi-step runs.

## 0.22.0

### Minor Changes

- [`6f0abfd`](https://github.com/cesr/poncho-ai/commit/6f0abfd9f729b545cf293741ee813f705910aaf3) Thanks [@cesr](https://github.com/cesr)! - Add context compaction for long conversations. Automatically summarizes older messages when the context window fills up, keeping conversations going indefinitely. Includes auto-compaction in the run loop, `/compact` command, Web UI divider with expandable summary, and visual history preservation.

### Patch Changes

- Updated dependencies [[`6f0abfd`](https://github.com/cesr/poncho-ai/commit/6f0abfd9f729b545cf293741ee813f705910aaf3)]:
  - @poncho-ai/sdk@1.5.0

## 0.21.1

### Patch Changes

- [`76294e9`](https://github.com/cesr/poncho-ai/commit/76294e95035bf3abbb19c28871a33f82351c49ec) Thanks [@cesr](https://github.com/cesr)! - Add `provider` and `cdpUrl` to the `PonchoConfig.browser` type for cloud and remote browser configurations.

## 0.21.0

### Minor Changes

- [#33](https://github.com/cesr/poncho-ai/pull/33) [`f611bb9`](https://github.com/cesr/poncho-ai/commit/f611bb9137142de923d90502ece597d5cd6a5d3e) Thanks [@cesr](https://github.com/cesr)! - Add built-in `poncho_docs` tool for on-demand documentation discovery

  Agents in development mode can now call `poncho_docs` with a topic (`api`, `features`, `configuration`, `troubleshooting`) to load detailed framework documentation on demand. Docs are embedded at build time from `docs/*.md` at the repo root, keeping a single source of truth that stays in sync with releases.

## 0.20.14

### Patch Changes

- [`d997362`](https://github.com/cesr/poncho-ai/commit/d997362b114f6e9c5d95794cedff2c7675e32ca5) Thanks [@cesr](https://github.com/cesr)! - Add stealth mode to browser automation (enabled by default). Reduces bot-detection fingerprints with a realistic Chrome user-agent, navigator.webdriver override, window.chrome shim, fake plugins, WebGL patches, and anti-automation Chrome flags. Configurable via `stealth` and `userAgent` options in `poncho.config.js`.

## 0.20.13

### Patch Changes

- [`735eb64`](https://github.com/cesr/poncho-ai/commit/735eb6467831263671d56b58a79c736c602e594b) Thanks [@cesr](https://github.com/cesr)! - Add Telegram setup instructions to injected agent development context.

## 0.20.12

### Patch Changes

- [`3216e80`](https://github.com/cesr/poncho-ai/commit/3216e8072027896dd1cc5f29b1a7b0eea9ee1ff5) Thanks [@cesr](https://github.com/cesr)! - Add `allowedUserIds` option to Telegram adapter for restricting bot access to specific users.

## 0.20.11

### Patch Changes

- [`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d) Thanks [@cesr](https://github.com/cesr)! - Add Telegram messaging adapter with private/group chat support, file attachments, /new command, and typing indicators.

- Updated dependencies [[`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d)]:
  - @poncho-ai/sdk@1.4.1

## 0.20.10

### Patch Changes

- [`45fc930`](https://github.com/cesr/poncho-ai/commit/45fc93066547f8ba01eb6f2fcdff560f18da3451) Thanks [@cesr](https://github.com/cesr)! - Use clean `anthropic` provider name in telemetry instead of `anthropic.messages`, so Latitude correctly identifies the model.

## 0.20.9

### Patch Changes

- [`29cc075`](https://github.com/cesr/poncho-ai/commit/29cc075554077db177f93fd07af031da4a69ac51) Thanks [@cesr](https://github.com/cesr)! - Strip provider prefix from model names in AGENT.md (e.g. `anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`). The provider is extracted and used for routing; only the bare model name is sent to the API.

## 0.20.8

### Patch Changes

- [`0ec1f69`](https://github.com/cesr/poncho-ai/commit/0ec1f69a56b6424967d994663294adbbde1b9257) Thanks [@cesr](https://github.com/cesr)! - Support flat string `model: claude-opus-4-6` shorthand in AGENT.md frontmatter (in addition to nested `model: { name: ... }`). Log the resolved model name on first step for deployment debugging.

## 0.20.7

### Patch Changes

- [`8999a47`](https://github.com/cesr/poncho-ai/commit/8999a477b6e73ffb7c942a9cc5c85e704ec158b8) Thanks [@cesr](https://github.com/cesr)! - Enable token usage and cost tracking in Latitude telemetry by setting `recordInputs` and `recordOutputs` in the Vercel AI SDK's `experimental_telemetry` config.

## 0.20.6

### Patch Changes

- [`afbcc7b`](https://github.com/cesr/poncho-ai/commit/afbcc7b188258b7d193aa1f6f9f4462c2841ceec) Thanks [@cesr](https://github.com/cesr)! - Fix Latitude telemetry traces being silently dropped when conversation IDs are not valid UUIDs (e.g. Resend/Slack-derived IDs). Only pass conversationUuid to Latitude when it matches UUID v4 format.

## 0.20.5

### Patch Changes

- [`8286e1e`](https://github.com/cesr/poncho-ai/commit/8286e1ef244208d74e1daf8ef1c2a1a3afb1459e) Thanks [@cesr](https://github.com/cesr)! - Match Latitude telemetry integration exactly to their documented Vercel AI SDK pattern — no custom constructor options.

## 0.20.4

### Patch Changes

- [`c35f676`](https://github.com/cesr/poncho-ai/commit/c35f676cdc548a3db9212ae7909302a5b876bc40) Thanks [@cesr](https://github.com/cesr)! - Switch Latitude telemetry to use BatchSpanProcessor (default) instead of SimpleSpanProcessor. Sends all spans from a trace together in one OTLP batch, matching Latitude's expected integration pattern.

## 0.20.3

### Patch Changes

- [`28046fb`](https://github.com/cesr/poncho-ai/commit/28046fb39aea00968ac532c25db4f0d654e21876) Thanks [@cesr](https://github.com/cesr)! - Add diagnostic span processor to log telemetry span details for debugging trace export issues.

## 0.20.2

### Patch Changes

- [`ec7d7a8`](https://github.com/cesr/poncho-ai/commit/ec7d7a80bf84855d19454c52053375fe86815ae4) Thanks [@cesr](https://github.com/cesr)! - Upgrade `@latitude-data/telemetry` to ^2.0.4 which adds baggage propagation for Latitude attributes on all child spans, fixing traces not appearing in the Latitude platform.

## 0.20.1

### Patch Changes

- [`ec1bb60`](https://github.com/cesr/poncho-ai/commit/ec1bb601d4f47c1b50c391cdc169cbe1623b52aa) Thanks [@cesr](https://github.com/cesr)! - Log telemetry flush errors instead of silently swallowing them, improving diagnostics when traces fail to export.

## 0.20.0

### Minor Changes

- [`5df6b5f`](https://github.com/cesr/poncho-ai/commit/5df6b5fcdc98e0445bea504dc9d077f02d1e954f) Thanks [@cesr](https://github.com/cesr)! - Add polling fallback for web UI on serverless deployments: when the SSE event stream is unavailable (different instance from the webhook handler), the UI polls the conversation every 2 seconds until the run completes. Conversations now track a persisted `runStatus` field.

## 0.19.1

### Patch Changes

- [`470563b`](https://github.com/cesr/poncho-ai/commit/470563b96bbb5d2c6358a1c89dd3b52beb7799c8) Thanks [@cesr](https://github.com/cesr)! - Fix LocalUploadStore ENOENT on Vercel: use /tmp for uploads on serverless environments instead of the read-only working directory.

## 0.19.0

### Minor Changes

- [`075b9ac`](https://github.com/cesr/poncho-ai/commit/075b9ac3556847af913bf2b58f030575c3b99852) Thanks [@cesr](https://github.com/cesr)! - Batch tool approvals, fix serverless session persistence and adapter init
  - Batch tool approvals: all approval-requiring tool calls in a single step are now collected and presented together instead of one at a time.
  - Fix messaging adapter route registration: routes are only registered after successful initialization, preventing "Adapter not initialised" errors on Vercel.
  - Add stateless signed-cookie sessions so web UI auth survives serverless cold starts.

### Patch Changes

- Updated dependencies [[`075b9ac`](https://github.com/cesr/poncho-ai/commit/075b9ac3556847af913bf2b58f030575c3b99852)]:
  - @poncho-ai/sdk@1.4.0

## 0.18.0

### Minor Changes

- [`cd6ccd7`](https://github.com/cesr/poncho-ai/commit/cd6ccd7846e16fbaf17167617666796320ec29ce) Thanks [@cesr](https://github.com/cesr)! - Add MCP custom headers support, tool:generating streaming feedback, and cross-owner subagent recovery
  - **MCP custom headers**: `poncho mcp add --header "Name: value"` and `headers` config field let servers like Arcade receive extra HTTP headers alongside bearer auth.
  - **tool:generating event**: the harness now emits `tool:generating` events when the model begins writing tool-call arguments, so the web UI shows real-time "preparing <tool>" feedback instead of appearing stuck during large tool calls.
  - **Subagent recovery**: `list`/`listSummaries` accept optional `ownerId` so stale-subagent recovery on server restart scans across all owners.

### Patch Changes

- Updated dependencies [[`cd6ccd7`](https://github.com/cesr/poncho-ai/commit/cd6ccd7846e16fbaf17167617666796320ec29ce)]:
  - @poncho-ai/sdk@1.3.0

## 0.17.0

### Minor Changes

- [#16](https://github.com/cesr/poncho-ai/pull/16) [`972577d`](https://github.com/cesr/poncho-ai/commit/972577d255ab43c2c56f3c3464042a8a617b7f9e) Thanks [@cesr](https://github.com/cesr)! - Add subagent support: agents can spawn recursive copies of themselves as independent sub-conversations with blocking tool calls, read-only memory, approval tunneling to the parent thread, and nested sidebar display in the web UI. Also adds ConversationStore.listSummaries() for fast sidebar loading without reading full conversation files from disk.

### Patch Changes

- Updated dependencies [[`972577d`](https://github.com/cesr/poncho-ai/commit/972577d255ab43c2c56f3c3464042a8a617b7f9e)]:
  - @poncho-ai/sdk@1.2.0

## 0.16.1

### Patch Changes

- [`7475da5`](https://github.com/cesr/poncho-ai/commit/7475da5c0c2399e79064a2622137c0eb2fb16871) Thanks [@cesr](https://github.com/cesr)! - Inject browser usage context into agent system prompt (auth flow, session persistence, tool selection guidance).

## 0.16.0

### Minor Changes

- [`12f2845`](https://github.com/cesr/poncho-ai/commit/12f28457c20e650640ff2a1c1dbece2a6e4a9ddd) Thanks [@cesr](https://github.com/cesr)! - Add browser storage persistence (cookies/localStorage survive restarts via configured storage provider) and new `browser_content` tool for fast text extraction from pages.

## 0.15.1

### Patch Changes

- Fix browser session reconnection, tab lifecycle management, and web UI panel state handling.

- Updated dependencies []:
  - @poncho-ai/sdk@1.1.1

## 0.15.0

### Minor Changes

- [`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b) Thanks [@cesr](https://github.com/cesr)! - Add browser automation for Poncho agents with real-time viewport streaming, per-conversation tab management, interactive browser control in the web UI, and shared agent-level profiles for authentication persistence.

### Patch Changes

- Updated dependencies [[`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b)]:
  - @poncho-ai/sdk@1.1.0

## 0.14.2

### Patch Changes

- [`1f47bb4`](https://github.com/cesr/poncho-ai/commit/1f47bb49e5d48dc17644172012b057190b316469) Thanks [@cesr](https://github.com/cesr)! - Add conversation rename via double-click on the title in the web UI, standardize all credential config fields to the `*Env` naming pattern, and sync the init README template with the repo README.

- Updated dependencies [[`1f47bb4`](https://github.com/cesr/poncho-ai/commit/1f47bb49e5d48dc17644172012b057190b316469)]:
  - @poncho-ai/sdk@1.0.3

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

## 0.13.1

### Patch Changes

- [#10](https://github.com/cesr/poncho-ai/pull/10) [`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218) Thanks [@cesr](https://github.com/cesr)! - Add generic messaging layer with Slack as the first adapter. Agents can now respond to @mentions in Slack by adding `messaging: [{ platform: 'slack' }]` to `poncho.config.js`. Includes signature verification, threaded conversations, processing indicators, and Vercel `waitUntil` support.

- Updated dependencies [[`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218)]:
  - @poncho-ai/sdk@1.0.1

## 0.13.0

### Minor Changes

- [#8](https://github.com/cesr/poncho-ai/pull/8) [`658bc54`](https://github.com/cesr/poncho-ai/commit/658bc54d391cb0b58aa678a2b86cd617eebdd8aa) Thanks [@cesr](https://github.com/cesr)! - Add cron job support for scheduled agent tasks. Define recurring jobs in AGENT.md frontmatter with schedule, task, and optional timezone. Includes in-process scheduler for local dev with hot-reload, HTTP endpoint for Vercel/serverless with self-continuation, Vercel scaffold generation with drift detection, and full tool activity tracking in cron conversations.

## 0.12.0

### Minor Changes

- [`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3) Thanks [@cesr](https://github.com/cesr)! - Add multimodal file support for agents — images, PDFs, and text files can be uploaded via the web UI, HTTP API, and terminal CLI. Includes pluggable upload storage (local, Vercel Blob, S3), write-behind caching, build-time dependency injection, and graceful handling of unsupported formats.

### Patch Changes

- Updated dependencies [[`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3)]:
  - @poncho-ai/sdk@1.0.0

## 0.11.2

### Patch Changes

- [`3dcb914`](https://github.com/cesr/poncho-ai/commit/3dcb914acd22c403ff5372d94a0fc2152a2574b3) Thanks [@cesr](https://github.com/cesr)! - Fix scaffolded dependency versions during `poncho init` so npm installs no longer request unavailable `^0.1.0` packages.

  Improve runtime resilience by retrying transient provider/model failures, returning clearer provider error codes, and sanitizing malformed conversation history so interrupted/bad-state chats can continue.

## 0.11.1

### Patch Changes

- [`8a3937e`](https://github.com/cesr/poncho-ai/commit/8a3937e95bfb7f269e8fe46dd41640eacb30af43) Thanks [@cesr](https://github.com/cesr)! - Increase the first model response timeout from 30s to 180s to reduce premature model timeout errors on slower providers.

## 0.11.0

### Minor Changes

- [`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72) Thanks [@cesr](https://github.com/cesr)! - Add cooperative run cancellation: stop active runs via Ctrl+C (CLI), stop button (Web UI), or the /stop API endpoint. Partial output is preserved and empty assistant messages are skipped to prevent conversation corruption.

### Patch Changes

- Updated dependencies [[`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72)]:
  - @poncho-ai/sdk@0.6.0

## 0.10.3

### Patch Changes

- Reduce serverless warnings when loading TypeScript skill scripts.

  The harness now uses `jiti` first for `.ts/.mts/.cts` scripts in `run_skill_script`, avoiding Node's native ESM warning spam for TypeScript files in deployed environments.

## 0.10.2

### Patch Changes

- Improve runtime loading of `poncho.config.js` in serverless environments.

  The harness now falls back to `jiti` when native ESM import of `poncho.config.js` fails, allowing deploys where bundlers/runtime packaging treat project `.js` files as CommonJS. The CLI patch picks up the updated harness runtime.

## 0.10.1

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@0.5.0

## 0.7.1

### Patch Changes

- Persist pending approvals on conversation state and add SSE reconnect endpoint so Web UI approvals survive page refresh and stream responses in real-time.

## 0.7.0

### Minor Changes

- Simplify MCP tool patterns and improve auth UI
  - Allow tool patterns without server prefix in poncho.config.js (e.g., `include: ['*']` instead of `include: ['linear/*']`)
  - Fix auth screen button styling to be fully rounded with centered arrow
  - Add self-extension capabilities section to development mode instructions
  - Update documentation to clarify MCP pattern formats

## 0.6.0

### Minor Changes

- Add markdown table support and fix Latitude telemetry integration
  - Add markdown table rendering with `marked` library in web UI
  - Add table styling with horizontal scroll and hover effects
  - Add margins to HR elements for better spacing
  - Integrate Latitude telemetry with Vercel AI SDK using event queue pattern
  - Enable real-time streaming while capturing complete traces
  - Fix telemetry to show all messages and interactions in Latitude dashboard

## 0.5.0

### Minor Changes

- d6256b2: Migrate to Vercel AI SDK for unified model provider support

  This major refactoring replaces separate OpenAI and Anthropic client implementations with Vercel AI SDK's unified interface, simplifying the codebase by ~1,265 lines and enabling easier addition of new model providers.

  **Key improvements:**
  - Unified model provider interface via Vercel AI SDK
  - JSON Schema to Zod converter for tool definitions
  - Fixed tool call preservation in multi-step agent loops
  - Simplified architecture with better maintainability
  - Added comprehensive error handling for step execution

  **Breaking changes (internal API only):**
  - `ModelClient` interface removed (use Vercel AI SDK directly)
  - `OpenAiModelClient` and `AnthropicModelClient` classes removed
  - `createModelClient()` replaced with `createModelProvider()`

  **User-facing API unchanged:**
  - AGENT.md format unchanged
  - Tool definitions unchanged (JSON Schema still works)
  - Model provider names unchanged (`openai`, `anthropic`)
  - Agent behavior unchanged from user perspective

## 0.4.1

### Patch Changes

- Fix MCP tool prefix to use `mcp:` instead of `@mcp:` for YAML compatibility. The `@` character is reserved in YAML and cannot start plain values without quoting.

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

## 0.3.1

### Patch Changes

- Split agent template and development context

  Move development-specific guidance from AGENT.md template into runtime-injected development context. Production agents now receive a cleaner prompt focused on task execution, while development agents get additional context about customization and setup.

## 0.3.0

### Minor Changes

- Implement tool policy and declarative intent system

  Add comprehensive tool policy framework for MCP and script tools with pattern matching, environment-based configuration, and declarative tool intent in AGENT.md and SKILL.md frontmatter.

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
