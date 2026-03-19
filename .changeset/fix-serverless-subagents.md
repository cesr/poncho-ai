---
"@poncho-ai/cli": patch
"@poncho-ai/harness": patch
---

Fix serverless subagent and continuation reliability

- Use stable internal secret across serverless instances for callback auth
- Wrap continuation self-fetches in waitUntil to survive function shutdown
- Set runStatus during callback re-runs so clients detect active processing
- Add post-streaming soft deadline check to catch long model responses
- Client auto-recovers from abrupt stream termination and orphaned continuations
- Fix callback continuation losing _continuationMessages when no pending results
