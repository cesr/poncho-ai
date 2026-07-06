---
"@poncho-ai/harness": patch
---

Forward `volatileContext` and `telemetryAttributes` through `continueFromToolResult`. The per-conversation capture already covers same-process continuations, but a checkpoint resumed after a process restart would silently lose the embedder's volatile blocks; resume callers can now pass them explicitly.
