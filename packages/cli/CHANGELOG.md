# @poncho-ai/cli

## 0.13.1

### Patch Changes

- [`9e87d28`](https://github.com/cesr/poncho-ai/commit/9e87d2801ba7b8d4c8b0650563d59e9cad530ff6) Thanks [@cesr](https://github.com/cesr)! - Fix Latitude telemetry not exporting traces
  - Reuse a single `LatitudeTelemetry` instance across runs instead of creating one per run (avoids OpenTelemetry global registration conflicts)
  - Use `disableBatch` mode so spans export immediately instead of being silently lost on a 5s timer
  - Warn at startup when `telemetry.latitude` is configured with missing or misnamed fields (e.g. `apiKeyEnv` instead of `apiKey`)
  - Sanitize agent name for Latitude's path validation
  - Surface OTLP export errors in console output

- Updated dependencies [[`9e87d28`](https://github.com/cesr/poncho-ai/commit/9e87d2801ba7b8d4c8b0650563d59e9cad530ff6)]:
  - @poncho-ai/harness@0.13.2

## 0.13.0

### Minor Changes

- [#10](https://github.com/cesr/poncho-ai/pull/10) [`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218) Thanks [@cesr](https://github.com/cesr)! - Add generic messaging layer with Slack as the first adapter. Agents can now respond to @mentions in Slack by adding `messaging: [{ platform: 'slack' }]` to `poncho.config.js`. Includes signature verification, threaded conversations, processing indicators, and Vercel `waitUntil` support.

### Patch Changes

- Updated dependencies [[`d5bce7b`](https://github.com/cesr/poncho-ai/commit/d5bce7be5890c657bea915eb0926feb6de66b218)]:
  - @poncho-ai/messaging@0.2.0
  - @poncho-ai/harness@0.13.1
  - @poncho-ai/sdk@1.0.1

## 0.12.0

### Minor Changes

- [#8](https://github.com/cesr/poncho-ai/pull/8) [`658bc54`](https://github.com/cesr/poncho-ai/commit/658bc54d391cb0b58aa678a2b86cd617eebdd8aa) Thanks [@cesr](https://github.com/cesr)! - Add cron job support for scheduled agent tasks. Define recurring jobs in AGENT.md frontmatter with schedule, task, and optional timezone. Includes in-process scheduler for local dev with hot-reload, HTTP endpoint for Vercel/serverless with self-continuation, Vercel scaffold generation with drift detection, and full tool activity tracking in cron conversations.

### Patch Changes

- Updated dependencies [[`658bc54`](https://github.com/cesr/poncho-ai/commit/658bc54d391cb0b58aa678a2b86cd617eebdd8aa)]:
  - @poncho-ai/harness@0.13.0

## 0.11.1

### Patch Changes

- [`0d943e5`](https://github.com/cesr/poncho-ai/commit/0d943e5b709acfe7c390bc84f1f0d10299fcc56e) Thanks [@cesr](https://github.com/cesr)! - Support paste-to-attach: pasting images or files from the clipboard into the web UI input box now adds them as attachments.

## 0.11.0

### Minor Changes

- [`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3) Thanks [@cesr](https://github.com/cesr)! - Add multimodal file support for agents — images, PDFs, and text files can be uploaded via the web UI, HTTP API, and terminal CLI. Includes pluggable upload storage (local, Vercel Blob, S3), write-behind caching, build-time dependency injection, and graceful handling of unsupported formats.

### Patch Changes

- Updated dependencies [[`035e8b3`](https://github.com/cesr/poncho-ai/commit/035e8b300ac4de6e7cbc4e2ab6bd06cdfd0e1ae3)]:
  - @poncho-ai/sdk@1.0.0
  - @poncho-ai/harness@0.12.0

## 0.10.2

### Patch Changes

- [`3dcb914`](https://github.com/cesr/poncho-ai/commit/3dcb914acd22c403ff5372d94a0fc2152a2574b3) Thanks [@cesr](https://github.com/cesr)! - Fix scaffolded dependency versions during `poncho init` so npm installs no longer request unavailable `^0.1.0` packages.

  Improve runtime resilience by retrying transient provider/model failures, returning clearer provider error codes, and sanitizing malformed conversation history so interrupted/bad-state chats can continue.

- Updated dependencies [[`3dcb914`](https://github.com/cesr/poncho-ai/commit/3dcb914acd22c403ff5372d94a0fc2152a2574b3)]:
  - @poncho-ai/harness@0.11.2

## 0.10.1

### Patch Changes

- Updated dependencies [[`8a3937e`](https://github.com/cesr/poncho-ai/commit/8a3937e95bfb7f269e8fe46dd41640eacb30af43)]:
  - @poncho-ai/harness@0.11.1

## 0.10.0

### Minor Changes

- [`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72) Thanks [@cesr](https://github.com/cesr)! - Add cooperative run cancellation: stop active runs via Ctrl+C (CLI), stop button (Web UI), or the /stop API endpoint. Partial output is preserved and empty assistant messages are skipped to prevent conversation corruption.

### Patch Changes

- [`a95290e`](https://github.com/cesr/poncho-ai/commit/a95290e1bde10aa1dd2f668a5bcdb5201891552e) Thanks [@cesr](https://github.com/cesr)! - Render the interactive CLI mascot with high-fidelity truecolor terminal art and move mascot data into a dedicated module for maintainability.

- [`e61f479`](https://github.com/cesr/poncho-ai/commit/e61f479a839cf52db9b1a24d05d4eea637b0f4c5) Thanks [@cesr](https://github.com/cesr)! - Docs: highlight serverless-first positioning and clarify deployed agents run as stateless endpoints.

- [`a95290e`](https://github.com/cesr/poncho-ai/commit/a95290e1bde10aa1dd2f668a5bcdb5201891552e) Thanks [@cesr](https://github.com/cesr)! - Truncate long conversation titles in CLI /list output

- Updated dependencies [[`a1df23f`](https://github.com/cesr/poncho-ai/commit/a1df23f339d815c30948ebcd275209366a3d2a72)]:
  - @poncho-ai/sdk@0.6.0
  - @poncho-ai/harness@0.11.0

## 0.9.4

### Patch Changes

- Reduce serverless warnings when loading TypeScript skill scripts.

  The harness now uses `jiti` first for `.ts/.mts/.cts` scripts in `run_skill_script`, avoiding Node's native ESM warning spam for TypeScript files in deployed environments.

- Updated dependencies []:
  - @poncho-ai/harness@0.10.3

## 0.9.3

### Patch Changes

- Improve runtime loading of `poncho.config.js` in serverless environments.

  The harness now falls back to `jiti` when native ESM import of `poncho.config.js` fails, allowing deploys where bundlers/runtime packaging treat project `.js` files as CommonJS. The CLI patch picks up the updated harness runtime.

- Updated dependencies []:
  - @poncho-ai/harness@0.10.2

## 0.9.2

### Patch Changes

- Fix Vercel tracing of `marked` by statically importing it in generated `api/index.mjs`.

  This ensures `marked` is included in serverless bundles when using pnpm and avoids runtime `Cannot find module 'marked'` errors in Vercel deployments.

## 0.9.1

### Patch Changes

- Fix Vercel runtime packaging for Markdown rendering in deployed agents.

  When scaffolding Vercel deploy files, ensure `marked` is added as a direct project dependency and include the `marked.umd.js` file from pnpm's store path in `vercel.json` `includeFiles` so runtime resolution works in serverless builds.

## 0.9.0

### Minor Changes

- Improve deployment scaffolding and init onboarding for production targets.

  The CLI now scaffolds deployment files directly in project roots (including Vercel `api/index.mjs` + `vercel.json`), adds safer overwrite behavior with `--force`, and normalizes runtime dependencies for deployable projects. Onboarding now captures `deploy.target` so new projects can scaffold the selected platform during `poncho init`.

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@0.5.0
  - @poncho-ai/harness@0.10.1

## 0.8.3

### Patch Changes

- Bundle fetch-page skill with init template

## 0.6.0

### Minor Changes

- Persist pending approvals on conversation state and add SSE reconnect endpoint so Web UI approvals survive page refresh and stream responses in real-time.

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.7.1

## 0.5.1

### Patch Changes

- Simplify MCP tool patterns and improve auth UI
  - Allow tool patterns without server prefix in poncho.config.js (e.g., `include: ['*']` instead of `include: ['linear/*']`)
  - Fix auth screen button styling to be fully rounded with centered arrow
  - Add self-extension capabilities section to development mode instructions
  - Update documentation to clarify MCP pattern formats

- Updated dependencies []:
  - @poncho-ai/harness@0.7.0

## 0.5.0

### Minor Changes

- Add markdown table support and fix Latitude telemetry integration
  - Add markdown table rendering with `marked` library in web UI
  - Add table styling with horizontal scroll and hover effects
  - Add margins to HR elements for better spacing
  - Integrate Latitude telemetry with Vercel AI SDK using event queue pattern
  - Enable real-time streaming while capturing complete traces
  - Fix telemetry to show all messages and interactions in Latitude dashboard

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.6.0

## 0.4.2

### Patch Changes

- Updated dependencies [d6256b2]
  - @poncho-ai/harness@0.5.0

## 0.4.1

### Patch Changes

- Fix MCP tool prefix to use `mcp:` instead of `@mcp:` for YAML compatibility. The `@` character is reserved in YAML and cannot start plain values without quoting.

- Updated dependencies []:
  - @poncho-ai/harness@0.4.1

## 0.4.0

### Minor Changes

- BREAKING: Switch to AgentSkills allowed-tools format with mcp/ prefix

  Replace nested `tools: { mcp: [...], scripts: [...] }` with flat `allowed-tools: [...]` list format. MCP tools now require `mcp/` prefix (e.g., `mcp/github/list_issues`).

  Migration: Update AGENT.md and SKILL.md frontmatter from:

  ```yaml
  tools:
    mcp:
      - github/list_issues
  ```

  To:

  ```yaml
  allowed-tools:
    - mcp/github/list_issues
  ```

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.4.0

## 0.3.2

### Patch Changes

- Fix environment detection in production deployments

  Agents deployed to Vercel, Railway, Render, AWS Lambda, and Fly.io now correctly detect their environment automatically without requiring manual NODE_ENV configuration. The resolved environment is now properly passed to the AgentHarness constructor.

## 0.3.1

### Patch Changes

- Split agent template and development context

  Move development-specific guidance from AGENT.md template into runtime-injected development context. Production agents now receive a cleaner prompt focused on task execution, while development agents get additional context about customization and setup.

- Updated dependencies []:
  - @poncho-ai/harness@0.3.1

## 0.3.0

### Minor Changes

- Implement tool policy and declarative intent system

  Add comprehensive tool policy framework for MCP and script tools with pattern matching, environment-based configuration, and declarative tool intent in AGENT.md and SKILL.md frontmatter.

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/harness@0.3.0

## 0.2.0

### Minor Changes

- Initial release of Poncho - an open framework for building and deploying AI agents.
  - `@poncho-ai/sdk`: Core types and utilities for building Poncho skills
  - `@poncho-ai/harness`: Agent execution runtime with conversation loop, tool dispatch, and streaming
  - `@poncho-ai/client`: TypeScript client for calling deployed Poncho agents
  - `@poncho-ai/cli`: CLI for building and deploying AI agents

### Patch Changes

- Updated dependencies []:
  - @poncho-ai/sdk@0.2.0
  - @poncho-ai/harness@0.2.0
