---
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
---

Unified tool access configuration and web UI streaming for messaging conversations

- New `tools` config in `poncho.config.js`: control any tool with `true` (available), `false` (disabled), or `'approval'` (requires human approval). Per-environment overrides via `byEnvironment`. Works for harness, adapter, MCP, and skill tools.
- Messaging conversations (email via Resend) now stream events to the web UI: live tool progress, approval prompts, and text chunks display in real time.
- Clicking a conversation with an active run in the web UI sidebar auto-attaches to the event stream.
- Fix conversation persistence race condition in messaging runner (stale-write clobber).
- Fix duplicated last section in persisted conversations.
