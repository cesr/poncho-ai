---
"@poncho-ai/messaging": minor
"@poncho-ai/cli": minor
"@poncho-ai/harness": patch
"@poncho-ai/sdk": patch
---

Add generic messaging layer with Slack as the first adapter. Agents can now respond to @mentions in Slack by adding `messaging: [{ platform: 'slack' }]` to `poncho.config.js`. Includes signature verification, threaded conversations, processing indicators, and Vercel `waitUntil` support.
