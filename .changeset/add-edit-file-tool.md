---
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
---

Add `edit_file` built-in tool with str_replace semantics for targeted file edits. The tool takes `path`, `old_str`, and `new_str` parameters, enforces uniqueness of the match, and is write-gated like `write_file` (disabled in production by default). Also improves browser SSE frame streaming with backpressure handling and auto-stops screencast when all listeners disconnect.
