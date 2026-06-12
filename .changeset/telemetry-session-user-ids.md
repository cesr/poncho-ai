---
"@poncho-ai/harness": patch
---

Root trace spans now carry `session.id` (= conversationId) and `user.id`
(new `config.telemetry.userId`) alongside the existing
`gen_ai.conversation.id` — the attributes observability backends
(Latitude) key session grouping and user filtering on.
