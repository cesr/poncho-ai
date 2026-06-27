---
"@poncho-ai/browser": patch
---

Dispatch wheel/scroll events with no pressed button. `injectScroll` went through
`injectMouse`, which defaults the button to `"left"`, so a `mouseWheel` was sent
*with the left button* — Chrome treated scrolling as a left-button drag and could
leave the button stuck "down", after which clicks stopped registering. Send
`button: "none"` for wheel events.
