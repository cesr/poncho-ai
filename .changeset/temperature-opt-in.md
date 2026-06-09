---
"@poncho-ai/harness": patch
---

Only send `temperature` to the model when the agent explicitly sets one. The harness previously defaulted to `temperature: 0.2` and always passed it to `streamText`, which returns a 400 ("`temperature` is deprecated for this model") on models that removed sampling params (Fable 5, Opus 4.7+). `temperature` is now omitted from the request when undefined — the same treatment `maxTokens` already had — and `defaultAgentDefinition` no longer hard-codes a `temperature` line into the generated frontmatter (pass `temperature` explicitly to set one).
