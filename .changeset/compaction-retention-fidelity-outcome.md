---
"@poncho-ai/harness": minor
"@poncho-ai/sdk": minor
---

Fix context-compaction correctness so the agent stops losing context and
mislabeling failed work after a compaction:

- **Turn-based retention.** Compaction now preserves the last N whole *turns*
  verbatim (new `compaction.keepRecentTurns`, default 4) instead of N messages,
  which in tool-heavy turns collapsed to just the summary. The preserved side is
  bounded by a token budget (≤ 50% of the context window) so keeping recent turns
  can't leave the post-compaction context above the trigger (re-compaction
  thrash / overflow). Adds exported `findSafeSplitPointByTurns`.
- **Faithful summaries.** The summarization output cap is raised 768 → 8192
  tokens (768 physically truncated summaries mid-content); per-message truncation
  1200 → 4000 chars, with a total summarizer-input budget that drops the oldest
  non-error messages first. The prompt now requires a non-omittable "Unresolved
  errors & failures" section, a "Pending promises" section, forbids claiming
  unconfirmed completion, and preserves identifiers verbatim.
- **Structured subagent task outcome.** New `PendingSubagentResult.taskOutcome`
  (`succeeded | failed | partial | unknown`) distinct from run status: a subagent
  that ran but failed its task is no longer recorded as "completed". Subagents
  self-report a machine-readable verdict; it is parsed deterministically
  (defaulting to "unknown", never success) and rendered in the callback header
  and compaction ledger. The subagent digest is enlarged (2000 chars, ungated on
  status) so the failure reason survives compaction.
- **Per-run `maxSteps` override.** New `RunInput.maxSteps` lets a caller raise the
  step ceiling for foreground turns without raising it for background/job turns
  that share the same agent definition.
