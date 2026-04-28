---
"@poncho-ai/cli": patch
---

fix(web-ui): thread panel displays anchor message + replies, not full snapshot

Shows the anchor message you forked on, plus any replies — and that's it.
The earlier snapshot is still part of the thread's context server-side
(the agent sees the full prior conversation), but the panel only
displays what's relevant: the message you replied to, and what came
after.

Also fixes the underlying scroll bug: `.thread-panel-messages` had
`flex: 1; overflow-y: auto` but no `min-height: 0`. In flex children
the default `min-height: auto` lets the item grow to fit content, so
the messages area never shrank below its content size and the scrollbar
never engaged.
