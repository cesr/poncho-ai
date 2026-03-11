---
"@poncho-ai/browser": minor
"@poncho-ai/cli": patch
---

Support remote and serverless browser deployments.

**@poncho-ai/browser**: Add `provider` and `cdpUrl` config options for cloud browser services (Browserbase, Browser Use, Kernel) and direct CDP connections. Auto-detect `@sparticuz/chromium` on serverless platforms (Vercel, Lambda) and default the profile directory to `/tmp`.

**@poncho-ai/cli**: Generate @vercel/nft trace hints for `@poncho-ai/browser` and `@sparticuz/chromium` in the Vercel entry point so dynamically-loaded browser packages are bundled into the serverless function.
