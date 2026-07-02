---
"@poncho-ai/browser": patch
---

Add residential-proxy support for Browserbase sessions so IP-reputation walls
(Reddit, LinkedIn, Instagram, …) stop returning 403 "blocked by network
security". Datacenter IPs are blocked before any fingerprint check, so stealth
alone can't get past them.

- Known IP-blocking domains are proxied automatically (domain gate).
- `browser_open` gains a `proxy` param so the agent can retry any other site
  that blocked it through a residential IP.
- `BrowserConfig.proxies` sets the default mode for every session.

Because proxies are fixed at Browserbase-session creation (and Vercel's
agent-browser hardcodes the create body to `{ projectId }`), we create the
Browserbase session ourselves with `proxies: true` and connect agent-browser to
it via its `cdpUrl` path. Switching proxy mode mid-conversation recreates the
session; cookies/localStorage are persisted and restored across the recreate,
so login state survives.
