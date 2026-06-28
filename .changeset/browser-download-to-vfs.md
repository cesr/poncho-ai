---
"@poncho-ai/browser": minor
"@poncho-ai/harness": patch
---

Add `browser_download` so the agent can save files from the browser into the
VFS. The tool fetches a file using the page's logged-in session (so it works
for files behind a login) and writes the bytes straight to the tenant's VFS via
`ToolContext.vfs` — never through the model. `url` defaults to the current page,
or pass a same-origin link's href. The fetch runs inside the page (`evaluate`),
so it works identically for local and remote/cloud browsers (bytes return over
CDP). Capped at 25 MB. The harness browser system prompt now documents it under
a "Saving files" section.
