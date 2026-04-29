---
"@poncho-ai/harness": patch
---

fix(harness): cap `_toolResultArchive` size per conversation, FIFO-evict oldest

Heap-snapshot evidence from a 3.7 GB OOM showed 147,448 retained strings,
including 8 exact duplicates (~239 KB each) of the same browser-extracted
page text. The browser screenshot/snapshot skip-list from a prior fix
didn't help because page-text/web-extract tools still archived their
full payloads in `_toolResultArchive`, with no eviction across the
session.

Add a per-conversation archive byte cap (default 25 MB, configurable via
`PONCHO_TOOL_ARCHIVE_MAX_MB`). When a new archive write would push the
total over the cap, evict oldest entries (by `createdAt`) until we're
back under. Tool-name-agnostic, so it bounds memory regardless of which
tool returned the large payload.
