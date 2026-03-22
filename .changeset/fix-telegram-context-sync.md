---
"@poncho-ai/cli": patch
---

Fix messaging conversation consistency for Telegram and other adapter-backed channels.

This serializes per-conversation messaging runs to avoid stale concurrent context, refreshes latest conversation history before each run, and normalizes internal assistant tool-call payloads in API conversation responses for cleaner Web UI rendering.
