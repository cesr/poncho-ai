---
"@poncho-ai/harness": minor
"@poncho-ai/sdk": minor
---

harness: device-dispatch mode for tools that execute on a connected client

Tools can now be marked `dispatch: "device"` on `loadedConfig.tools`. When
the model calls such a tool the dispatcher pauses the run, emits a new
`tool:device:required` event, and checkpoints with the new
`kind: "device"` discriminator on `pendingApprovals` — same plumbing as
the approval flow, different trigger and different resume payload.
Consumers (e.g. PonchOS for iOS device tools) drive the external
execution and feed the result back via `continueFromToolResult`.

Approval can be combined: `{access: "approval", dispatch: "device"}`
yields the approval card first, then on resume falls through to the
device-required event. The wire vocabulary for approvals
(`approvalId` etc.) is unchanged; the `pendingApprovals` column /
field name stays.

`ToolAccess` is broadened to accept both the legacy string `"approval"`
and the new `{access?, dispatch?}` object form. Existing configs keep
working unchanged.
