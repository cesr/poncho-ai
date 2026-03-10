---
"@poncho-ai/cli": patch
---

Use `waitUntil` for messaging webhook route handlers on Vercel so the function stays alive for the full email processing after responding with 200.
