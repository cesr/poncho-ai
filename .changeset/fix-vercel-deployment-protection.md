---
"@poncho-ai/cli": patch
---

Fix internal self-fetch blocked by Vercel Deployment Protection and PONCHO_AUTH_TOKEN

- Include x-vercel-protection-bypass header when VERCEL_AUTOMATION_BYPASS_SECRET is set
- Internal requests with valid x-poncho-internal header bypass the PONCHO_AUTH_TOKEN auth gate
- Better error messages distinguishing Vercel Deployment Protection from internal auth failures
