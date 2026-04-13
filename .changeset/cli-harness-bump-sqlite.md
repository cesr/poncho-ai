---
"@poncho-ai/cli": patch
---

fix: republish CLI against harness 0.37.x so pnpm installs resolve to the SQLite-capable harness. Previously `pnpm up @poncho-ai/cli@latest` could leave users with an older harness (pre-0.37.0) that lacks the storage engine, causing the CLI to silently fall back to in-memory conversation storage (no DB file, no persistence, no bash tool). Also adds a clear warning to stderr when `harness.storageEngine` is undefined so this failure mode is no longer silent.
