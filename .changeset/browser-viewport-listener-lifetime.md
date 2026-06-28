---
"@poncho-ai/browser": patch
---

Keep host viewport listeners alive across browser sessions. `onFrame` /
`onStatus` listeners were stored inside the per-conversation `ConversationTab`
object, so `closeTab` (and LRU eviction) deleted them along with the tab. When
an agent closed one browser and opened another in the same conversation, the
new tab had empty listener sets — the host's live-viewport subscription was
silently orphaned, so the second session's `browser:status` / frames never
reached the client until it reconnected (the "pill/sheet doesn't appear, or is
left over after close, until I navigate away and back" bug). Listeners now live
in session-level maps keyed by conversationId, independent of any tab's
lifetime; they persist until the host unsubscribes, and `emitStatus` delivers
the final `active:false` on close before the tab is removed.
