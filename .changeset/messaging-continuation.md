---
"@poncho-ai/messaging": minor
"@poncho-ai/cli": minor
---

Add auto-continuation support for messaging adapters (Telegram, Slack, Resend) on serverless platforms. When `PONCHO_MAX_DURATION` is set, agent runs that hit the soft deadline now automatically resume with "Continue" messages, matching the web UI and client SDK behavior.
