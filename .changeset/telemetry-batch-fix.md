---
"@poncho-ai/harness": patch
---

Switch Latitude telemetry to use BatchSpanProcessor (default) instead of SimpleSpanProcessor. Sends all spans from a trace together in one OTLP batch, matching Latitude's expected integration pattern.
