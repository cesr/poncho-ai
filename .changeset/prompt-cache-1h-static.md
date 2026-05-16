---
"@poncho-ai/harness": minor
"@poncho-ai/sdk": minor
---

harness: 1h static system-prompt cache breakpoint + per-run cache kill-switch

Two related changes to Anthropic prompt caching:

**1-hour static system-prompt breakpoint.** The harness now splits the
assembled system prompt into a static portion (agent body + skill
context + browser/fs/isolate context — stable across many turns and
jobs within an hour) and a dynamic tail (memory, todos, time). On
Anthropic models, these are sent as two `role: "system"` messages with
`cacheControl: { ttl: "1h" }` on the static block. The existing 5-min
tail breakpoint on the last user/assistant/tool message is retained.

This lets later turns and job runs read ~95% of the system prompt at
0.1× (cache read) instead of paying 1× whenever the 5-min tail cache
has expired — the previous setup only cached for 5 minutes via the
tail breakpoint. Within-user cross-conversation and interactive-vs-job
all share the static cache.

**Per-run cache kill-switch.** Added `RunInput.disablePromptCache?:
boolean` (also exposed on `RunConversationTurnOpts.disablePromptCache`,
forwarded into `runInput`). When set, the harness skips the 5-min tail
breakpoint for that run. The 1-hour static breakpoint is still
applied — the run still benefits from reading the shared static cache,
just doesn't write a new tail entry that won't be read before TTL.

Intended for one-shot programmatic invocations (cron-fired jobs,
subagent dispatch) where no follow-up turn is coming within the 5-min
TTL window, so the 1.25× write surcharge would be pure waste.

Non-Anthropic providers fall through to the previous single concatenated
`system:` string with no cache control — those providers auto-cache.

Internal: `isAnthropicModel` is now exported from `prompt-cache.ts`
for reuse at the streamText site.
