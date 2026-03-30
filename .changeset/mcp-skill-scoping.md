---
"@poncho-ai/harness": minor
---

fix: scope MCP tools to skills via server-level claiming

MCP tools from configured servers are now globally available by default. When a skill claims any tool from a server via `allowed-tools`, the entire server becomes skill-managed — its tools are only available when the claiming skill is active (or declared in AGENT.md `allowed-tools`).
