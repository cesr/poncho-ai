---
"@poncho-ai/harness": minor
---

Add built-in `poncho_docs` tool for on-demand documentation discovery

Agents in development mode can now call `poncho_docs` with a topic (`api`, `features`, `configuration`, `troubleshooting`) to load detailed framework documentation on demand. Docs are embedded at build time from `docs/*.md` at the repo root, keeping a single source of truth that stays in sync with releases.
