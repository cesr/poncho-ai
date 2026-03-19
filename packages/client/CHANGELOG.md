# @poncho-ai/client

## 0.7.2

### Patch Changes

- Updated dependencies [[`eb661a5`](https://github.com/cesr/poncho-ai/commit/eb661a554da6839702651671db8a8820ceb13f35)]:
  - @poncho-ai/sdk@1.6.2

## 0.7.1

### Patch Changes

- Updated dependencies [[`4d50ad9`](https://github.com/cesr/poncho-ai/commit/4d50ad970886c9d3635ec36a407514c91ce6a71a)]:
  - @poncho-ai/sdk@1.6.1

## 0.7.0

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

## 0.6.10

### Patch Changes

- Updated dependencies [[`6f0abfd`](https://github.com/cesr/poncho-ai/commit/6f0abfd9f729b545cf293741ee813f705910aaf3)]:
  - @poncho-ai/sdk@1.5.0

## 0.6.9

### Patch Changes

- Updated dependencies [[`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d)]:
  - @poncho-ai/sdk@1.4.1

## 0.6.8

### Patch Changes

- Updated dependencies [[`075b9ac`](https://github.com/cesr/poncho-ai/commit/075b9ac3556847af913bf2b58f030575c3b99852)]:
  - @poncho-ai/sdk@1.4.0

## 0.6.7

### Patch Changes

- Updated dependencies [[`cd6ccd7`](https://github.com/cesr/poncho-ai/commit/cd6ccd7846e16fbaf17167617666796320ec29ce)]:
  - @poncho-ai/sdk@1.3.0

## 0.6.6

### Patch Changes

- Updated dependencies [[`972577d`](https://github.com/cesr/poncho-ai/commit/972577d255ab43c2c56f3c3464042a8a617b7f9e)]:
  - @poncho-ai/sdk@1.2.0

## 0.6.5

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@1.1.1

## 0.6.4

### Patch Changes

- Updated dependencies [[`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b)]:
  - @poncho-ai/sdk@1.1.0

## 0.6.3

### Patch Changes

- Updated dependencies [[`1f47bb4`](https://github.com/cesr/poncho-ai/commit/1f47bb49e5d48dc17644172012b057190b316469)]:
  - @poncho-ai/sdk@1.0.3

## 0.6.2

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

## 0.6.1

### Patch Changes

- Updated dependencies [[`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218)]:
  - @poncho-ai/sdk@1.0.1

## 0.6.0

### Minor Changes

- [`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3) Thanks [@cesr](https://github.com/cesr)! - Add multimodal file support for agents — images, PDFs, and text files can be uploaded via the web UI, HTTP API, and terminal CLI. Includes pluggable upload storage (local, Vercel Blob, S3), write-behind caching, build-time dependency injection, and graceful handling of unsupported formats.

### Patch Changes

- Updated dependencies [[`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3)]:
  - @poncho-ai/sdk@1.0.0

## 0.5.0

### Minor Changes

- [`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72) Thanks [@cesr](https://github.com/cesr)! - Add cooperative run cancellation: stop active runs via Ctrl+C (CLI), stop button (Web UI), or the /stop API endpoint. Partial output is preserved and empty assistant messages are skipped to prevent conversation corruption.

### Patch Changes

- Updated dependencies [[`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72)]:
  - @poncho-ai/sdk@0.6.0

## 0.4.1

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@0.5.0

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
