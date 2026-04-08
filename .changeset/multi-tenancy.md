---
"@poncho-ai/sdk": minor
"@poncho-ai/harness": minor
"@poncho-ai/client": minor
"@poncho-ai/cli": minor
---

feat: add multi-tenancy with JWT-based tenant scoping

Deploy one agent, serve many tenants with fully isolated conversations, memory, reminders, and secrets. Tenancy activates automatically when a valid JWT is received — no config changes needed.

- **Auth**: `createTenantToken()` in client SDK, `poncho auth create-token` CLI, or any HS256 JWT library.
- **Isolation**: conversations, memory, reminders, and todos scoped per tenant.
- **Per-tenant secrets**: encrypted secret overrides for MCP auth tokens, manageable via CLI (`poncho secrets`), API, and web UI settings panel.
- **MCP**: per-tenant token resolution with deferred discovery for servers without a default env var.
- **Web UI**: `?token=` tenant access, settings cog for secret management, dark mode support.
- **Backward compatible**: existing single-user deployments work unchanged.
