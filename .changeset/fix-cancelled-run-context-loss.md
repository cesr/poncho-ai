---
"@poncho-ai/sdk": patch
"@poncho-ai/harness": patch
"@poncho-ai/cli": patch
---

fix: persist harness messages on cancelled runs so the agent doesn't lose context

When a run was cancelled (Stop button, abort signal), `conversation.messages`
was updated with the partial assistant turn but `conversation._harnessMessages`
— the canonical history `loadCanonicalHistory` hands to the model on the next
turn — was left holding a snapshot from the *previous* successful run. The
agent had no memory of the cancelled work, even though the user-facing UI
still showed it. The new verbose-mode harness toggle made this divergence
directly visible.

The fix plumbs an in-flight `messages` snapshot through the `run:cancelled`
event, trims it to a model-valid prefix (no orphan `tool_use`), and persists
it as `_harnessMessages` on every cancel path in the CLI.
