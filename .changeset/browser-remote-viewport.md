---
"@poncho-ai/browser": patch
---

Force the configured viewport on remote browsers (cloud provider / cdpUrl).
`launchOpts.viewport` is only honored when launching a local context, so a
Browserbase/Kernel/CDP session rendered at the provider's large default — the
page looked huge, content tiny, scrolling appeared broken, and tap coordinates
mismatched the frame after reconnect. After connecting, call
`setViewport(width, height)` so the page renders at the intended size and frames
+ input stay consistent.
