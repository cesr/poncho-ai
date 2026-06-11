---
"@poncho-ai/harness": minor
---

storage: add append-only conversation-entry substrate (unused groundwork)

Pure entry types + rebuild functions (`buildLlmContext`,
`buildDisplaySnapshot`, `getPendingSubagentResults`) for the eventual
append-only conversation model that removes the mutable-blob clobber race
(the root cause behind lost subagent results). No storage-engine wiring
and no live callers yet — additive, deploys nothing behavioral. The
rebuild logic (compaction overlay, amendment folding, callback-consumption)
is covered by unit tests so the design is proven before the bigger
dual-write / migration / cutover PRs.
