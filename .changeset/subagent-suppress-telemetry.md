---
"@poncho-ai/sdk": minor
"@poncho-ai/harness": minor
---

harness: propagate `suppressTelemetry` to subagents.

A telemetry-off run (e.g. incognito) now suppresses telemetry for the subagents it spawns too, not just the parent turn. The parent run's `suppressTelemetry` is exposed on `ToolContext`, captured by `spawn_subagent` into the new `SubagentManager.spawn({ suppressTelemetry })` option, stored on the subagent conversation's `subagentMeta`, and read back by the orchestrator's `runSubagent` / continuation so the child run (and its re-runs) emit no `invoke_agent` / `execute_tool` / AI-SDK spans.
