---
"@poncho-ai/harness": patch
---

Strip provider prefix from model names in AGENT.md (e.g. `anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`). The provider is extracted and used for routing; only the bare model name is sent to the API.
