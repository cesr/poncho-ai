---
"@poncho-ai/cli": patch
---

Make approval resume robust: wrap in try/catch to always clear runStatus, and await the work when waitUntil is unavailable so the resume completes before the response is sent.
