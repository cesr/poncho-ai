# @poncho-ai/messaging

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
