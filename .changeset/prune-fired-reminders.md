---
"@poncho-ai/harness": patch
---

Fix stale fired reminders not being cleaned up: pruneStale now removes all fired reminders immediately and runs on list() in addition to create().
