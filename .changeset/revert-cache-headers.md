---
"@poncho-ai/cli": patch
---

Revert unnecessary Cache-Control headers from JSON API responses (the root cause was a missing ownerId, not edge caching).
