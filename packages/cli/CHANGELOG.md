# @poncho-ai/cli

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
