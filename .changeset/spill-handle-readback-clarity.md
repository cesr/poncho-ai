---
"@poncho-ai/harness": patch
---

Tighten the oversized-tool-result spill read-back path (follow-up to the
spill guard):

- The spill handle now exposes `toolResultId` / `toolCallId` explicitly, so
  the model passes the right id to `get_tool_result_by_id` instead of guessing
  from the path stem.
- `get_tool_result_by_id` now redirects when it hits a spill envelope: it
  returns `{ spilled: true, path, totalChars }` pointing at the VFS file rather
  than silently paging the ~6k-char envelope (which read as "I've got
  everything"). The file is the source of truth; read it with bash.
- The handle's `note` is now format-aware: JSONL spills keep the line tools
  (`sed`/`grep`/`jq` per line), but pretty-JSON spills steer to byte-offset
  reads and `jq -r` to unescape — `wc -l`/`grep` mislead on JSON whose string
  fields carry escaped newlines on one line.
