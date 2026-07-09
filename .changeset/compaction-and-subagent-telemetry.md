---
"@poncho-ai/harness": patch
---

Telemetry: make context compaction observable and tag subagent runs.

- When auto-compaction fires mid-run, stamp the active `invoke_agent` span with
  `poncho.compaction.occurred` / `tokens_before` / `tokens_after` /
  `context_window` / `trigger`. Compaction rewrites the message prefix — which
  wipes the per-model prompt cache and forces the next turn to re-create a large
  cached span cold — so "which turns compacted, and what did that cost" was
  previously invisible at the span level. No-op when telemetry is suppressed
  (no active span).
- Subagent runs spawned by the orchestrator now carry
  `telemetryAttributes` (`poncho.run.kind: "subagent"`, `latitude.tags`,
  and a `latitude.metadata` link to the parent conversation) so subagent spend
  segments out of the parent chat/job on the trace instead of being
  indistinguishable from it.
