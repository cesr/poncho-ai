---
"@poncho-ai/harness": minor
---

compaction: preserve subagent context and prior summaries, harden the split

Three improvements to context compaction (fires at ~75% context):

- **Split safety**: `findSafeSplitPoint` now refuses a split whose compacted
  side would end on an assistant message with unanswered `tool_calls` (its
  answering `role:"tool"` result having moved to the preserved side), walking
  earlier to the next clean `user` boundary. Prevents orphaning a tool-call
  relationship inside the summary boundary. Still returns `-1` when no safe
  point exists.
- **Subagent ledger**: while compacting, scans for subagent-callback records
  (metadata `_subagentCallback`/`subagentCallback`, or text starting with
  `[Subagent Result]`) and any `## Subagents` block embedded in a prior
  compaction summary, then renders a combined, deduped (by `subagentId`)
  ledger that is appended VERBATIM after the LLM summary text — so the model
  can never paraphrase or truncate subagent results away. Cumulative across
  successive compactions.
- **Cumulative summary**: when the first compacted message is itself a prior
  compaction summary, it is passed to the summarizer in full (not truncated
  to 1200 chars) and the prompt instructs the model to merge-and-update the
  prior working state rather than re-summarize it from scratch. All other
  messages keep the 1200-char truncation.
