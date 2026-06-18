---
"@poncho-ai/harness": patch
---

`memory_main_edit` now treats an empty `old_str` as append: `new_str` is
appended to the end of memory (separated by a blank line when memory is
non-empty). This also handles the first-ever write into empty memory, so
`memory_main_edit` alone can bootstrap, add new facts, and edit existing
text — consumers that want to drop `memory_main_write` from the tool
surface no longer lose the ability to seed empty memory.

Both `memory_main_edit` and `memory_main_write` now return a minimal
`{ ok: true, bytes }` result instead of echoing the entire memory
document back as the tool result, which kept re-injecting the whole
document into the conversation on every targeted edit.
