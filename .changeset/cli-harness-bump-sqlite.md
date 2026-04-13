---
"@poncho-ai/cli": patch
---

fix: surface a loud stderr warning when the CLI falls back to in-memory conversation storage (i.e. when `harness.storageEngine` is undefined). Previously this path was silent — agents appeared to work but nothing persisted to disk, no DB file was created, and the new bash tool was absent, all with zero log output. Also triggers a patch republish so the CLI tarball is re-pinned to the current workspace harness.
