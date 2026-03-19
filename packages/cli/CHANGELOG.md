# @poncho-ai/cli

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
