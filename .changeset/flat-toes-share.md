---
"@poncho-ai/cli": patch
"@poncho-ai/harness": patch
"@poncho-ai/sdk": patch
---

Improve callback-run reliability and streaming across subagent workflows, including safer concurrent approval handling and parent callback retriggers.

Add context window/token reporting through run completion events, improve cron/web UI rendering and approval streaming behavior, and harden built-in web search retry/throttle behavior.
