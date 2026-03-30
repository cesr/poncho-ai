---
"@poncho-ai/messaging": minor
---

feat: include thread context when Slack bot is @mentioned in a thread reply

When the bot is @mentioned in a thread (not the parent message), the adapter now fetches prior thread messages via `conversations.replies` and prepends them as context, so the agent understands what the conversation is about.
