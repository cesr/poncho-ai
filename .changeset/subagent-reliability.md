---
"@poncho-ai/harness": patch
---

orchestrator: make subagent result delivery reliable

Subagent results could silently never reach the parent agent. Several
plumbing bugs in `runSubagent` / `runSubagentContinuation`:

- **Emit-before-persist race.** `subagent:completed` / `subagent:error`
  were emitted to the parent's event stream *before* the result was
  written to the store, so a consumer reacting to the event (the parent
  callback, the streaming client) could race the write. Now the result
  is persisted first, then the event is emitted.
- **Silently swallowed writes.** Two `appendSubagentResult(...).catch(() => {})`
  call sites (the error path and the continuation-error path) dropped the
  result with no trace on a transient store failure. Replaced with a
  shared `appendSubagentResultReliable` helper that retries once and then
  logs loudly — a dropped result is the worst failure mode (the parent
  waits forever on a subagent it thinks is still running).
- **Un-awaited eventSink.** The subagent-callback run path was the lone
  `this.eventSink(...)` call site that didn't `await` (every other site
  does), so callback-turn events could interleave out of order. Now awaited.
- **Spawn rejections went to a bare `console.error`.** A background
  `runSubagent` that rejected outside its own try/catch left the parent
  hanging. Both fire-and-forget spawn paths now route to a
  `handleSpawnFailure` that marks the child errored and hands the parent
  an error result so the turn can resume.
- **`recoverStaleSubagents` now also drains undelivered results.** It
  previously only rescued children stuck in `running`; it now also
  re-triggers the parent callback for any parent that has results sitting
  in the store with no active run (e.g. a result persisted just before a
  process restart, whose in-memory callback trigger was lost).
