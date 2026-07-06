---
"@poncho-ai/harness": minor
"@poncho-ai/sdk": minor
---

Prompt-cache efficiency: tail breakpoint pin + volatile context slot + span attribution.

- **Second message-history cache breakpoint.** When prior-run tool results
  are still untruncated, the history breakpoint used to sit only at the
  last *stable* index (before those results) — so a tool-heavy turn
  re-sent everything after it raw on every step. Now a second breakpoint
  is pinned at the true tail, so the current run reads its own growing
  history at 0.1× while the stable entry keeps serving across runs.
  `addPromptCacheBreakpoints` accepts `number | number[]` (out-of-range
  indices dropped, duplicates collapsed). The Anthropic breakpoint budget
  of 4 is now fully spent: static (1h), memory (1h), stable-history, tail.

- **`RunInput.volatileContext`** — per-run context rendered into the
  *uncached* dynamic tail of the system prompt. Embedders that previously
  appended volatile blocks (live VFS tree, connected integrations) to the
  agent body — busting the 1h static cache block on every change — can
  pass them here instead, keeping the static block byte-stable (and
  shareable across users when the agent definition is identical). The
  value is captured per conversation so orchestrator-initiated turns
  (continuations, subagent-callback resumes) reuse it. Forwarded through
  `runConversationTurn` opts.

- **`RunInput.telemetryAttributes`** — extra attributes stamped on the
  `invoke_agent` root span (e.g. `{"poncho.run.kind": "job"}`), letting
  observability backends segment traffic classes without timing
  forensics. Forwarded through `runConversationTurn` opts.
