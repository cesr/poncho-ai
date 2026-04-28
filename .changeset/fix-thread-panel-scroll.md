---
"@poncho-ai/cli": patch
---

fix(web-ui): thread panel renders snapshot + replies as one scrolling list

Drops the pinned-parent area and renders the full thread conversation
(the snapshot from the parent up to the anchor, plus the replies) as a
single continuous list inside the panel. Scrolling now feels natural —
the user can scroll up to read prior context the same way they would in
the main conversation.

Also fixes the underlying scroll bug: `.thread-panel-messages` had
`flex: 1; overflow-y: auto` but no `min-height: 0`. In flex children the
default `min-height: auto` lets the item grow to fit content, so the
messages area never shrank below its content size and the scrollbar
never engaged.
