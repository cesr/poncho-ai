# @poncho-ai/browser

## 0.7.2

### Patch Changes

- Updated dependencies [[`8a5a367`](https://github.com/cesr/poncho-ai/commit/8a5a367dd4b2ea477b3e0146a7253cedcdc34a1c)]:
  - @poncho-ai/sdk@1.16.0

## 0.7.1

### Patch Changes

- [#188](https://github.com/cesr/poncho-ai/pull/188) [`97772cc`](https://github.com/cesr/poncho-ai/commit/97772ccf2c07ec3a3f3350ef3a65596fba91a154) Thanks [@cesr](https://github.com/cesr)! - Add residential-proxy support for Browserbase sessions so IP-reputation walls
  (Reddit, LinkedIn, Instagram, …) stop returning 403 "blocked by network
  security". Datacenter IPs are blocked before any fingerprint check, so stealth
  alone can't get past them.
  - Known IP-blocking domains are proxied automatically (domain gate).
  - `browser_open` gains a `proxy` param so the agent can retry any other site
    that blocked it through a residential IP.
  - `BrowserConfig.proxies` sets the default mode for every session.

  Because proxies are fixed at Browserbase-session creation (and Vercel's
  agent-browser hardcodes the create body to `{ projectId }`), we create the
  Browserbase session ourselves with `proxies: true` and connect agent-browser to
  it via its `cdpUrl` path. Switching proxy mode mid-conversation recreates the
  session; cookies/localStorage are persisted and restored across the recreate,
  so login state survives.

## 0.7.0

### Minor Changes

- [#184](https://github.com/cesr/poncho-ai/pull/184) [`12ce2be`](https://github.com/cesr/poncho-ai/commit/12ce2be01c9d98b1d9aa634d4d8051c4c0094a44) Thanks [@cesr](https://github.com/cesr)! - Add `browser_download` so the agent can save files from the browser into the
  VFS. The tool fetches a file using the page's logged-in session (so it works
  for files behind a login) and writes the bytes straight to the tenant's VFS via
  `ToolContext.vfs` — never through the model. `url` defaults to the current page,
  or pass a same-origin link's href. The fetch runs inside the page (`evaluate`),
  so it works identically for local and remote/cloud browsers (bytes return over
  CDP). Capped at 25 MB. The harness browser system prompt now documents it under
  a "Saving files" section.

## 0.6.26

### Patch Changes

- [#182](https://github.com/cesr/poncho-ai/pull/182) [`5ca3615`](https://github.com/cesr/poncho-ai/commit/5ca361576cbe1a97e6315f550a58a302b4e70aca) Thanks [@cesr](https://github.com/cesr)! - Keep host viewport listeners alive across browser sessions. `onFrame` /
  `onStatus` listeners were stored inside the per-conversation `ConversationTab`
  object, so `closeTab` (and LRU eviction) deleted them along with the tab. When
  an agent closed one browser and opened another in the same conversation, the
  new tab had empty listener sets — the host's live-viewport subscription was
  silently orphaned, so the second session's `browser:status` / frames never
  reached the client until it reconnected (the "pill/sheet doesn't appear, or is
  left over after close, until I navigate away and back" bug). Listeners now live
  in session-level maps keyed by conversationId, independent of any tab's
  lifetime; they persist until the host unsubscribes, and `emitStatus` delivers
  the final `active:false` on close before the tab is removed.

## 0.6.25

### Patch Changes

- [#180](https://github.com/cesr/poncho-ai/pull/180) [`4e27887`](https://github.com/cesr/poncho-ai/commit/4e27887655eda1d420b8f69097cfc79e42f9596c) Thanks [@cesr](https://github.com/cesr)! - Fix a deadlock that wedged the browser session after the first lock-acquire
  timeout. `lock()` pushed a wrapper closure onto `_lockQueue` but, on the 30s
  timeout, tried to remove the entry with `indexOf(resolve)` — searching for a
  different function — so the timed-out waiter was never spliced out. When the
  current owner later called `unlock()`, it `shift()`ed that zombie waiter and
  invoked it; `resolve()` on the already-rejected promise was a no-op, so the
  unlock was consumed by a dead waiter, `_locked` stayed `true`, and no live
  operation could ever acquire the lock again. Every subsequent browser call
  then returned "Browser operation timed out waiting for lock (30s)" until the
  session was torn down. Waiters are now tracked as objects with a `settled`
  flag: a timed-out waiter removes itself from the queue, and `unlock()` skips
  any already-settled waiters when handing off ownership.

## 0.6.24

### Patch Changes

- [`51859a9`](https://github.com/cesr/poncho-ai/commit/51859a94041ade5ec9a9892165099d610c3bc363) Thanks [@cesr](https://github.com/cesr)! - Dispatch wheel/scroll events with no pressed button. `injectScroll` went through
  `injectMouse`, which defaults the button to `"left"`, so a `mouseWheel` was sent
  _with the left button_ — Chrome treated scrolling as a left-button drag and could
  leave the button stuck "down", after which clicks stopped registering. Send
  `button: "none"` for wheel events.

## 0.6.23

### Patch Changes

- [`2d518d1`](https://github.com/cesr/poncho-ai/commit/2d518d1666e69d63a94be8a781d11d0569e6af7b) Thanks [@cesr](https://github.com/cesr)! - Force the configured viewport on remote browsers (cloud provider / cdpUrl).
  `launchOpts.viewport` is only honored when launching a local context, so a
  Browserbase/Kernel/CDP session rendered at the provider's large default — the
  page looked huge, content tiny, scrolling appeared broken, and tap coordinates
  mismatched the frame after reconnect. After connecting, call
  `setViewport(width, height)` so the page renders at the intended size and frames
  - input stay consistent.

## 0.6.22

### Patch Changes

- [`3588b19`](https://github.com/cesr/poncho-ai/commit/3588b19cf8e8fb112df3642b93e8a6aa4d4e3021) Thanks [@cesr](https://github.com/cesr)! - Steer the agent to use `browser_open` only as a last resort. The description now
  tells it to prefer `web_fetch` for reading pages and a dedicated API/MCP
  integration when one exists, and to reach for the browser only when those can't
  do the job — a page web_fetch can't render, or operating a site/web app that has
  no API and no MCP (e.g. logging in and clicking through a UI). Reinforces that
  credentials are entered by the user in the live view, never asked for in chat.

## 0.6.21

### Patch Changes

- Updated dependencies [[`3a25676`](https://github.com/cesr/poncho-ai/commit/3a2567666e1bc8d6650818db76d07765c0250264)]:
  - @poncho-ai/sdk@1.15.2

## 0.6.20

### Patch Changes

- Updated dependencies [[`299f574`](https://github.com/cesr/poncho-ai/commit/299f574a2f2f0d4873f42bbcffdf604e9cc4c29c)]:
  - @poncho-ai/sdk@1.15.1

## 0.6.19

### Patch Changes

- Updated dependencies [[`bfa4976`](https://github.com/cesr/poncho-ai/commit/bfa4976ac8b05a300e22271e23c3bae4aadae2a8)]:
  - @poncho-ai/sdk@1.15.0

## 0.6.18

### Patch Changes

- Updated dependencies [[`d8453b4`](https://github.com/cesr/poncho-ai/commit/d8453b4f2360a1734e448960fe52f6c450cdf842)]:
  - @poncho-ai/sdk@1.14.0

## 0.6.17

### Patch Changes

- Updated dependencies [[`773f113`](https://github.com/cesr/poncho-ai/commit/773f11309e2410d6c5e17af0fde17425953105f2)]:
  - @poncho-ai/sdk@1.13.0

## 0.6.16

### Patch Changes

- Updated dependencies [[`e8df464`](https://github.com/cesr/poncho-ai/commit/e8df4649618cba0b408a6c143f923f0dcb2046c8)]:
  - @poncho-ai/sdk@1.12.0

## 0.6.15

### Patch Changes

- Updated dependencies [[`1adaae2`](https://github.com/cesr/poncho-ai/commit/1adaae2d4cc55800f01d602f2a7d6ecc65031443)]:
  - @poncho-ai/sdk@1.11.0

## 0.6.14

### Patch Changes

- Updated dependencies [[`524df41`](https://github.com/cesr/poncho-ai/commit/524df411904bd00c07901695eda6d4dd07dde972), [`9616060`](https://github.com/cesr/poncho-ai/commit/96160607502c2c0b05bc60b67b8fc012f4052ef1)]:
  - @poncho-ai/sdk@1.10.0

## 0.6.13

### Patch Changes

- Updated dependencies [[`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d), [`ef4fe5d`](https://github.com/cesr/poncho-ai/commit/ef4fe5d1fd4bb31c201fd240f4524b64f01e3e6d)]:
  - @poncho-ai/sdk@1.9.0

## 0.6.12

### Patch Changes

- Support network configuration passthrough for browser tool initialization.

- Updated dependencies []:
  - @poncho-ai/sdk@1.8.1

## 0.6.11

### Patch Changes

- Updated dependencies [[`83d3c5f`](https://github.com/cesr/poncho-ai/commit/83d3c5f841fe84965d1f9fec6dfc5d8832e4489a)]:
  - @poncho-ai/sdk@1.8.0

## 0.6.10

### Patch Changes

- Updated dependencies [[`2341915`](https://github.com/cesr/poncho-ai/commit/23419152d52c39f3bcaf8cdcd424625d5f897315)]:
  - @poncho-ai/sdk@1.7.1

## 0.6.9

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@1.7.0

## 0.6.8

### Patch Changes

- Updated dependencies [[`193c367`](https://github.com/cesr/poncho-ai/commit/193c367568dce22a470dff6acd022c221be3b722)]:
  - @poncho-ai/sdk@1.6.3

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
