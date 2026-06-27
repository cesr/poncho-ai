---
"@poncho-ai/harness": patch
---

Browser config: support embedding apps that own per-tenant browser sessions
and the live viewport.

- `browser.sessionName` now overrides the browser session id (previously
  always `poncho-${agentId}`). Lets a multi-tenant host isolate sessions
  per user even when every user shares one agent definition.
- `browser.storagePersistence` lets the host supply its own
  `{ save(json), load() }` for the browser storage state (cookies +
  localStorage). When provided, the harness skips its built-in file-based
  persistence — so state can live in an encrypted/DB-backed per-tenant store.
- `browser.hostManagedStreaming` makes the harness skip wiring
  `onFrame`/`onStatus` during `run()`, so no `browser:frame` / `browser:status`
  events are emitted into the agent event stream. The host subscribes to the
  `BrowserSession` listeners directly and streams frames out-of-band (and can
  keep the viewport interactive while the agent is idle).
