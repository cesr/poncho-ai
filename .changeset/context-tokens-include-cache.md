---
"@poncho-ai/harness": patch
---

Auto-compaction never fired on cached conversations: the per-step context
measure (`latestContextTokens`) used `usage.inputTokens`, which with
Anthropic prompt caching is only the NON-cached slice — a real 190k+
conversation reported ~12k of "context", so the trigger comparison never
tripped and transcripts grew past the model's window. Context now counts
input + cache-read + cache-write tokens (everything the model read). Also
pins claude-fable-5 / opus-4-8 / opus-4-7 in the context-window registry
(previously relying on the silent 200k default).
