---
"@poncho-ai/sdk": patch
"@poncho-ai/harness": patch
"@poncho-ai/client": patch
"@poncho-ai/messaging": patch
"@poncho-ai/cli": patch
---

Durable approval checkpoints, email conversation improvements, and web UI fixes

- Simplify approval system to checkpoint-only (remove legacy blocking approvalHandler)
- Optimize checkpoint storage with delta messages instead of full history
- Add sidebar sections for conversations awaiting approval with status indicator
- Fix nested checkpoint missing baseMessageCount in resumeRunFromCheckpoint
- Improve email conversation titles (sender email + subject)
- Remove email threading — each incoming email creates its own conversation
- Fix streaming after approval to preserve existing messages (liveOnly mode)
- Preserve newlines in user messages in web UI
