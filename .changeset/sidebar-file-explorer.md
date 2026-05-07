---
"@poncho-ai/cli": minor
"@poncho-ai/client": minor
"@poncho-ai/sdk": minor
---

dev: add a Files mode to the sidebar with VFS browsing, preview, and uploads

The web UI sidebar now has a Chats / Files segmented control. Switching to
Files reveals a folder-tree view of the agent's VFS — the same storage the
agent reads and writes via `read_file`, `write_file`, and the virtualized
`bash` tool. Folders expand inline with the same caret/dropdown pattern as
the Cron jobs section. Clicking a file previews it in the main panel:

- Text / JSON / source code render as a wrapped `<pre>` (5 MB cap), with an Edit button for inline editing (last-write-wins via PUT).
- Images render inline.
- PDFs render in an embedded iframe.
- Audio and video render with native controls.
- Anything else shows a placeholder card with a Download button.

Files can be added directly from the UI: an Upload button (multi-file
picker), drag-and-drop onto the explorer or onto a specific folder row, and
a New folder button. Files and folders are deletable via a hover-X with a
two-step confirm. Conflicts prompt to overwrite. Four new HTTP routes back
this UI: `GET /api/vfs-list`, `PUT /api/vfs/{path}`, `DELETE /api/vfs/{path}`,
and `POST /api/vfs-mkdir`. URLs of the form `/f/{path}` deep-link to a file
preview; the chat composer is hidden while previewing a file.

The same routes are exposed on `AgentClient` for programmatic use:
`listDir`, `writeFile`, `deleteFile`, and `mkdir` (alongside the existing
`readFile`). New shared types `ApiVfsEntry`, `ApiVfsListResponse`, and
`ApiVfsWriteResponse` are exported from `@poncho-ai/sdk`.
