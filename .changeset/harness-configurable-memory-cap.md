---
"@poncho-ai/harness": minor
---

harness: make the main-memory prompt cap configurable

Main memory injected into the system prompt was hard-truncated at 4000
characters with a `...[truncated]` marker. New `MemoryConfig.maxPromptChars`
(also settable via `storage.memory.maxPromptChars`) lets a consumer
raise that ceiling, or set it to `0` to disable truncation entirely and
inject the full memory.

Default is unchanged (4000), so existing consumers are unaffected. The
`0`/unbounded mode is intended for products where memory is the primary
personalization surface and a consolidation job keeps it dense — there,
silently dropping the tail of memory every turn is worse than the extra
prompt length.
