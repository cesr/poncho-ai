---
"@poncho-ai/harness": minor
---

Phase 3c read cutover: conversation reads rebuild from the append-only
`conversation_entries` log. Both engines' `get`/`getWithArchive` paths now
call `rebuildConversationFromEntries`, which overrides `_harnessMessages`
(via `buildLlmContext`), `messages` (via `buildDisplaySnapshot`, full
transcript), and `pendingSubagentResults` (via `getPendingSubagentResults`)
when the entry log is non-empty. Conversations that predate dual-write have
no entries and fall back to the mutable blob untouched — no migration
script needed. The rebuild is wrapped in try/catch and never throws on the
read path. A kill-switch (`PONCHO_READ_ENTRIES=0`) instantly reverts to
blob reads without a deploy. `_continuationMessages` and `pendingApprovals`
remain blob fields (not yet modeled as entries).
