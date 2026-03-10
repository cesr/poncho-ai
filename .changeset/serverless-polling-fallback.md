---
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
---

Add polling fallback for web UI on serverless deployments: when the SSE event stream is unavailable (different instance from the webhook handler), the UI polls the conversation every 2 seconds until the run completes. Conversations now track a persisted `runStatus` field.
