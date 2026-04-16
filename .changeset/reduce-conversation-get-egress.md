---
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
---

perf: eliminate per-conversation archive egress on the hot read path

Three related fixes that together dramatically reduce database and
server→browser egress for any long-lived conversation:

- `conversationStore.get()` no longer loads the `tool_result_archive`
  column. Callers that actually need to reseed the harness archive —
  run entry points, cron runs, reminder firings — must now use the new
  `conversationStore.getWithArchive()` method instead.
- The `GET /api/conversations/:id` response strips `_toolResultArchive`
  alongside the already-stripped `_continuationMessages` and
  `_harnessMessages`, so the browser never receives the archive payload.
- Adds a cheap `GET /api/conversations/:id/status` endpoint backed by a
  new `getStatusSnapshot()` method that reads only summary columns (no
  `data` blob). The web UI poll loops now hit this endpoint every 2s
  and only refetch the full conversation when `updatedAt`,
  `messageCount`, or the pending-approval counts actually change.

The SQL upsert was also updated to preserve `tool_result_archive` via
`COALESCE(excluded, conversations.tool_result_archive)` so that updates
on conversations loaded via the light `get()` do not clobber the
existing archive.
