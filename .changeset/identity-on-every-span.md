---
"@poncho-ai/harness": patch
---

Stamp `session.id` / `user.id` on EVERY span, not just the invoke_agent
root. Observability backends resolve a span's identity from its own
attributes — Latitude's console session/conversation views key on the LLM
generation spans, so root-only attributes grouped the API-level trace but
left the console showing one session per turn and no user. The identity now
rides the OTel Context and an IdentityAttributeSpanProcessor injects it
into every descendant span (LLM steps, tool executions) at start.
