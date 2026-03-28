---
"@poncho-ai/harness": patch
"@poncho-ai/cli": patch
---

fix: OTLP trace exporter reliability and error visibility

- Use provider instance directly instead of global `trace.getTracer()` to avoid silent failure when another library registers a tracer provider first
- Append `/v1/traces` to base OTLP endpoints so users can pass either the base URL or the full signal-specific URL
- Surface HTTP status code and response body on export failures
- Enable OTel diagnostic logger at WARN level for internal SDK errors
