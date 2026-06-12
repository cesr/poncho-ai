---
"@poncho-ai/harness": patch
---

Preserve the LLM transcript when a turn dies. The errored branch of
runConversationTurn persisted only the display draft — `_harnessMessages`
was never updated, so the model's next turn had no memory of the entire
failed interaction (its user message included), even though the user could
see it on screen. Both the errored branch and the cancelled-without-
`run:cancelled.messages` fallback now append a faithful plain-text
reconstruction (user message + assistant text-so-far + tool activity + an
interruption note) to the transcript. Plain text on purpose: replaying real
tool_use blocks would need paired results or the next API call rejects the
dangling pair.
