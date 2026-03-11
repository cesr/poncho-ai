# @poncho-ai/browser

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
