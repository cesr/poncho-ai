---
"@poncho-ai/harness": minor
---

harness: add `read_subagent` tool for fetching subagent transcripts

Parent agents can now read a spawned subagent's conversation directly
instead of using `message_subagent` to ask it to repeat its work. The
new tool accepts a `mode` parameter — `"final"` (last assistant message,
default), `"assistant"` (assistant messages only), or `"full"` (every
message including tool calls and results) — plus optional `since_index`
and `max_messages` for paging long transcripts.

Access is restricted to direct children: a parent can only read
transcripts of subagents whose `parentConversationId` matches its own
conversation. The `SubagentManager` interface gains a corresponding
`getTranscript` method.
