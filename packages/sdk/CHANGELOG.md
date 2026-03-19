# @poncho-ai/sdk

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
