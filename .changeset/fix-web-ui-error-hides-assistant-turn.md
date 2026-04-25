---
"@poncho-ai/cli": patch
---

fix(web-ui): show assistant content alongside run errors

When a run ended with `run:error` (most visibly `MAX_STEPS_EXCEEDED`),
the web UI renderer replaced the entire assistant turn with just the
error banner. All the text and tool activity the agent had already
produced — which the server correctly persists — was hidden because
the render branch was `if (_error) { only error } else { content }`.

The renderer now renders the content first (sections, streaming tools
and text, pending approvals) and appends the error banner at the end.
The "waiting" spinner is also suppressed when an error is present.
