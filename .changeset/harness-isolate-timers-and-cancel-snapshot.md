---
"@poncho-ai/harness": patch
---

harness: fix three `run_code` / cancellation bugs.

- **Timers polyfill never fired delayed callbacks.** `setTimeout(fn, ms)` only ran the callback when `ms === 0`; any non-zero delay was stored and never invoked, so `await new Promise(r => setTimeout(r, 50))` (the standard sleep) hung forever. The polyfill now drains pending timers on the microtask queue in delay order against a virtual clock, so sleeps resolve and `setInterval`/`clearInterval` work.
- **No wall-clock bound on `run_code`.** isolated-vm's `timeout` only bounds synchronous execution; a script that returns a never-settling promise hung the whole turn indefinitely. `runtime.execute` now races the eval against a host timer that disposes the isolate, so `isolate.timeLimit` bounds total execution and returns a `TimeoutError`.
- **Stopping a turn mid-tool-call dropped the assistant turn from canonical history.** On cancellation the in-flight assistant message (its text + tool calls) lives only in step-local state — it's pushed to `messages` together with the tool results, which never arrive when stopped. The cancellation snapshot now re-attaches that turn with a synthesized "cancelled by user" tool result for each pending tool call, so the next request keeps a valid record instead of showing the model back-to-back user messages.
