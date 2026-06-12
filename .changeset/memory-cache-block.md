---
"@poncho-ai/harness": patch
---

The user's memory file gets its own 1-hour Anthropic cache breakpoint.
It previously rode the uncached dynamic system tail (with todos + time),
which re-wrote the memory block — typically the bulk of a new
conversation's one-time cache cost — on every cold prefix, despite memory
only changing on explicit writes. System prompt is now three tiers:
static (1h), memory (1h), volatile todos+time (uncached).
