---
"@poncho-ai/harness": minor
---

storage: scope the entry read-cutover to pendingSubagentResults only

The append-only read rebuild now overrides ONLY `pendingSubagentResults`
from the entry log — the single conversation field with a write race (a
subagent finishing mid-turn vs. the parent turn's whole-blob write). Each
result is a race-free INSERT (subagent_result entry) and consumption is a
callback_started entry, so reading it from entries means the parent
clobbering the blob copy is harmless — that's the clobber-race kill.

Message history (`messages` / `_harnessMessages`) is written solely by the
serialized turn finalize and is never raced, so it stays on the blob
(known-good; far simpler than faithfully rebuilding the LLM transcript
from entries, which the callback path did not capture correctly).
