---
"@poncho-ai/harness": minor
"@poncho-ai/cli": patch
---

harness: extract `runConversationTurn` helper; refactor CLI to use it

Lifts the inline turn lifecycle from the CLI's
`POST /api/conversations/:id/messages` handler (~280 lines of orchestration)
into a new public helper at `@poncho-ai/harness`.

The helper handles the full conversation lifecycle for a primary chat
turn: load the conversation with archive, resolve canonical history,
upload files via the harness's upload store, build stable user/assistant
ids, persist the user message immediately, drive `executeConversationTurn`,
periodically persist the in-flight assistant draft on `step:completed`
and `tool:approval:required`, persist on `tool:approval:checkpoint` and
`run:completed` continuation, rebuild history on `compaction:completed`,
apply turn metadata on success, and persist partial state on
cancel/error.

Caller responsibilities (auth, active-run dedup, streaming, continuation
HTTP self-fetch, title inference) stay outside the helper — passed in
via opts or handled around the call. `opts.onEvent` is invoked for every
`AgentEvent` for downstream forwarding (SSE, WebSocket, telemetry, etc.).

The CLI's handler now delegates to `runConversationTurn` (drops from
~430 to ~150 lines). Consumers like PonchOS can call the same helper
to ship the *exact* same conversation lifecycle without duplicating
the orchestration.

Public API additions:
- `runConversationTurn(opts): Promise<RunConversationTurnResult>`
- `RunConversationTurnOpts`
- `RunConversationTurnResult`

No behavior changes. The helper is a verbatim extraction of the CLI's
prior inline implementation.
