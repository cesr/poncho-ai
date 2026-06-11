---
"@poncho-ai/harness": patch
"@poncho-ai/sdk": patch
---

Mark in-flight assistant drafts with `metadata.incomplete = true`.

The orchestrator's per-step draft persist (`persistDraft`) and the
approval/device checkpoint and continuation writes now stamp the trailing
assistant message `metadata.incomplete = true`; the three terminal writes
(normal finalize, cancelled, errored) clear it. This lets a consumer that
reconciles a persisted snapshot against a live event stream (e.g. a
WebSocket layer) strip the in-flight draft from the authoritative snapshot
and rebuild that turn from the event log instead — so the snapshot and the
replayed events never both carry the in-flight turn, eliminating
reconnect-time duplication. Additive + backwards-compatible: consumers that
ignore the flag are unaffected.
