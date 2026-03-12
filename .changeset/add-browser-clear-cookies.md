---
"@poncho-ai/browser": patch
---

Add `browser_clear_cookies` tool for deleting browser cookies

Agents with `browser: true` can now call `browser_clear_cookies` to delete cookies from the live browser and persisted storage. Accepts an optional `url` parameter to scope deletion to a specific site (e.g. "https://example.com"); omit to clear all cookies.
