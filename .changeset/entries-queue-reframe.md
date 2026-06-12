---
"@poncho-ai/harness": patch
---

Reframe `conversation_entries` as the subagent delivery queue and delete the
abandoned transcript dual-write. The entry log now carries exactly two types
— `subagent_result` (race-free delivery of a finished subagent's result) and
`callback_started` (consumption marker) — which is the one conversation
field with concurrent writers. The unread transcript entry types
(user/assistant/harness messages, compaction overlays), their dual-write
call sites, and the parity checker were groundwork for a full blob
replacement that was deliberately abandoned after the 0.58.0 cutover
incident; they were already unfaithful for callback turns and are deleted
rather than maintained as drift-prone dead weight. Read paths now filter the
queue types explicitly, so legacy transcript rows are ignored. Also fixes
`conversations.rename` to update the title inside the `data` blob (via an
atomic in-database JSON set) — the 0.59.2 column-only update didn't surface
on reads, which parse the blob.
