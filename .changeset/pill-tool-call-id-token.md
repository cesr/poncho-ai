---
"@poncho-ai/harness": patch
---

Stamp the tool-call id onto completed-tool activity lines (`{tcid:<id>}`
appended after any human detail). Display clients can now join a tool pill to
its full input/output by id instead of by tool-name + position. The old
positional/name match misaligns whenever parallel tool calls in a turn
complete out of declaration order, and can never reach a subagent's
inner-tool results; id-joining fixes both. The token sits after the first
`(...)` detail group, so existing clients that only parse inside it are
unaffected, and it is stripped from model-visible interruption text via the
new `stripPillMetaTokens` export.
