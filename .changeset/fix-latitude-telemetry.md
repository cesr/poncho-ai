---
"@poncho-ai/harness": patch
"@poncho-ai/cli": patch
---

Fix Latitude telemetry not exporting traces

- Reuse a single `LatitudeTelemetry` instance across runs instead of creating one per run (avoids OpenTelemetry global registration conflicts)
- Use `disableBatch` mode so spans export immediately instead of being silently lost on a 5s timer
- Warn at startup when `telemetry.latitude` is configured with missing or misnamed fields (e.g. `apiKeyEnv` instead of `apiKey`)
- Sanitize agent name for Latitude's path validation
- Surface OTLP export errors in console output
