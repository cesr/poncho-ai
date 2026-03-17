---
"@poncho-ai/browser": patch
---

Fix browser cookie restore failing with "Invalid parameters" by sanitizing Playwright-format cookies to CDP-compatible format before calling Network.setCookies. Falls back to per-cookie restore when batch call fails.
