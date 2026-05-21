---
"@poncho-ai/harness": patch
---

harness: postgres connection-pool resilience for managed-postgres hosts

Managed Postgres providers (Railway, Neon, Heroku, etc.) drop idle
TCP connections server-side after a few minutes. The previous
postgres-engine config left `idle_timeout` at the porsager/postgres
default (0 = never close client-side), so the pool accumulated stale
sockets; the first query on one rejected with `write CONNECTION_ENDED
<host>:5432` at `durMs=0` and bubbled up as a hard failure to the
caller — including user-facing chat turns and the orchestrator's
subagent callback rerun.

Two complementary settings, plus one belt-and-suspenders retry:

  - `idle_timeout: 20` — close idle client-side connections before
    any reasonable provider-side timer fires. Fresh connection on
    next checkout, no stale-socket race.
  - `max_lifetime: 60 * 10` (10 min) — recycle long-lived
    connections defensively, sidestepping provider-side
    "max connection age" limits.
  - `private query()` now retries once on `CONNECTION_ENDED` /
    `CONNECTION_CLOSED` / `CONNECTION_DESTROYED`. Covers the
    narrow race where a query lands on a connection at the exact
    instant the provider drops it.

Defaults unchanged: `max: 10`, `connect_timeout: 30`. Migration DDL
(`sql.unsafe(sql)` inside `executeRaw`) and transactions
(`sql.begin(...)`) deliberately don't go through the retry — DDL
is `IF NOT EXISTS` idempotent and transactions need atomic scoping.

Observed in production: the PonchOS api running on Railway hit this
during a subagent test, the orchestrator's auto-callback rerun
threw the connection-ended error, a concurrent unhandled async
rejection killed the node process, and Railway restarted the
replica (~50s). User-facing chat turns started seeing the same
error after that. Patch eliminates the source.
