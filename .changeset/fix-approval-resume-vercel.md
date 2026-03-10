---
"@poncho-ai/cli": patch
---

Fix approval resume dying on Vercel: wrap the post-approval tool execution and run resumption in waitUntil so the serverless function stays alive until the work completes.
