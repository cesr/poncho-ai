---
"@poncho-ai/browser": minor
---

Add `browser_click_text` and `browser_execute_js` tools for interacting with elements that don't appear in the accessibility snapshot (e.g. styled divs acting as buttons). Also force new-tab navigations (`window.open`, `target="_blank"`) to stay in the current tab so agents don't lose context.
