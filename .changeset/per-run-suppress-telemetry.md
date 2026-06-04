---
"@poncho-ai/sdk": minor
"@poncho-ai/harness": minor
---

harness: add a per-run `suppressTelemetry` flag so one harness can serve both telemetry-on and telemetry-off runs.

Telemetry was effectively an instance-level property: whether the OTLP exporter is attached is decided at construction, so a host that wants telemetry-off runs (e.g. incognito) had to build and maintain a *second* harness instance with no exporter — duplicating all per-harness provisioning (tool registration, subagent manager, etc.) and risking drift between the two.

`RunInput.suppressTelemetry` lets a single harness — built once, with the exporter attached — emit nothing for a given run: the `invoke_agent` root span, the `execute_tool` spans, and the AI-SDK spans are all gated on `!input.suppressTelemetry`. Hosts can now keep one harness per user and pass `suppressTelemetry: true` per run instead of routing to a parallel exporter-less instance.
