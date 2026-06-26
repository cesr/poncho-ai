---
"@poncho-ai/harness": patch
---

Guard a single oversized FRESH tool result from overflowing the context
window. `truncateHistoricalToolResults` only shrinks results from prior runs
(it deliberately preserves the latest run's results so the model can read what
it just fetched), so a tool that returns a payload larger than the window in
one shot — e.g. an MCP email-fetch returning 1.6M–3.3M tokens of full bodies —
was never truncated and failed the very next step with "prompt is too long".

The result is now guarded at the moment it's produced, before the
`tool:completed` event is emitted (so the WS stream never carries the megabytes
either) and before it reaches the model:

- **Spill mode** (opt-in via the `__toolResultSpill` run parameter
  `{ enabled, dir?, thresholdChars?, keepLast? }`): the full payload is written
  to a VFS file (JSONL for arrays, pretty JSON otherwise) and the model gets a
  small handle + preview pointing at it, to read back in bounded chunks with
  bash/jq. Durable and lossless; the spill dir is pruned to `keepLast` files.
- **Inline-truncate mode** (default when spill isn't enabled, and the fallback
  if a spill write fails): the payload is replaced with a preview + "re-run
  narrower" notice.

Both modes apply to every tool uniformly (MCP, bash, run_code, subagent
results) and only trigger above `thresholdChars` (default 500k ≈ 125k tokens),
so normal-sized results are untouched. Inline media (images/PDFs) is separated
out first and unaffected.
