---
"@poncho-ai/harness": patch
---

Fix tool execution blowing past serverless timeout and cross-skill script paths

- Race tool batch execution against remaining soft deadline so parallel tools can't push past the hard platform timeout
- Add post-tool-execution soft deadline checkpoint for tools that finish just past the deadline
- Allow skill scripts to reference sibling directories (e.g. ../scripts/current-date.ts)
- Catch script path normalization errors in approval check instead of crashing the run
