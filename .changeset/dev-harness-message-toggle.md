---
"@poncho-ai/cli": patch
---

dev: add a `user ↔ harness` message toggle to the web UI in verbose mode

When `poncho dev` is run with `-v`, the web UI now shows a small `user`
toggle button in the topbar. Clicking it switches the message area
between the user-facing rendering and a raw view of `_harnessMessages` —
the actual message stream sent to the model API, with role,
runId/step/id metadata, and pretty-printed JSON content. Useful for
debugging context construction, tool-call shape, and what the model
actually sees turn-by-turn. Hidden entirely outside `-v` mode.
