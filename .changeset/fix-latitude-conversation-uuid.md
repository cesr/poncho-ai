---
"@poncho-ai/harness": patch
---

Fix Latitude telemetry traces being silently dropped when conversation IDs are not valid UUIDs (e.g. Resend/Slack-derived IDs). Only pass conversationUuid to Latitude when it matches UUID v4 format.
