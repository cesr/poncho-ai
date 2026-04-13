---
"@poncho-ai/harness": patch
---

fix: stop invalidating the prompt cache across runs and preserve cache reads when tool results are in flight.

Two issues were degrading prompt-cache hit rates to ~0 between turns:

1. The system prompt embedded `new Date().toISOString()` (millisecond precision) on every run when a reminder store was active, which changed the very first block of the prefix and prevented any cross-run cache match. The timestamp is now quantized to the hour, which keeps the system prompt stable across runs while still giving the agent a usable sense of time.

2. When the message history contained untruncated tool results from the previous run, prompt caching was disabled entirely — no `cache_control` breakpoint was emitted, which also killed cache *reads* of the stable prefix (system prompt + earlier turns). The breakpoint is now placed immediately before the first untruncated tool result instead, so the stable prefix is still cached and read while the soon-to-be-truncated tail stays out of the cache.

`addPromptCacheBreakpoints` now takes an optional `targetIndex` to support this.
