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

## Releasing packages to npm

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing.
CI handles everything — **never run `changeset version` or `pnpm release` locally**.

### Step 1: Add changesets during development

Create a `.changeset/*.md` file for each releasable change. You can write them
directly or use the interactive prompt:

```bash
pnpm changeset
```

Changeset files have this format:

```markdown
---
"@poncho-ai/harness": minor
"@poncho-ai/cli": minor
---

Short summary of what changed and why.
```

Commit changeset files alongside your code — they're part of the change, not a
separate step. Every feature/fix commit that touches a publishable package
should include a changeset.

### Step 2: Push to main

Push your commits (with changeset files) to `main`. The `Release` GitHub Action
triggers automatically and does one of two things:

- **Changeset files present** → CI runs `changeset version`, opens (or updates)
  a PR titled `chore: release packages` with version bumps and changelog entries.
- **No changeset files** → CI checks for unpublished versions and publishes them
  to npm, creates git tags, and GitHub Releases.

### Step 3: Merge the release PR

Review the `chore: release packages` PR — it contains the version bumps,
updated `CHANGELOG.md` files, and any dependency cascade bumps
(`updateInternalDependencies: "patch"` in changeset config).

Merge it. CI runs again, sees unpublished versions, and publishes everything.

### Step 4: Verify

```bash
gh run list --limit 1                    # Should be ✓ success
gh release list --limit 5                # Should show new releases
```

### What NOT to do

| Don't | Why |
|-------|-----|
| `pnpm changeset version` locally | CI does this in the release PR. Running it locally consumes changesets before CI sees them. |
| `pnpm release` locally | Publishes before CI can create GitHub Releases. CI then sees "already published" and skips. |
| Forget to include changeset files | Commits without changesets won't be released. CI only bumps versions for consumed changesets. |
| Forget dependency cascades | `changeset version` auto-bumps dependents. If you version locally by mistake, check `git status` for uncommitted bumps in other packages. |

### Checking for unreleased work

```bash
# Show unreleased commits per package
for pkg in sdk harness cli client browser messaging; do
  ver=$(grep '"version"' packages/$pkg/package.json | grep -o '[0-9.]*')
  echo "@poncho-ai/$pkg@$ver — $(git log --oneline "@poncho-ai/$pkg@$ver"..HEAD -- "packages/$pkg" | grep -vc "^.*chore:" ) unreleased"
done
```

All counts should be 0 after a release.

### Manual fallback (when CI is broken)

Only use this if the GitHub Action is failing for infra reasons:

```bash
pnpm changeset version   # Consume changesets, bump versions
git add -A && git commit -m "chore: release packages"
git push
pnpm release             # Build + publish to npm
git push --tags
# Then manually create GitHub Releases via `gh release create`
```

Requires either a granular npm token with 2FA bypass or manual OTP:
`pnpm -r publish --access public --otp YOUR_CODE`

## Personal Preferences

- After each change, run a local build to validate before handoff:
  - CLI-only changes: `pnpm --filter poncho build`
  - Cross-package/runtime changes: `pnpm --filter @poncho/sdk build && pnpm --filter @poncho/harness build && pnpm --filter poncho build`
- Changesets changelog generation uses `@changesets/changelog-github` with repo `cesr/poncho-ai`.
- Always ask for confirmation before deleting any file or folder.
- Never delete files or folders outside this repository under any circumstances.

## Local development with linked packages

To use your local build of the CLI globally:

```bash
# From the poncho-ai repo root
pnpm build
cd packages/cli && pnpm link --global
```

Now `poncho` commands use your local build:

```bash
poncho dev            # Uses local development version
```

To switch back to the npm-published version:

```bash
cd packages/cli && pnpm unlink --global
pnpm add -g @poncho-ai/cli   # Reinstall from npm
```

To switch back to local development:

```bash
cd packages/cli && pnpm link --global
```

## Guardrails

- Preserve backward compatibility for public CLI commands and HTTP API unless explicitly changing spec.
- Prefer additive changes over silent breaking changes.
- For breaking changes, document migration notes in `README.md` or `docs/`.

## Personal preferences

- Keep non-shared developer preferences in Cursor user-level settings/rules (outside this repository).
