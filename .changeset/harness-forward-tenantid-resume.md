---
"@poncho-ai/harness": patch
---

harness: forward `tenantId` through `continueFromToolResult`. Resumed runs (after an approval checkpoint) ran tools with `ctx.tenantId` undefined, so tenant-scoped stores (memory, VFS, todos) resolved the default `"__default__"` tenant instead of the caller's — surfacing as `memory_main_get` returning empty after an approval resume.
