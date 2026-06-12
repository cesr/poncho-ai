---
"@poncho-ai/harness": patch
"@poncho-ai/sdk": patch
---

Add a per-run `model` override to `RunInput` (and forward it from `runConversationTurn`'s opts). The override is captured once at run start and wins over the agent definition's `model.name` for every step of the run.

Previously the only way to vary the model per run kind on a shared harness was mutating `parsedAgent.frontmatter.model.name` before each run — but the harness re-reads that field at the start of every step, so a concurrent run's mutation flipped an in-flight run's model mid-turn. Besides being the wrong model, the switch invalidated the run's entire Anthropic prompt cache (caches are per-model), observed in production as the same ~104k-token prefix being cache-written twice back-to-back, once per model. Callers should pass `model` in the run input instead of mutating frontmatter.
