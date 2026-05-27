---
"@poncho-ai/harness": minor
---

harness: stop truncating main memory by default

Main memory injected into the system prompt was hard-truncated at 4000
characters with a `...[truncated]` marker. Silently dropping the tail of
a user's memory every turn is a footgun, so the **default is now no
truncation** — the full memory is injected.

New `MemoryConfig.maxPromptChars` (also settable via
`storage.memory.maxPromptChars`) lets a consumer opt back *into* a cap
for prompt-cost control: set a positive number and content beyond it is
sliced with the `...[truncated]` marker as before.

Behavior change: consumers that relied on the implicit 4000-char cap
will now see full memory in the prompt. To restore the old behavior set
`maxPromptChars: 4000`.
