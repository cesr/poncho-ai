# AGENTS.md

Repository-level context for AI agents working on `poncho`.

## What this repository is

- Monorepo for Poncho (framework for building/deploying tool-using agents).
- Package manager: `pnpm` (workspace + turbo).
- Runtime baseline: Node `>=20`.

## Workspace layout

- `packages/cli`: CLI entry points, local dev server, build commands.
- `packages/harness`: Core runtime (conversation loop, tools, storage, telemetry, providers).
- `packages/sdk`: Shared types and tool contracts.
- `packages/client`: TypeScript client for deployed Poncho agents.
- `docs/`: Product and implementation specs (`SPEC.md`, `SPEC_WEB_UI.md`, `SPEC_MVP_TRACKER.md`).
- `README.md`: User-facing source of truth for setup, commands, and behavior.

## Typical commands

- Install deps: `pnpm install`
- Build all packages: `pnpm build`
- Run all tests: `pnpm test`
- Run lint across workspaces: `pnpm lint`
- Dev mode (watch tasks): `pnpm dev`

When possible, run package-scoped checks for faster feedback:

- `pnpm --filter @poncho-ai/cli test` (CLI package)
- `pnpm --filter @poncho-ai/harness test`
- `pnpm --filter @poncho-ai/sdk test`
- `pnpm --filter @poncho-ai/client test`

## Code conventions in this repo

- Language: TypeScript ESM (`module`/`moduleResolution`: `NodeNext`).
- Prefer strict typing; avoid `any` unless unavoidable and localized.
- Keep changes minimal and package-local unless cross-package updates are required.
- Do not introduce generated artifacts (`dist/`, coverage outputs) in commits.
- Keep docs in sync when behavior/CLI/API changes (`README.md` and relevant files in `docs/`).
- Keep the scaffolded init README in sync with product behavior by updating `README_TEMPLATE` in `packages/cli/src/index.ts` whenever setup, CLI/API usage, or feature guidance changes.

## Agent workflow expectations

1. Identify touched package(s) first.
2. Make focused edits in the smallest meaningful surface area.
3. Validate with targeted tests, then broader tests if needed.
4. If CLI behavior or config contract changes, update docs in the same change.
5. When API/features change, update both the repo `README.md` and the generated init README template (`packages/cli/src/index.ts`) in the same change.

## High-impact files to inspect before major edits

- `README.md`
- `packages/cli/src/index.ts`
- `packages/cli/src/web-ui.ts`
- `docs/SPEC.md`
- `docs/SPEC_WEB_UI.md`
- `docs/SPEC_MVP_TRACKER.md`

## Guardrails

- Preserve backward compatibility for public CLI commands and HTTP API unless explicitly changing spec.
- Prefer additive changes over silent breaking changes.
- For breaking changes, document migration notes in `README.md` or `docs/`.

## Personal preferences

- Keep non-shared developer preferences in Cursor user-level settings/rules (outside this repository).
