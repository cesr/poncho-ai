---
"@poncho-ai/harness": patch
---

Fix: checkpoint-resume no longer drops a turn's user message from the model
transcript. Extract the checkpoint→transcript assembly the orchestrator's
`resumeRunFromCheckpoint` used into shared, exported helpers —
`assembleCheckpointMessages`, `buildToolResultMessage`, `buildResumeCheckpoints`
— so external embedders (which execute gated tools themselves) reconstruct the
canonical transcript identically instead of re-deriving the index arithmetic
and drifting. Add a transcript-integrity guard in `applyTurnMetadata` that
logs when a finalize would leave the latest user message out of the
model-facing transcript.
