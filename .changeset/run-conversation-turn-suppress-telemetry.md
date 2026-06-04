---
"@poncho-ai/harness": patch
---

harness: forward `suppressTelemetry` through `runConversationTurn`.

`RunConversationTurnOpts` now carries `suppressTelemetry`, passed into the run input (alongside the existing `disablePromptCache` passthrough). Hosts driving turns through `runConversationTurn` (rather than calling `runWithTelemetry` directly) can now suppress telemetry per turn — the missing piece for serving telemetry-off (incognito) turns from a single shared harness.
