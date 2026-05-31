---
"@poncho-ai/harness": patch
---

harness: don't inject the "interrupted by a time limit" bridge when resuming from tool results

A taskless `run()` (continuation checkpoint, or `continueFromToolResult` —
e.g. resuming after an approval gate) injected a synthetic user message
telling the model its turn was "interrupted by a time limit ... continue
EXACTLY from where you left off, do not re-summarize." That bridge is only
appropriate when the model was actually cut off mid-response (the last
message is an `assistant` turn, which some providers also reject as a
conversation-ending message).

When the last message is a `tool` result — which is the case for every
`continueFromToolResult` resume — the conversation already ends in a
provider-valid user `tool_result` block and the model continues from the
results naturally. Injecting the bridge there was a bug: after a normal
approval resolution the model was told its turn had been killed by a time
limit, causing it to distrust and re-derive context (re-reading the VFS,
concluding it had "hallucinated" data it had legitimately loaded). The
bridge is now only added when the last message is an `assistant` turn, and
its wording no longer hard-codes "time limit" (max-steps checkpoints use
the same path).
