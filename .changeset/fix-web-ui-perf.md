---
"@poncho-ai/cli": patch
---

Fix browser hangs during long conversations in the web UI by throttling streaming renders with requestAnimationFrame and caching markdown parse output.
