---
"@poncho-ai/cli": minor
---

cli: add `poncho build railway` deploy target

Scaffolds `Dockerfile`, `server.js`, and `railway.toml` for deploying a
poncho agent to Railway. The `railway.toml` pins the builder to
`dockerfile`, so Railway doesn't fall back to Nixpacks (which misreads
`pnpm-workspace.yaml` and missing lockfiles, then fails the build before
producing useful logs — a common gotcha when migrating from Vercel).
Also accepts `railway` as a `DeployTarget` in the onboarding flow and
documents the new target in the README and AGENT.md template.
