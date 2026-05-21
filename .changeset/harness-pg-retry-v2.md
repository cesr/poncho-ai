---
"@poncho-ai/harness": patch
---

harness: postgres retry covers exec/transaction + 3 attempts + tighter idle

Follow-up to the previous `idle_timeout`/`max_lifetime`/retry patch.
Live testing on Railway showed the previous values weren't tight
enough — `write CONNECTION_ENDED postgres.railway.internal:5432`
still surfaced both during user-facing chat turns and during
subagent auto-callback reruns, despite the new config and the
one-shot retry.

Two failure modes the previous version didn't cover:

1. The retry only wrapped `private query()` (executor.run/get/all),
   but `executor.exec` (`sql.unsafe`) and `executor.transaction`
   (`sql.begin`) called the postgres.js client directly. A pg drop
   inside a transaction or migration write threw straight through.

2. After an idle period the pool can have multiple stale sockets;
   a single retry can checkout a second stale socket from the pool
   and fail again. One-shot retry exhausted into an error visible
   to the caller.

Fixes:

  - All three executor paths (`run/get/all`, `exec`, `transaction`)
    now go through the same `runWithRetry` wrapper. Transactions
    only retry the connection-level `CONNECTION_ENDED` reject from
    the postgres.js client — actual SQL errors mid-transaction
    surface as a different error class and bypass the retry,
    preserving atomic semantics.
  - Three attempts with light exponential backoff (0, 50ms, 200ms).
    Enough to ride out a typical staleness wave; if all three fail
    the network is genuinely broken.
  - `CONNECT_TIMEOUT` and `ECONNRESET` added to the retry-eligible
    error codes.

Config knobs tightened:

  - `idle_timeout: 5` (was 20). Empirically Railway's pg drops
    sockets well before 20s; 5s wins the race in practice while
    staying long enough for bursty workloads to reuse connections.
  - `max_lifetime: 300` (was 600). Same reasoning — recycle more
    aggressively.
  - `connect_timeout: 10` (was 30 default). Faster failure during
    incidents lets callers shed load instead of stacking up.
