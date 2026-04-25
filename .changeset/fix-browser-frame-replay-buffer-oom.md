---
"@poncho-ai/cli": patch
---

fix: stop buffering `browser:frame` events for SSE replay

Every `browser:frame` carries a base64 screenshot (~100 KB) and they
stream at 10+ fps. `broadcastEvent` was pushing them into the
per-conversation replay buffer (`ConversationEventStream.buffer`)
alongside real conversation events. In a long interactive browser
session this grew to multiple GB (observed: ~51k frames ≈ 4.4 GB of
retained base64 strings) and eventually crashed the dev server with
`FATAL ERROR: Reached heap limit - JavaScript heap out of memory`
inside V8's `JsonStringify`.

Frames are now excluded from the replay buffer — they still reach
live SSE subscribers, they just don't accumulate for late joiners,
matching the existing treatment of `browser:status`.
