---
"@poncho-ai/harness": minor
---

harness: cache MCP clients per `(serverName, tenantId)` instead of rebuilding per call

When a tenant resolves a different bearer token than the host's
`process.env` default for an MCP server, the per-call handler used to
construct a brand-new `StreamableHttpMcpRpcClient` on every tool call.
For builders this rarely triggered. For consumer/SaaS deployments where
**every** call resolves a different per-user token, every tool call
forced a fresh `initialize` round-trip — no session reuse, high
latency, and a behaviour the recently-added 404 session-retry can't
help with because there was nothing to retry.

`LocalMcpBridge` now keeps a `Map<key, { client, token, lastUsed }>`
keyed by `(serverName, tenantId)`. Lookups reuse the cached client when
the token is unchanged and the entry is within the configured idle TTL
(default 15 minutes). On token rotation or TTL expiry the entry is
evicted lazily and rebuilt. `stopLocalServers()` closes all cached
tenant clients alongside the server-default ones.

The TTL is configurable via a constructor option (`tenantClientTtlMs`)
for tests and tuning.
