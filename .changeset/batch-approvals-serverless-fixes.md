---
"@poncho-ai/sdk": minor
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
---

Batch tool approvals, fix serverless session persistence and adapter init

- Batch tool approvals: all approval-requiring tool calls in a single step are now collected and presented together instead of one at a time.
- Fix messaging adapter route registration: routes are only registered after successful initialization, preventing "Adapter not initialised" errors on Vercel.
- Add stateless signed-cookie sessions so web UI auth survives serverless cold starts.
