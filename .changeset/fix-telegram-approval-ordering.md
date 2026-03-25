---
"@poncho-ai/cli": patch
"@poncho-ai/messaging": patch
---

Fix Telegram approval message ordering: send accumulated assistant text before approval buttons so the conversation reads naturally. Skip empty bridge replies when text was already sent at checkpoint.
