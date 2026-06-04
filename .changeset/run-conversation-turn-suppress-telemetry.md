---
"@poncho-ai/harness": patch
---

harness: forward `suppressTelemetry` through `runConversationTurn` and `continueFromToolResult`.

`RunConversationTurnOpts` and `continueFromToolResult`'s input now carry `suppressTelemetry`, passed into the run input (alongside the existing `disablePromptCache` passthrough). Hosts driving turns through these helpers (rather than calling `runWithTelemetry` directly) can now suppress telemetry per turn and per approval-resume — the missing piece for serving telemetry-off (incognito) turns and their continuations from a single shared harness.
