# @poncho-ai/browser

## 0.6.7

### Patch Changes

- Updated dependencies [[`eb661a5`](https://github.com/cesr/poncho-ai/commit/eb661a554da6839702651671db8a8820ceb13f35)]:
  - @poncho-ai/sdk@1.6.2

## 0.6.6

### Patch Changes

- Updated dependencies [[`4d50ad9`](https://github.com/cesr/poncho-ai/commit/4d50ad970886c9d3635ec36a407514c91ce6a71a)]:
  - @poncho-ai/sdk@1.6.1

## 0.6.5

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

## 0.6.4

### Patch Changes

- [`b5af10a`](https://github.com/cesr/poncho-ai/commit/b5af10a2f7b0023c683f14cd465105f8ddfff0ee) Thanks [@cesr](https://github.com/cesr)! - Fix browser cookie restore failing with "Invalid parameters" by sanitizing Playwright-format cookies to CDP-compatible format before calling Network.setCookies. Falls back to per-cookie restore when batch call fails.

## 0.6.3

### Patch Changes

- [`35f3f54`](https://github.com/cesr/poncho-ai/commit/35f3f54b17ff50253ab01dbcfe19c643dd6c7e00) Thanks [@cesr](https://github.com/cesr)! - Add `browser_clear_cookies` tool for deleting browser cookies

  Agents with `browser: true` can now call `browser_clear_cookies` to delete cookies from the live browser and persisted storage. Accepts an optional `url` parameter to scope deletion to a specific site (e.g. "https://example.com"); omit to clear all cookies.

## 0.6.2

### Patch Changes

- Updated dependencies [[`6f0abfd`](https://github.com/cesr/poncho-ai/commit/6f0abfd9f729b545cf293741ee813f705910aaf3)]:
  - @poncho-ai/sdk@1.5.0

## 0.6.1

### Patch Changes

- Pass `@sparticuz/chromium` recommended args (--no-sandbox, --disable-gpu, etc.) when launching on serverless platforms. Fixes Chromium sandbox crash on Vercel/Lambda.

## 0.6.0

### Minor Changes

- [`76294e9`](https://github.com/cesr/poncho-ai/commit/76294e95035bf3abbb19c28871a33f82351c49ec) Thanks [@cesr](https://github.com/cesr)! - Support remote and serverless browser deployments.

  **@poncho-ai/browser**: Add `provider` and `cdpUrl` config options for cloud browser services (Browserbase, Browser Use, Kernel) and direct CDP connections. Auto-detect `@sparticuz/chromium` on serverless platforms (Vercel, Lambda) and default the profile directory to `/tmp`.

  **@poncho-ai/cli**: Generate @vercel/nft trace hints for `@poncho-ai/browser` and `@sparticuz/chromium` in the Vercel entry point so dynamically-loaded browser packages are bundled into the serverless function.

## 0.5.0

### Minor Changes

- [`540c8e6`](https://github.com/cesr/poncho-ai/commit/540c8e6d895a95c2f215deb4af219069543371d9) Thanks [@cesr](https://github.com/cesr)! - Add `browser_click_text` and `browser_execute_js` tools for interacting with elements that don't appear in the accessibility snapshot (e.g. styled divs acting as buttons). Also force new-tab navigations (`window.open`, `target="_blank"`) to stay in the current tab so agents don't lose context.

## 0.4.0

### Minor Changes

- [`d997362`](https://github.com/cesr/poncho-ai/commit/d997362b114f6e9c5d95794cedff2c7675e32ca5) Thanks [@cesr](https://github.com/cesr)! - Add stealth mode to browser automation (enabled by default). Reduces bot-detection fingerprints with a realistic Chrome user-agent, navigator.webdriver override, window.chrome shim, fake plugins, WebGL patches, and anti-automation Chrome flags. Configurable via `stealth` and `userAgent` options in `poncho.config.js`.

## 0.3.4

### Patch Changes

- Updated dependencies [[`de28ef5`](https://github.com/cesr/poncho-ai/commit/de28ef5acceed921269d15816acd392f5208f03d)]:
  - @poncho-ai/sdk@1.4.1

## 0.3.3

### Patch Changes

- Updated dependencies [[`075b9ac`](https://github.com/cesr/poncho-ai/commit/075b9ac3556847af913bf2b58f030575c3b99852)]:
  - @poncho-ai/sdk@1.4.0

## 0.3.2

### Patch Changes

- Updated dependencies [[`cd6ccd7`](https://github.com/cesr/poncho-ai/commit/cd6ccd7846e16fbaf17167617666796320ec29ce)]:
  - @poncho-ai/sdk@1.3.0

## 0.3.1

### Patch Changes

- Updated dependencies [[`972577d`](https://github.com/cesr/poncho-ai/commit/972577d255ab43c2c56f3c3464042a8a617b7f9e)]:
  - @poncho-ai/sdk@1.2.0

## 0.3.0

### Minor Changes

- [`12f2845`](https://github.com/cesr/poncho-ai/commit/12f28457c20e650640ff2a1c1dbece2a6e4a9ddd) Thanks [@cesr](https://github.com/cesr)! - Add browser storage persistence (cookies/localStorage survive restarts via configured storage provider) and new `browser_content` tool for fast text extraction from pages.

## 0.2.1

### Patch Changes

- Fix browser session reconnection, tab lifecycle management, and web UI panel state handling.

- Updated dependencies []:
  - @poncho-ai/sdk@1.1.1

## 0.2.0

### Minor Changes

- [`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b) Thanks [@cesr](https://github.com/cesr)! - Add browser automation for Poncho agents with real-time viewport streaming, per-conversation tab management, interactive browser control in the web UI, and shared agent-level profiles for authentication persistence.

### Patch Changes

- Updated dependencies [[`139ed89`](https://github.com/cesr/poncho-ai/commit/139ed89a5df2372cfb0a124c967f51f4d8158c3b)]:
  - @poncho-ai/sdk@1.1.0
