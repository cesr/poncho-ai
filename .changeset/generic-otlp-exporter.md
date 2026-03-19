---
"@poncho-ai/harness": minor
"@poncho-ai/sdk": patch
---

Add generic OTLP trace exporter for sending OpenTelemetry traces to any collector (Jaeger, Grafana Tempo, Honeycomb, etc.). Configure via `telemetry.otlp` as a URL string or `{ url, headers }` object. Works alongside or instead of Latitude telemetry.
