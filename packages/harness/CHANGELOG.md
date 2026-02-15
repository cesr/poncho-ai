# @poncho-ai/harness

## 0.5.0

### Minor Changes

- d6256b2: Migrate to Vercel AI SDK for unified model provider support

  This major refactoring replaces separate OpenAI and Anthropic client implementations with Vercel AI SDK's unified interface, simplifying the codebase by ~1,265 lines and enabling easier addition of new model providers.

  **Key improvements:**
  - Unified model provider interface via Vercel AI SDK
  - JSON Schema to Zod converter for tool definitions
  - Fixed tool call preservation in multi-step agent loops
  - Simplified architecture with better maintainability
  - Added comprehensive error handling for step execution

  **Breaking changes (internal API only):**
  - `ModelClient` interface removed (use Vercel AI SDK directly)
  - `OpenAiModelClient` and `AnthropicModelClient` classes removed
  - `createModelClient()` replaced with `createModelProvider()`

  **User-facing API unchanged:**
  - AGENT.md format unchanged
  - Tool definitions unchanged (JSON Schema still works)
  - Model provider names unchanged (`openai`, `anthropic`)
  - Agent behavior unchanged from user perspective

## 0.4.1

### Patch Changes

- Fix MCP tool prefix to use `mcp:` instead of `@mcp:` for YAML compatibility. The `@` character is reserved in YAML and cannot start plain values without quoting.

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

## 0.3.1

### Patch Changes

- Split agent template and development context

  Move development-specific guidance from AGENT.md template into runtime-injected development context. Production agents now receive a cleaner prompt focused on task execution, while development agents get additional context about customization and setup.

## 0.3.0

### Minor Changes

- Implement tool policy and declarative intent system

  Add comprehensive tool policy framework for MCP and script tools with pattern matching, environment-based configuration, and declarative tool intent in AGENT.md and SKILL.md frontmatter.

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
