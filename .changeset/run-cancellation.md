---
"@poncho-ai/sdk": minor
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
"@poncho-ai/client": minor
---

Add cooperative run cancellation: stop active runs via Ctrl+C (CLI), stop button (Web UI), or the /stop API endpoint. Partial output is preserved and empty assistant messages are skipped to prevent conversation corruption.
