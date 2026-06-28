---
"@poncho-ai/browser": patch
---

Fix a deadlock that wedged the browser session after the first lock-acquire
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
