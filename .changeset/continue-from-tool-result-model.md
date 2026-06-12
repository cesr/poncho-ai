---
"@poncho-ai/harness": patch
---

`continueFromToolResult` accepts and forwards the per-run `model` override, so approval-checkpoint continuations run on the same model as the checkpointed run instead of re-reading the (possibly concurrently-mutated) agent frontmatter.
