---
"@poncho-ai/browser": patch
---

Steer the agent to use `browser_open` only as a last resort. The description now
tells it to prefer `web_fetch` for reading pages and a dedicated API/MCP
integration when one exists, and to reach for the browser only when those can't
do the job — a page web_fetch can't render, or operating a site/web app that has
no API and no MCP (e.g. logging in and clicking through a UI). Reinforces that
credentials are entered by the user in the live view, never asked for in chat.
