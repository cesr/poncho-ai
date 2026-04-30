---
"@poncho-ai/harness": patch
---

fix(harness): browser status/frame listeners no longer pin runInput across runs

Heap-snapshot evidence pointed to the actual leak: `BrowserSession.tabs[cid].statusListeners`
was retaining ~3.4 GB on a long browser session. Each `harness.run()`
registered two arrow-function listeners (frame + status) whose lexical
scope captured the entire run scope, including `input.parameters.__toolResultArchive`.
V8 captures the full enclosing scope into the closure's Context object
even for variables the listener body doesn't reference, so the runInput
was reachable through every listener.

Two fixes:

1. The listeners are now produced by module-scope factories
   (`makeBrowserFrameListener`, `makeBrowserStatusListener`) whose only
   captured variable is the target event queue. The runInput is no longer
   in scope when the closure is created.

2. The listener cleanup at the end of `run()` is now in a `try/finally`,
   so listeners are always removed — even when the run errors or the
   consumer abandons the generator. Previously a thrown run would leave
   listeners pinned forever.
