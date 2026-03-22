---
"@poncho-ai/cli": patch
"@poncho-ai/messaging": patch
---

Fix /new command on Telegram in serverless environments: persist conversation reset to the store so it survives cold starts.
