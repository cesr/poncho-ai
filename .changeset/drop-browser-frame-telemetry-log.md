---
"@poncho-ai/harness": patch
"@poncho-ai/cli": patch
---

chore: drop browser-frame noise from the dev log

Two sources of per-frame log noise during interactive browser use
are now silenced:

- `TelemetryEmitter.emit` skips `browser:frame` events alongside the
  already-skipped `model:chunk`. OTLP forwarding and custom handlers
  still receive every event unchanged.
- The CLI's browser SSE endpoint no longer prints the
  `[poncho][browser-sse] Frame N: WxH, data bytes: ...` counter
  (which fired for the first 3 frames and every 50th). Related
  `frameCount` / `droppedFrames` state dropped with it.
