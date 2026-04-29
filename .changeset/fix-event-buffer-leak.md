---
"@poncho-ai/cli": patch
---

fix(cli): strip large payloads and cap size on the SSE replay buffer

The per-conversation event buffer in `broadcastEvent` only excluded
`browser:frame` events from being retained for replay. But `tool:completed`
events for `browser_screenshot` carry the full ~134KB base64 JPEG in
`output.screenshot.data`, and `step:completed` / large tool outputs can be
similarly heavy. Across a long browser-heavy session these accumulated in
`stream.buffer` until the dev server OOM'd at ~3.7-3.8 GB heap.

Two changes:

1. Before pushing into the replay buffer, deep-strip any string > 4 KB
   (replaced with `[stripped-for-replay len=N]`). Live SSE subscribers still
   get the full event in real-time; only the replay buffer (used when a
   client reconnects mid-conversation) holds the stripped copy. A
   reconnecting client that wants the full screenshot can refetch the
   conversation from disk.
2. Cap the buffer at the most recent 1000 events per conversation.
