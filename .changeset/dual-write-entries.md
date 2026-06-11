---
"@poncho-ai/harness": minor
---

Dual-write conversation entries + opt-in parity checker (Phase 3b).

At each conversation write site the orchestrator now ALSO appends the matching
append-only `ConversationEntry`s (`user_message`, `assistant_message`,
`assistant_amendment`, `harness_message`, `compaction`, `subagent_result`,
`callback_started`) alongside the existing mutable-blob write. This is purely
additive instrumentation: read paths still use the blob, so the dual-write is
fire-and-forget and can never corrupt behavior.

An opt-in parity checker (gated on `PONCHO_VERIFY_ENTRIES=1`) rebuilds the LLM
context and display snapshot from the entry log after each turn finalizes and
logs any divergence from the blob under a `[entries-parity]` prefix. It never
throws.

Re-exports the entry types and rebuild functions (`buildLlmContext`,
`buildDisplaySnapshot`, `getPendingSubagentResults`) from the package root so
downstream consumers can build on the substrate.
