# @poncho-ai/messaging

## 0.8.7

### Patch Changes

- Updated dependencies [[`e8df464`](https://github.com/cesr/poncho-ai/commit/e8df4649618cba0b408a6c143f923f0dcb2046c8)]:
  - @poncho-ai/sdk@1.12.0

## 0.8.6

### Patch Changes

- Updated dependencies [[`1adaae2`](https://github.com/cesr/poncho-ai/commit/1adaae2d4cc55800f01d602f2a7d6ecc65031443)]:
  - @poncho-ai/sdk@1.11.0

## 0.8.5

### Patch Changes

- Updated dependencies [[`524df41`](https://github.com/cesr/poncho-ai/commit/524df411904bd00c07901695eda6d4dd07dde972), [`9616060`](https://github.com/cesr/poncho-ai/commit/96160607502c2c0b05bc60b67b8fc012f4052ef1)]:
  - @poncho-ai/sdk@1.10.0

## 0.8.4

### Patch Changes

- Updated dependencies [[`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d), [`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d)]:
  - @poncho-ai/sdk@1.9.0

## 0.8.3

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@1.8.1

## 0.8.2

### Patch Changes

- Updated dependencies [[`83d3c5f`](https://github.com/cesr/poncho-ai/commit/83d3c5f841fe84965d1f9fec6dfc5d8832e4489a)]:
  - @poncho-ai/sdk@1.8.0

## 0.8.1

### Patch Changes

- [`69dd20a`](https://github.com/cesr/poncho-ai/commit/69dd20ae31ada0edaf281cf451729ffe37f4df71) Thanks [@cesr](https://github.com/cesr)! - fix: use GET for Slack conversations.replies API call so thread context is fetched correctly

## 0.8.0

### Minor Changes

- [`fb7ee97`](https://github.com/cesr/poncho-ai/commit/fb7ee97f7df0dda7318a7e59565e0b53285f10c4) Thanks [@cesr](https://github.com/cesr)! - feat: include thread context when Slack bot is @mentioned in a thread reply

  When the bot is @mentioned in a thread (not the parent message), the adapter now fetches prior thread messages via `conversations.replies` and prepends them as context, so the agent understands what the conversation is about.

## 0.7.10

### Patch Changes

- [#73](https://github.com/cesr/poncho-ai/pull/73) [`f72f202`](https://github.com/cesr/poncho-ai/commit/f72f202d839dbbb8240336ec76eb6340aba20f06) Thanks [@cesr](https://github.com/cesr)! - Fix Telegram approval message ordering: send accumulated assistant text before approval buttons so the conversation reads naturally. Skip empty bridge replies when text was already sent at checkpoint.

## 0.7.9

### Patch Changes

- [#71](https://github.com/cesr/poncho-ai/pull/71) [`3e5bf7e`](https://github.com/cesr/poncho-ai/commit/3e5bf7e527e394c5f823beac90712756e57cd491) Thanks [@cesr](https://github.com/cesr)! - Fix Telegram tool approval handler never persisting the approval decision, preventing the resume-from-checkpoint flow from triggering. Make answerCallbackQuery best-effort so transient fetch failures don't block approval processing.

## 0.7.8

### Patch Changes

- [`30026c5`](https://github.com/cesr/poncho-ai/commit/30026c5eba3f714bb80c2402c5e8f32c6fd38d87) Thanks [@cesr](https://github.com/cesr)! - Fix Telegram conversation instability on serverless: use stable platformThreadId instead of in-memory session counter.

## 0.7.7

### Patch Changes

- [#61](https://github.com/cesr/poncho-ai/pull/61) [`0a51abe`](https://github.com/cesr/poncho-ai/commit/0a51abec12191397fd36ab1fd4feca7460489e33) Thanks [@cesr](https://github.com/cesr)! - Fix /new command on Telegram in serverless environments: persist conversation reset to the store so it survives cold starts.

## 0.7.6

### Patch Changes

- Updated dependencies [[`2341915`](https://github.com/cesr/poncho-ai/commit/23419152d52c39f3bcaf8cdcd424625d5f897315)]:
  - @poncho-ai/sdk@1.7.1

## 0.7.5

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@1.7.0

## 0.7.4

### Patch Changes

- Updated dependencies [[`193c367`](https://github.com/cesr/poncho-ai/commit/193c367568dce22a470dff6acd022c221be3b722)]:
  - @poncho-ai/sdk@1.6.3

## 0.7.3

### Patch Changes

- Updated dependencies [[`eb661a5`](https://github.com/cesr/poncho-ai/commit/eb661a554da6839702651671db8a8820ceb13f35)]:
  - @poncho-ai/sdk@1.6.2

## 0.7.2

### Patch Changes

- Updated dependencies [[`4d50ad9`](https://github.com/cesr/poncho-ai/commit/4d50ad970886c9d3635ec36a407514c91ce6a71a)]:
  - @poncho-ai/sdk@1.6.1

## 0.7.1

### Patch Changes

- [#42](https://github.com/cesr/poncho-ai/pull/42) [`e58a984`](https://github.com/cesr/poncho-ai/commit/e58a984efaa673b649318102bbf735fb4c2f9172) Thanks [@cesr](https://github.com/cesr)! - Add continuation model and fire-and-forget subagents

  **Continuation model**: Agents no longer send a synthetic `"Continue"` user message between steps. Instead, the harness injects a transient signal when needed, and the full internal message chain is preserved across continuations so the LLM never loses context. `RunInput` gains `disableSoftDeadline` and `RunResult` gains `continuationMessages`.

  **Fire-and-forget subagents**: Subagents now run asynchronously in the background. `spawn_subagent` returns immediately with a subagent ID; results are delivered back to the parent conversation as a callback once the subagent completes. Subagents cannot spawn their own subagents. The web UI shows results in a collapsible disclosure and reconnects the live event stream automatically when the parent agent resumes.

  **Bug fixes**:
  - Fixed a race condition where concurrent runs on the same harness instance could assign a subagent or browser tab to the wrong parent conversation (shared `_currentRunConversationId` field replaced with per-run `ToolContext.conversationId`).
  - Fixed Upstash KV store silently dropping large values by switching from URL-path encoding to request body format for `SET`/`SETEX` commands.
  - Fixed empty assistant content blocks causing Anthropic `text content blocks must be non-empty` errors.

  **Client**: Added `getConversationStatus()` and `waitForSubagents` option on `sendMessage()`.

- Updated dependencies [[`e58a984`](https://github.com/cesr/poncho-ai/commit/e58a984efaa673b649318102bbf735fb4c2f9172)]:
  - @poncho-ai/sdk@1.6.0

## 0.7.0

### Minor Changes

- [`26be28a`](https://github.com/cesr/poncho-ai/commit/26be28a958f2eb27dd78225f1cf80b67b16d673d) Thanks [@cesr](https://github.com/cesr)! - Add tool approval support in Telegram via inline keyboard buttons. When the agent needs approval for a tool call, the bot sends Approve/Deny buttons to the chat. After all decisions are made, the run resumes and the response is delivered. Approvals from the web UI for Telegram conversations are also routed back to the chat.

## 0.6.0

### Minor Changes

- [`d1e1bfb`](https://github.com/cesr/poncho-ai/commit/d1e1bfbf35b18788ab79231ca675774e949f5116) Thanks [@cesr](https://github.com/cesr)! - Add proactive scheduled messaging via channel-targeted cron jobs. Cron jobs with `channel: telegram` (or `slack`) now automatically discover known conversations and send the agent's response directly to each chat, continuing the existing conversation history.

## 0.5.1

### Patch Changes

- Updated dependencies [[`6f0abfd`](https://github.com/cesr/poncho-ai/commit/6f0abfd9f729b545cf293741ee813f705910aaf3)]:
  - @poncho-ai/sdk@1.5.0

## 0.5.0

### Minor Changes

- [`8ef9316`](https://github.com/cesr/poncho-ai/commit/8ef93165084b4df581e39a1581b1ead64b7b3f42) Thanks [@cesr](https://github.com/cesr)! - Add auto-continuation support for messaging adapters (Telegram, Slack, Resend) on serverless platforms. When `PONCHO_MAX_DURATION` is set, agent runs that hit the soft deadline now automatically resume with "Continue" messages, matching the web UI and client SDK behavior.

## 0.4.0

### Minor Changes

- [`3216e80`](https://github.com/cesr/poncho-ai/commit/3216e8072027896dd1cc5f29b1a7b0eea9ee1ff5) Thanks [@cesr](https://github.com/cesr)! - Add `allowedUserIds` option to Telegram adapter for restricting bot access to specific users.

## 0.3.0

### Minor Changes

- [`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d) Thanks [@cesr](https://github.com/cesr)! - Add Telegram messaging adapter with private/group chat support, file attachments, /new command, and typing indicators.

### Patch Changes

- Updated dependencies [[`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d)]:
  - @poncho-ai/sdk@1.4.1

## 0.2.9

### Patch Changes

- [`e9b801f`](https://github.com/cesr/poncho-ai/commit/e9b801f0c70ffab6cb434b7adf05df22b29ea9fe) Thanks [@cesr](https://github.com/cesr)! - Derive deterministic UUIDs for messaging conversation IDs instead of composite strings. Fixes Latitude telemetry rejection and ensures consistency with web UI/API conversations.

## 0.2.8

### Patch Changes

- [`deb134e`](https://github.com/cesr/poncho-ai/commit/deb134e8a6ecf38d85dc200f57998e33406eff61) Thanks [@cesr](https://github.com/cesr)! - Retry Resend API requests on transient socket errors (common on Vercel cold starts).

## 0.2.7

### Patch Changes

- Updated dependencies [[`075b9ac`](https://github.com/cesr/poncho-ai/commit/075b9ac3556847af913bf2b58f030575c3b99852)]:
  - @poncho-ai/sdk@1.4.0

## 0.2.6

### Patch Changes

- Updated dependencies [[`cd6ccd7`](https://github.com/cesr/poncho-ai/commit/cd6ccd7846e16fbaf17167617666796320ec29ce)]:
  - @poncho-ai/sdk@1.3.0

## 0.2.5

### Patch Changes

- Updated dependencies [[`972577d`](https://github.com/cesr/poncho-ai/commit/972577d255ab43c2c56f3c3464042a8a617b7f9e)]:
  - @poncho-ai/sdk@1.2.0

## 0.2.4

### Patch Changes

- Fix browser session reconnection, tab lifecycle management, and web UI panel state handling.

- Updated dependencies []:
  - @poncho-ai/sdk@1.1.1

## 0.2.3

### Patch Changes

- Updated dependencies [[`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b)]:
  - @poncho-ai/sdk@1.1.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`1f47bb4`](https://github.com/cesr/poncho-ai/commit/1f47bb49e5d48dc17644172012b057190b316469)]:
  - @poncho-ai/sdk@1.0.3

## 0.2.1

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

## 0.2.0

### Minor Changes

- [#10](https://github.com/cesr/poncho-ai/pull/10) [`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218) Thanks [@cesr](https://github.com/cesr)! - Add generic messaging layer with Slack as the first adapter. Agents can now respond to @mentions in Slack by adding `messaging: [{ platform: 'slack' }]` to `poncho.config.js`. Includes signature verification, threaded conversations, processing indicators, and Vercel `waitUntil` support.

### Patch Changes

- Updated dependencies [[`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218)]:
  - @poncho-ai/sdk@1.0.1
