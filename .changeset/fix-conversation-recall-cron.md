---
"@poncho-ai/cli": patch
"@poncho-ai/harness": patch
---

fix(cli, harness): unify turn-parameter assembly so `conversation_recall` works everywhere

The recall tool relies on three context parameters (`__conversationRecallCorpus`,
`__conversationListFn`, `__conversationFetchFn`) that were only injected for
user-initiated HTTP turns. Cron, reminder, messaging-adapter, chat-continuation,
subagent-callback, and tool-approval-resume runs all built their own
`runInput.parameters` object and silently omitted these — causing
`conversation_recall` to throw "not available in this environment" or return
empty results depending on the call mode.

Introduces a single `buildTurnParameters(conversation, opts)` helper in the CLI
that owns context-parameter assembly (recall functions, `__activeConversationId`,
`__ownerId`, messaging metadata, tool-result archive). HTTP, messaging, and
cron/reminder paths now go through it. The harness orchestrator's three
internal turn sites (chat continuation, subagent-callback resume, tool-approval
resume) now call the existing `hooks.buildRecallParams` so they pick up the
recall functions too.
