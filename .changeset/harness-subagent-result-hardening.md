---
"@poncho-ai/harness": patch
---

harness: harden subagent → parent result delivery so a step-exhausted subagent stops surfacing as `(no response)`.

- **Force a closing text turn on the final step.** On the last permitted step (`step === maxSteps`) the run loop now strips the tools and appends a one-shot "summarize now, no tools" nudge to that model request, so a run that hits its step ceiling produces a real text summary instead of terminating on a dangling tool call. Previously such a run ended on a tool-call turn with no final text — common in subagents doing many tool calls — and the parent received an empty result. `maxSteps` itself is unchanged; the nudge is request-only and never written to history.
- **Content-shape-robust result extraction.** Pulling a subagent's response no longer requires the last assistant message to be a plain `string`. The new `lastAssistantText` helper handles `string`, `ContentPart[]`, and the run loop's `{"text":...,"tool_calls":[...]}` envelope, and walks backwards to the last non-empty assistant text — so a transcript that ends on a text-less tool turn still yields the prose produced just before it.
- **Actionable empty-result sentinel.** When a subagent genuinely produced no summary, the injected parent message now says how many steps ran and points at `read_subagent(<id>, mode:"assistant")` to recover the work, instead of a dead-end `(no response)`.
