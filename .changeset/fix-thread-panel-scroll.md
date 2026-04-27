---
"@poncho-ai/cli": patch
---

fix(web-ui): thread panel reply list now scrolls when history is long

The thread panel's `.thread-panel-messages` had `flex: 1; overflow-y: auto`
but no `min-height: 0`. In flex children the default `min-height: auto`
lets content size the item rather than letting it shrink, so the messages
area grew to fit all replies and never engaged its scrollbar.

Also caps the pinned-parent area at 30% of panel height with its own
scroll, so a very long anchor message can't squish the reply list out
of view.
